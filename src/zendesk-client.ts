import type {
	ArticleCreatePayload,
	ArticleTranslationUpdatePayload,
	ArticleUpdatePayload,
	AutomationCreatePayload,
	AutomationUpdatePayload,
	GroupCreatePayload,
	GroupUpdatePayload,
	MacroCreatePayload,
	MacroUpdatePayload,
	OrganizationCreatePayload,
	OrganizationUpdatePayload,
	TicketCreatePayload,
	TicketUpdatePayload,
	TriggerCreatePayload,
	TriggerUpdatePayload,
	UserCreatePayload,
	UserUpdatePayload,
	ViewCreatePayload,
	ViewUpdatePayload,
} from './types/zendesk'

interface ZendeskClientConfig {
	subdomain?: string
	email?: string
	apiToken?: string
}

/**
 * The slice of the Worker environment this client reads. Naming it keeps a typo like
 * ZENDESK_SUBDOMIAN a compile error rather than an empty string that only surfaces as a
 * failed API call, and lets tests pass credentials without a whole Env.
 */
type ZendeskEnv = Pick<Env, 'ZENDESK_SUBDOMAIN' | 'ZENDESK_EMAIL' | 'ZENDESK_API_TOKEN'>

/**
 * What `request` throws. `status` is the HTTP status when the server answered and undefined
 * when it did not, which is the distinction the retry policy turns on: a status means Zendesk
 * replied and said no, no status means the request never completed.
 *
 * It exists so that the status survives being turned into a sentence. `request` builds its
 * message out of the response body, and the classifier used to search that message for '429'
 * and friends — which cannot tell a status from the same three digits quoted in a body.
 *
 * `retryAfterMs` is there for the same reason and carries the same kind of fact: something
 * the response said that the message would otherwise throw away. It holds what `Retry-After`
 * asked for, and is undefined when the response did not ask for anything usable.
 */
export class ZendeskRequestError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		readonly retryAfterMs?: number,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'ZendeskRequestError'
	}
}

/**
 * How long `Retry-After` asked us to wait, in milliseconds, or undefined if it said nothing
 * usable.
 *
 * The header is defined as either a whole number of seconds or an HTTP date. Zendesk sends
 * seconds, and both are read anyway — the date form costs four lines, and implementing half
 * a header without saying so is a worse thing to leave behind than the four lines.
 */
function parseRetryAfter(header: string | null): number | undefined {
	if (!header) {
		return undefined
	}

	const value = header.trim()
	let wait: number

	if (/^\d+$/.test(value)) {
		// The numeric form is a whole number of seconds. Matched with a regex rather than
		// passed to Number(), which would also read '1e3' and '0x10' as a count of seconds.
		wait = Number(value) * 1000
	} else {
		// Otherwise an HTTP date. `Date.parse` is far looser here than it looks — it reads
		// '-5' as May 2001 and '120' as the year 120 — so it cannot be relied on to reject
		// nonsense. What makes that safe is the check below, not a tighter pattern up here.
		const when = Date.parse(value)
		if (Number.isNaN(when)) {
			return undefined
		}
		wait = when - Date.now()
	}

	// Only a wait in the future is usable. A header resolving to zero or to the past tells us
	// nothing about how long to hold off, and reading it as "retry now" would be the single
	// worst answer available: asking again immediately against a quota already exhausted.
	// Falling back to the caller's own backoff is safer, and is what an absent header does.
	return wait > 0 ? wait : undefined
}

/**
 * Builds the error for a failure that a response is already in hand for.
 *
 * The status is what the retry policy classifies on, and an error missing one means something
 * specific to it: the request went out and nothing came back, so send it again. Every failure
 * raised once a response has arrived therefore has to carry the status it arrived with, or a
 * refusal Zendesk stated plainly gets retried on the strength of a body we could not read.
 *
 * That held before this existed, but only because three separate sites each remembered to pass
 * the same two things. Four instances of forgetting turned up while #29, #31 and #32 were being
 * written, every one found by accident rather than by looking, and the last of them survived
 * three rounds of review aimed at this exact mistake. Taking the `Response` rather than the two
 * values read off it is what makes the omission unavailable: there is no argument to leave out.
 *
 * `Retry-After` is read here for every caller, including the ones whose status can never be
 * retried. Uniform is worth more than precise — the header is meaningless on a 3xx and on the
 * 200 whose body would not parse, and reading it costs nothing, where letting each site decide
 * is how one of them came to omit it for no reason it could state.
 *
 * The rewrap in the outer catch is deliberately not built through this. It describes whatever it
 * caught rather than a response, and it has no `Response` to hand — carrying the status forward
 * when there is one is exactly its job.
 */
function errorFromResponse(response: Response, message: string, cause?: unknown) {
	return new ZendeskRequestError(
		message,
		response.status,
		parseRetryAfter(response.headers.get('retry-after')),
		cause !== undefined ? { cause } : undefined
	)
}

/**
 * Statuses where Zendesk is asking to be called back rather than refusing the request.
 *
 * 408 is in because it means the request timed out on their side and is worth sending again.
 *
 * 500 is out, for the opposite reason: it is a fault that will fail the same way on a second
 * attempt. 502, 503 and 504 mean the request never reached a healthy backend at all.
 *
 * This set is what a read may retry. A write answers to the narrower one below.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504])

/**
 * The subset a write may retry: the refusals that cannot have acted on the request.
 *
 * A rate limit is Zendesk declining to start the work, and a 408 is Zendesk giving up before
 * the request had finished arriving. Neither can have created a ticket, so sending one again is
 * exactly as safe as sending a `GET` again.
 *
 * The other three are excluded because they are ambiguous rather than because they are severe,
 * which is the distinction worth keeping hold of. A 504 means a gateway stopped waiting for a
 * backend that may well have gone on to finish the work. These endpoints take no idempotency
 * key, so nothing here can tell that from a backend that never got it, and asking again makes
 * the second ticket. The client cannot make an ambiguous retry safe; it can only decline it.
 *
 * Do not read this as a severity ranking and add 500 to the read set to match — 500 is out of
 * both for a different reason, that it will fail the same way next time.
 */
const RETRYABLE_STATUSES_FOR_WRITES = new Set([408, 429])

/** How long a single `request` waits for an answer when nothing narrower bounds it. */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * How long a whole `requestWithRetry` call gets — every attempt and every backoff together.
 *
 * Set to the same figure as one attempt, which keeps the worst case exactly where it already
 * was: a caller never waits longer than it does today. Before #24 that was also the real
 * worst case, because a timed-out request was never retried; #24 fixed the classifier and
 * the arithmetic followed it to three attempts and two backoffs, about 93 seconds. That is
 * longer than most clients will wait, so the likely outcome was the caller giving up first
 * and the remaining attempts running for nobody.
 *
 * What this buys is that retries stop costing wall-clock time the caller can feel. The case
 * they exist for still works: a 503 answered in 200ms gets all three attempts inside four
 * seconds. What they no longer do is stack full-length timeouts — a genuinely hung endpoint
 * spends the budget on its first attempt and fails at 30 seconds, which is what it did
 * before retrying timeouts was possible at all.
 */
const TOTAL_TIMEOUT_MS = 30_000

/**
 * The smallest window worth starting an attempt in.
 *
 * Without it, "does another attempt fit" is answered after the fact: the loop sleeps through
 * its backoff, starts a request with 40 milliseconds left, and that request is aborted on
 * arrival. A second is a low bar, and clearing it is not a promise the attempt will finish —
 * only that it was not doomed before it was sent.
 */
const MINIMUM_ATTEMPT_MS = 1_000

/**
 * How many attempts a retried call gets in total.
 *
 * A constant rather than a parameter because it is a tuning decision like the three above it,
 * and nothing has ever wanted a different number — it sat in `requestWithRetry`'s signature
 * for long enough to collide with `request`'s `timeoutMs`, which is #55.
 *
 * It is the backstop for failures that arrive instantly, and only for those. Once an attempt
 * takes real time the deadline decides and this never binds. Removing it would not simplify
 * as much as it looks: instant failures still sleep the backoff ladder, so the deadline alone
 * would permit about eight of them rather than three, and a hard-down Zendesk would be asked
 * eight times per call instead of three.
 */
const MAX_ATTEMPTS = 3

/**
 * The window a retry may land in after a `Retry-After` wait — somewhere in the second past
 * the moment Zendesk named, and never a millisecond before it. Asking earlier than agreed
 * spends more of a quota already exhausted, so the spread only ever adds.
 *
 * One second because the header speaks in whole seconds: every caller refused together is
 * told the same figure, so a spread as wide as the granularity is what separates them
 * completely. Flat rather than scaled to the wait, because a wider window buys no more
 * separation and eats more of a deadline the wait itself already dominates.
 */
const RETRY_AFTER_SPREAD_MS = 1_000

/**
 * Yields an error and then each `cause` beneath it. `request` rewraps whatever it caught, so
 * the failure worth classifying is usually a link or two down rather than in hand — and fetch
 * itself nests, reporting a socket error as the cause of a bare "fetch failed".
 *
 * The depth cap is only there so a self-referential chain cannot hang the retry loop.
 */
function* causeChain(error: unknown, maxDepth = 10): Generator<Error> {
	let current = error
	for (let depth = 0; depth < maxDepth && current instanceof Error; depth += 1) {
		yield current
		current = current.cause
	}
}

/**
 * The wait Zendesk asked for, if any link in the chain carries one. Walks it for the same
 * reason the classifier does: `request` rewraps, so the answer sits a link or two down.
 */
function retryAfterFrom(error: unknown): number | undefined {
	for (const link of causeChain(error)) {
		if (link instanceof ZendeskRequestError && link.retryAfterMs !== undefined) {
			return link.retryAfterMs
		}
	}
	return undefined
}

/**
 * What to say about a redirect this client declined to follow.
 *
 * The two cases have different causes and different fixes, so they get different sentences.
 * A hop to another host is what a renamed subdomain looks like, and it is the one the
 * platform would have stripped the credential from. A redirect that stays on the same host
 * would have been safe to follow, so saying that keeps an unexpected one from reading as
 * the credential problem it is not.
 *
 * Re-attaching the credential and following on is deliberately not an option here. That
 * would mean deciding the new host is trustworthy, which is the judgement the platform
 * default exists to stop `fetch` making on its own.
 */
function describeRedirect(response: Response, requestUrl: URL): string {
	const location = response.headers.get('location')
	if (!location) {
		return 'redirected without naming a destination, and redirects are not followed.'
	}

	let target: URL
	try {
		target = new URL(location, requestUrl)
	} catch {
		return `redirected to "${location}", which is not a URL. Redirects are not followed.`
	}

	if (target.host !== requestUrl.host) {
		return (
			`redirected to ${target.host}. Redirects are not followed, because the Authorization ` +
			`header does not survive a hop to another host. If the Zendesk subdomain has moved, ` +
			`update ZENDESK_SUBDOMAIN.`
		)
	}

	return `redirected to ${target.pathname} on the same host, and redirects are not followed.`
}

export class ZendeskClient {
	private subdomain: string
	private email: string
	private apiToken: string

	constructor(config?: ZendeskClientConfig, env?: ZendeskEnv) {
		this.subdomain = config?.subdomain || env?.ZENDESK_SUBDOMAIN || ''
		this.email = config?.email || env?.ZENDESK_EMAIL || ''
		this.apiToken = config?.apiToken || env?.ZENDESK_API_TOKEN || ''

		if (this.subdomain) {
			this.subdomain = this.sanitizeSubdomain(this.subdomain)
		}

		// Nothing warns about a missing credential here. `request` throws on one before it sends
		// anything, and that throw reaches the caller where a log line never does. A warning at
		// this point would also fire on every tool call, since #40 made the server stateless and
		// a fresh client is built per request.
	}

	/** The subdomain reaches a hostname, so anything outside `[a-zA-Z0-9-_]` is dropped. */
	private sanitizeSubdomain(subdomain: string): string {
		const sanitized = subdomain.replace(/[^a-zA-Z0-9-_]/g, '')
		if (sanitized !== subdomain) {
			console.warn(`Subdomain was sanitized from "${subdomain}" to "${sanitized}"`)
		}
		return sanitized
	}

	// There is no endpoint sanitizer here, and its absence is a decision rather than a gap.
	//
	// Nothing could reach one. Every endpoint in this file is either a fixed literal like
	// `/tickets.json` or a template holding an id that `validateId` has already proved to be a
	// positive integer, and no tool handler passes an endpoint at all. Do not add one back on
	// the strength of the 0.1.0 changelog listing the old one under "Security": that listing is
	// the part that did real damage, because a control nobody can reach still costs every reader
	// of this request path the time it takes to work out that it defends nothing.
	//
	// What would change that is an endpoint whose shape a caller decides — a tool taking a path
	// fragment, or a method interpolating a string where an id goes today. The answer then is
	// to keep the caller's value out of the path, by validating it into something known or
	// sending it as a query parameter, rather than to reinstate a filter that has to guess what
	// will be tried against it.
	//
	// The place a model-supplied string does become syntax is elsewhere, and is still open:
	// every `search_*` tool concatenates free text into a Zendesk search expression —
	// `type:ticket ${query}` in src/tools/tickets.ts, and the same pattern in users.ts,
	// organizations.ts and help-center.ts — so a query of `foo type:user` changes what is being
	// searched. That is left alone knowingly, because it crosses no privilege boundary: one
	// shared service account, reads only. It is named here because it is where to look if you
	// arrived expecting the sanitizers to be the protection.

	private validateId(id: number): number {
		if (!Number.isInteger(id) || id <= 0) {
			throw new Error(`Invalid ID: ${id}. ID must be a positive integer.`)
		}
		return id
	}

	private getBaseUrl(): string {
		return `https://${this.subdomain}.zendesk.com/api/v2`
	}

	private getAuthHeader(): string {
		const credentials = `${this.email}/token:${this.apiToken}`
		const encoded = btoa(credentials)
		return `Basic ${encoded}`
	}

	async request(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>,
		{ timeoutMs = DEFAULT_TIMEOUT_MS }: { timeoutMs?: number } = {}
	): Promise<unknown> {
		// Everything down to the `try` sits outside it on purpose, and where the try starts is
		// the point rather than a detail of layout. The catch rewraps whatever it sees as a
		// ZendeskRequestError, and one of those carrying no status is how the retry policy
		// recognises a request that went out and got nothing back — which is worth sending
		// again. None of the preparation here is that, and several parts of it can throw: a
		// missing credential below, `btoa` on a token pasted with a smart quote (it rejects
		// anything outside Latin-1), `JSON.stringify` on a body it cannot serialize. Leaving as
		// plain Errors is what stops those being retried: the classifier finds no
		// ZendeskRequestError in the chain and gives up on the first attempt. Moved inside the
		// try, each would instead be sent twice more and fail identically both times, for three
		// seconds of backoff and nothing else.
		if (!this.subdomain || !this.email || !this.apiToken) {
			throw new Error('Zendesk credentials not configured. Please set environment variables.')
		}

		// The endpoint goes out exactly as the calling method wrote it. The note above
		// `validateId` says why nothing rewrites it, and what would have to change for that
		// to stop being safe.
		const url = new URL(`${this.getBaseUrl()}${endpoint}`)

		if (params) {
			Object.entries(params).forEach(([key, value]) => {
				if (value !== undefined && value !== null) {
					url.searchParams.append(key, String(value))
				}
			})
		}

		const headers: Record<string, string> = {
			Authorization: this.getAuthHeader(),
			'Content-Type': 'application/json',
			Accept: 'application/json',
		}

		const body =
			method !== 'GET' && data !== null && data !== undefined ? JSON.stringify(data) : undefined

		// Create AbortController for timeout (compatible with all Workers versions).
		// `timeoutMs` is whatever the caller has left rather than a fresh 30 seconds, so a
		// retried attempt cannot extend the total past the deadline that governs the call.
		// Armed last, after everything above that can throw, so a failure while preparing the
		// request cannot leave a live timer behind holding the isolate awake.
		const abortController = new AbortController()
		const timeoutId = setTimeout(() => abortController.abort(), timeoutMs)

		const requestInit: RequestInit = {
			method,
			headers,
			// Redirects are not followed, because following one across origins silently
			// loses the credential above. `strip_authorization_on_cross_origin_redirect`
			// has been the platform default since 2025-09-01 and the compatibility date
			// now sits past it, so the follow-up request goes out unauthenticated and
			// Zendesk answers 401 — indistinguishable from a revoked API token, with
			// nothing in the message pointing at a redirect. Confirmed against workerd
			// rather than inferred: a hop to another host arrives with no Authorization
			// header at all. Failing here instead says where the request was being sent.
			redirect: 'manual',
			signal: abortController.signal,
		}
		if (body !== undefined) {
			requestInit.body = body
		}

		try {
			const response = await fetch(url.toString(), requestInit)

			// A 3xx reaches this branch rather than being followed. It has to be caught
			// before the check below, which would otherwise report it as a bare status
			// with an empty body and say nothing about where the request was headed.
			if (response.status >= 300 && response.status < 400) {
				throw errorFromResponse(
					response,
					`Zendesk API Error: ${response.status} - ${describeRedirect(response, url)}`
				)
			}

			if (!response.ok) {
				// Reading the body is allowed to fail without taking the status down with it.
				// A body arrives as a stream, so `text()` can reject after the headers are in
				// hand — and letting that propagate would hand the outer catch a plain Error,
				// which it rewraps carrying no status. The classifier reads a statusless error
				// as a request that never got an answer, so a flatly refused 400 would be sent
				// twice more on the strength of a body we could not read. The status is the
				// part that decides, and it is already known here.
				let errorText: string
				try {
					errorText = await response.text()
				} catch {
					errorText = '<the body could not be read>'
				}

				throw errorFromResponse(response, `Zendesk API Error: ${response.status} - ${errorText}`)
			}

			// A success without a JSON content type has no body worth parsing. An empty DELETE
			// is the case that matters, since it answers with no content type at all.
			const contentType = response.headers.get('content-type')
			if (contentType && contentType.includes('application/json')) {
				try {
					return await response.json()
				} catch (cause) {
					// Carrying the status matters more than it looks. Zendesk answered, so
					// this is not a request that failed to complete — and without a status
					// the retry policy would read it as exactly that and ask again, re-sending
					// something that already arrived on the strength of a body we could not
					// parse. 200 is not in the retryable set, so it fails once and says why.
					throw errorFromResponse(
						response,
						`Zendesk answered ${response.status} with a body that is not valid JSON`,
						cause
					)
				}
			} else {
				return { success: true }
			}
		} catch (error) {
			// Re-throw with more context, preserving original error chain for debugging.
			// What the response told us is carried onto the new error rather than left behind
			// in the message, so a caller holding what request threw can read it without
			// walking `cause`.
			if (error instanceof Error) {
				const answered = error instanceof ZendeskRequestError ? error : undefined
				throw new ZendeskRequestError(
					`Zendesk request failed: ${error.message}`,
					answered?.status,
					answered?.retryAfterMs,
					{ cause: error }
				)
			}
			throw error
		} finally {
			// One place rather than two. The timer used to be cleared on the line after `await
			// fetch` as well, which covered every path that got an answer but not the one where
			// fetch rejects outright — the path requestWithRetry walks up to three times a call.
			clearTimeout(timeoutId)
		}
	}

	/**
	 * Classification reads the status and nothing else, and never the message text. The
	 * message is built out of the Zendesk response body, so matching on it cannot tell a 502
	 * that happened from a 502 the body merely quotes.
	 *
	 * The rule asks two questions in order: did this come from `request` at all, and if so did
	 * Zendesk answer it. A ZendeskRequestError means a request was actually sent, and a status
	 * on it means an answer came back.
	 *
	 * What no status means depends on the verb, and this is the sharp edge of the whole rule. It
	 * says the request went out and nothing came back — so for a read, where asking again costs
	 * only time, it is worth sending again whatever the underlying cause was. For a write it is
	 * the worst case there is rather than a mild one: not only might the work have happened, we
	 * never learned whether it did. That is strictly less knowledge than a 504 carries, and a
	 * 504 is already excluded below, so retrying this while refusing that would make no sense.
	 *
	 * Which is why `retryable` is chosen by the caller's verb and the statusless case is not
	 * shared. Reads keep the behaviour they have always had; a write retries the two refusals
	 * that cannot have acted, and nothing else.
	 *
	 * Written that way because the previous version matched specifics that do not exist on the
	 * runtime this deploys to. It looked for a `code` of ECONNRESET and friends, which is a
	 * Node convention — true of undici under Vitest, false of workerd. Probed against the real
	 * runtime before this was changed: an unreachable port gives a plain `Error` reading
	 * "Network connection lost." with no `code` at all, and a host that will not resolve gives
	 * "internal error; reference = <opaque id>". There is no name, code or wording worth keying
	 * on, and asking whether a response arrived makes the rule independent of all three.
	 */
	private isRetryableError(error: unknown, method: string): boolean {
		if (!(error instanceof Error)) {
			return false
		}

		const isWrite = method !== 'GET'

		for (const link of causeChain(error)) {
			if (link instanceof ZendeskRequestError) {
				// A status means Zendesk answered. Retry only the ones that mean "ask again";
				// anything else it refused will be refused just as firmly on a second attempt.
				if (link.status !== undefined) {
					const retryable = isWrite ? RETRYABLE_STATUSES_FOR_WRITES : RETRYABLE_STATUSES
					return retryable.has(link.status)
				}

				// The request went out and nothing came back. A read asks again; a write cannot,
				// because this is the case where whether the work happened is unknowable.
				return !isWrite
			}
		}

		// Nothing in the chain came from `request`, so no request was ever made. A missing
		// credential or a malformed id fails here, and will fail identically next time.
		return false
	}

	/**
	 * One deadline governs the call. Attempts fit inside it rather than each starting a fresh
	 * timeout, because what a caller cares about is how long until it hears back, not how long
	 * any individual attempt was allowed to run. `MAX_ATTEMPTS` bounds the loop for failures
	 * that arrive instantly, and never binds once an attempt takes real time.
	 */
	async requestWithRetry(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>
	): Promise<unknown> {
		const deadline = Date.now() + TOTAL_TIMEOUT_MS
		let lastError: Error | undefined

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			try {
				return await this.request(method, endpoint, data, params, {
					timeoutMs: deadline - Date.now(),
				})
			} catch (error) {
				lastError = error as Error

				if (attempt === MAX_ATTEMPTS - 1 || !this.isRetryableError(error, method)) {
					throw error
				}

				// Exponential backoff — 1s, 2s, 4s, capped at 5s — spread across the lower half
				// of each step so that callers who failed together do not come back together.
				//
				// The spread matters because every GET retries, so requests that failed together
				// come back together. On a fixed ladder they all sleep exactly 1000ms and arrive
				// in one burst, which is the shape that turns a recovering backend into a
				// still-failing one.
				//
				// Do not size this against the fan-out of any one tool. `get_help_center_hierarchy`
				// is the tempting one and it is bounded to five reads in flight, and to forty
				// across a whole call, so it cannot be what this window is for. What matters is
				// that separate callers hitting one struggling Zendesk all wake on the same tick.
				//
				// Half the step rather than the whole of it, so the spread cannot undo the
				// backoff: the first retry lands somewhere in 500-1000ms, never at 20ms.
				const ladder = Math.min(1000 * Math.pow(2, attempt), 5000)
				const backoff = Math.round(ladder / 2 + Math.random() * (ladder / 2))

				// A rate limit says how long to wait, and asking again sooner is worse than not
				// asking at all: the early retry spends more of a quota already exhausted, and
				// providers commonly extend the penalty for a caller that keeps knocking. The
				// ladder is the fallback for the responses that say nothing.
				//
				// Which is why the spread is added after the requested wait rather than around
				// it. Jitter spreads a number this client chose, and `Retry-After` is not that —
				// spreading around it would have half the callers asking earlier than Zendesk
				// agreed to. But a 429 window resets at one moment for everyone it refused, so
				// callers told the same figure all come back on the same tick, and a synchronised
				// burst arriving exactly at the reset is itself a way of keeping knocking. The
				// spread breaks that burst up without ever moving anyone earlier.
				const requested = retryAfterFrom(error)
				const delay =
					requested === undefined
						? backoff
						: requested + Math.round(Math.random() * RETRY_AFTER_SPREAD_MS)

				// Decide whether the next attempt fits before sleeping, rather than sleeping and
				// then discovering it does not. Waiting out a backoff only to send a request the
				// deadline aborts on arrival wastes the one thing the caller is short of.
				//
				// This is also the only cap on `Retry-After`, and the right one. Asked to wait
				// 60 seconds inside a 30 second budget, the honest answer is to stop and say so,
				// not to clamp the wait down to something Zendesk did not agree to.
				if (Date.now() + delay + MINIMUM_ATTEMPT_MS > deadline) {
					console.warn(
						`Request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}) and the ${TOTAL_TIMEOUT_MS}ms deadline leaves no room to wait ${delay}ms and retry`,
						{
							error: error instanceof Error ? error.message : String(error),
							retryAfterMs: requested,
							method,
							endpoint,
						}
					)
					throw error
				}

				console.warn(
					`Request failed (attempt ${attempt + 1}/${MAX_ATTEMPTS}), retrying in ${delay}ms...`,
					{
						error: error instanceof Error ? error.message : String(error),
						method,
						endpoint,
					}
				)

				// Wait before retrying
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
		}

		throw lastError
	}

	/**
	 * What every method below calls. Reads the verb and picks the retry policy from it, so that
	 * an API method says what request it wants and never how many times to send it.
	 *
	 * Everything goes through `requestWithRetry` now, and the verb decides what may be retried
	 * rather than whether anything is. Routing a write down a separate path was how the old
	 * blunter rule was expressed, and keeping it would have meant expressing the new one twice.
	 *
	 * A GET changes nothing, so sending it again costs only time — and since #32 the time is
	 * bounded anyway, because one deadline covers every attempt and every backoff together.
	 * That makes retrying a read close to free, and a read retries on everything in
	 * `RETRYABLE_STATUSES`, plus on getting no answer at all.
	 *
	 * A write is the case that has to be argued rather than assumed, and it retries only the
	 * two refusals that cannot have acted on it — see `RETRYABLE_STATUSES_FOR_WRITES`, which
	 * carries that argument. Everything else it does exactly once, including the case where no
	 * answer came back, because Zendesk takes no idempotency key on these endpoints and a
	 * second attempt at a create that had already succeeded makes the second ticket.
	 *
	 * The dispatch existing at all is the point, and is what #54 was really about. Before it,
	 * each method chose between `request` and `requestWithRetry` for itself, and five had
	 * chosen to retry against fifty-odd that had not — `getTicket` surviving a 503 where
	 * `getMacro` gave up on it, though they are the same verb against the same API. They read
	 * as the methods that had caused visible trouble at some point and had retrying added to
	 * them one at a time. A policy nobody at the call site can express is what stops that
	 * reassembling; `which methods retry` in the tests is what catches a method going around
	 * this one to reach `request` directly.
	 */
	private async send(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>
	): Promise<unknown> {
		return this.requestWithRetry(method, endpoint, data, params)
	}

	// === TICKETS API ===
	async listTickets(params?: Record<string, unknown>) {
		return this.send('GET', '/tickets.json', null, params)
	}

	async getTicket(id: number) {
		this.validateId(id)
		return this.send('GET', `/tickets/${id}.json`)
	}

	async createTicket(data: TicketCreatePayload) {
		return this.send('POST', '/tickets.json', { ticket: data })
	}

	async updateTicket(id: number, data: TicketUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/tickets/${id}.json`, { ticket: data })
	}

	async deleteTicket(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/tickets/${id}.json`)
	}

	// === USERS API ===

	/**
	 * The user the configured credentials authenticate as. `support_info` is built on this
	 * because it is the smallest call that exercises the subdomain, the email and the token
	 * together — any of the three being wrong or missing fails here rather than being reported
	 * as healthy. It also answers the question that gets asked when something is misconfigured,
	 * which is not whether a request works but which identity the server is using.
	 */
	async getCurrentUser() {
		return this.send('GET', '/users/me.json')
	}

	async listUsers(params?: Record<string, unknown>) {
		return this.send('GET', '/users.json', null, params)
	}

	async getUser(id: number) {
		this.validateId(id)
		return this.send('GET', `/users/${id}.json`)
	}

	async createUser(data: UserCreatePayload) {
		return this.send('POST', '/users.json', { user: data })
	}

	async updateUser(id: number, data: UserUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/users/${id}.json`, { user: data })
	}

	async deleteUser(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/users/${id}.json`)
	}

	// === ORGANIZATIONS API ===
	async listOrganizations(params?: Record<string, unknown>) {
		return this.send('GET', '/organizations.json', null, params)
	}

	async getOrganization(id: number) {
		this.validateId(id)
		return this.send('GET', `/organizations/${id}.json`)
	}

	async createOrganization(data: OrganizationCreatePayload) {
		return this.send('POST', '/organizations.json', { organization: data })
	}

	async updateOrganization(id: number, data: OrganizationUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/organizations/${id}.json`, { organization: data })
	}

	async deleteOrganization(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/organizations/${id}.json`)
	}

	// === GROUPS API ===
	async listGroups(params?: Record<string, unknown>) {
		return this.send('GET', '/groups.json', null, params)
	}

	async getGroup(id: number) {
		this.validateId(id)
		return this.send('GET', `/groups/${id}.json`)
	}

	async createGroup(data: GroupCreatePayload) {
		return this.send('POST', '/groups.json', { group: data })
	}

	async updateGroup(id: number, data: GroupUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/groups/${id}.json`, { group: data })
	}

	async deleteGroup(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/groups/${id}.json`)
	}

	// === MACROS API ===
	async listMacros(params?: Record<string, unknown>) {
		return this.send('GET', '/macros.json', null, params)
	}

	async getMacro(id: number) {
		this.validateId(id)
		return this.send('GET', `/macros/${id}.json`)
	}

	/**
	 * Every create and update payload on this client is typed like these two: derived from the
	 * tool's own Zod schema in types/zendesk.ts, so what a caller may send is whatever MCP
	 * already validated, and neither shape is written a second time against Zendesk's docs.
	 */
	async createMacro(data: MacroCreatePayload) {
		return this.send('POST', '/macros.json', { macro: data })
	}

	async updateMacro(id: number, data: MacroUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/macros/${id}.json`, { macro: data })
	}

	async deleteMacro(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/macros/${id}.json`)
	}

	// === VIEWS API ===
	async listViews(params?: Record<string, unknown>) {
		return this.send('GET', '/views.json', null, params)
	}

	async getView(id: number) {
		this.validateId(id)
		return this.send('GET', `/views/${id}.json`)
	}

	async createView(data: ViewCreatePayload) {
		return this.send('POST', '/views.json', { view: data })
	}

	async updateView(id: number, data: ViewUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/views/${id}.json`, { view: data })
	}

	async deleteView(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/views/${id}.json`)
	}

	// === TRIGGERS API ===
	async listTriggers(params?: Record<string, unknown>) {
		return this.send('GET', '/triggers.json', null, params)
	}

	async getTrigger(id: number) {
		this.validateId(id)
		return this.send('GET', `/triggers/${id}.json`)
	}

	async createTrigger(data: TriggerCreatePayload) {
		return this.send('POST', '/triggers.json', { trigger: data })
	}

	async updateTrigger(id: number, data: TriggerUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/triggers/${id}.json`, { trigger: data })
	}

	async deleteTrigger(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/triggers/${id}.json`)
	}

	// === AUTOMATIONS API ===
	async listAutomations(params?: Record<string, unknown>) {
		return this.send('GET', '/automations.json', null, params)
	}

	async getAutomation(id: number) {
		this.validateId(id)
		return this.send('GET', `/automations/${id}.json`)
	}

	async createAutomation(data: AutomationCreatePayload) {
		return this.send('POST', '/automations.json', { automation: data })
	}

	async updateAutomation(id: number, data: AutomationUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/automations/${id}.json`, { automation: data })
	}

	async deleteAutomation(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/automations/${id}.json`)
	}

	// === SEARCH API ===
	async search(query: string, params: Record<string, unknown> = {}) {
		return this.send('GET', '/search.json', null, { query, ...params })
	}

	// === HELP CENTER API ===
	async listArticles(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/articles.json', null, params)
	}

	async getArticle(id: number) {
		this.validateId(id)
		return this.send('GET', `/help_center/articles/${id}.json`)
	}

	async createArticle(data: ArticleCreatePayload, sectionId: number) {
		this.validateId(sectionId)
		return this.send('POST', `/help_center/sections/${sectionId}/articles.json`, {
			article: data,
		})
	}

	async updateArticle(id: number, data: ArticleUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/help_center/articles/${id}.json`, { article: data })
	}

	// Where an article's content actually changes: the article endpoint above applies metadata
	// only and silently ignores `title` and `body`. This is also the endpoint that publishes,
	// which is why the payload type refuses `draft` — see ArticleTranslationUpdatePayload.
	async updateArticleTranslation(
		id: number,
		locale: string,
		data: ArticleTranslationUpdatePayload
	) {
		this.validateId(id)
		return this.send(
			'PUT',
			`/help_center/articles/${id}/translations/${encodeURIComponent(locale)}.json`,
			{ translation: data }
		)
	}

	async deleteArticle(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/help_center/articles/${id}.json`)
	}

	async searchArticles(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/articles/search.json', null, params)
	}

	// Categories
	async listCategories(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/categories.json', null, params)
	}

	async getCategory(id: number) {
		this.validateId(id)
		return this.send('GET', `/help_center/categories/${id}.json`)
	}

	// Nothing here creates, updates or deletes a category or a section. Six commented-out
	// methods used to say so under a "DISABLED FOR SECURITY" label, which read as though the
	// comment were the control; the ceilings gating registration in src/utils/tool-registry.ts
	// are.

	// Sections
	async listSections(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/sections.json', null, params)
	}

	async getSection(id: number) {
		this.validateId(id)
		return this.send('GET', `/help_center/sections/${id}.json`)
	}

	async listSectionsByCategory(categoryId: number, params?: Record<string, unknown>) {
		this.validateId(categoryId)
		return this.send('GET', `/help_center/categories/${categoryId}/sections.json`, null, params)
	}

	async listArticlesBySection(sectionId: number, params?: Record<string, unknown>) {
		this.validateId(sectionId)
		return this.send('GET', `/help_center/sections/${sectionId}/articles.json`, null, params)
	}

	// === TALK API ===
	async getTalkStats() {
		return this.send('GET', '/channels/voice/stats.json')
	}

	// === CHAT API ===
	// No query parameters, because Chat reads none of the ones this client knows how to send.
	// It is a separate product API with its own pagination scheme, so the shape it does take
	// has to be established against the live API rather than assumed from the Support ones —
	// #67 carries that. Taking a `params` nothing could usefully fill was the same inert
	// argument the tool was advertising, one layer down.
	async listChats() {
		return this.send('GET', '/chats.json')
	}
}
