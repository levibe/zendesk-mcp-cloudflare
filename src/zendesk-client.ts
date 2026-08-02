/**
 * Centralized Zendesk API client with authentication and request handling
 * Compatible with Cloudflare Workers environment
 * Provides methods for all major Zendesk API endpoints across Support, Talk, Chat, and Guide
 */

import type { MacroCreatePayload, MacroUpdatePayload } from './types/zendesk'

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
 * Statuses where Zendesk is asking to be called back rather than refusing the request.
 *
 * 408 is in because it means the request timed out on their side and is worth sending again.
 * The old classifier retried it only when the body happened to contain the word "timeout",
 * so an empty-bodied 408 was dropped — the inconsistency is the bug, not the retry.
 *
 * 500 is out, for the opposite reason: it is a fault that will fail the same way on a second
 * attempt. 502, 503 and 504 mean the request never reached a healthy backend at all.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504])

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
		// Load Zendesk credentials from config, environment, or Cloudflare Workers env
		this.subdomain = config?.subdomain || env?.ZENDESK_SUBDOMAIN || ''
		this.email = config?.email || env?.ZENDESK_EMAIL || ''
		this.apiToken = config?.apiToken || env?.ZENDESK_API_TOKEN || ''

		// Validate and sanitize subdomain to prevent injection
		if (this.subdomain) {
			this.subdomain = this.sanitizeSubdomain(this.subdomain)
		}

		// Warn if credentials are missing (but allow instantiation for testing)
		if (!this.subdomain || !this.email || !this.apiToken) {
			console.warn(
				'Zendesk credentials not found. Please set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, and ZENDESK_API_TOKEN.'
			)
		}
	}

	/**
	 * Sanitize subdomain to prevent injection attacks
	 * Only allows alphanumeric characters, hyphens, and underscores
	 */
	private sanitizeSubdomain(subdomain: string): string {
		const sanitized = subdomain.replace(/[^a-zA-Z0-9-_]/g, '')
		if (sanitized !== subdomain) {
			console.warn(`Subdomain was sanitized from "${subdomain}" to "${sanitized}"`)
		}
		return sanitized
	}

	/**
	 * Validate and sanitize endpoint path to prevent path traversal
	 */
	private sanitizeEndpoint(endpoint: string): string {
		// Remove any attempts at path traversal
		const sanitized = endpoint.replace(/\.\./g, '').replace(/\/\//g, '/')
		// Ensure endpoint starts with /
		return sanitized.startsWith('/') ? sanitized : `/${sanitized}`
	}

	/**
	 * Validate numeric IDs to prevent injection
	 */
	private validateId(id: number): number {
		if (!Number.isInteger(id) || id <= 0) {
			throw new Error(`Invalid ID: ${id}. ID must be a positive integer.`)
		}
		return id
	}

	// Construct the base URL for Zendesk API v2 endpoints
	private getBaseUrl(): string {
		return `https://${this.subdomain}.zendesk.com/api/v2`
	}

	// Generate Basic Authentication header using email/token format
	private getAuthHeader(): string {
		// Use Web API btoa instead of Node.js Buffer
		const credentials = `${this.email}/token:${this.apiToken}`
		const encoded = btoa(credentials)
		return `Basic ${encoded}`
	}

	/**
	 * Core HTTP request method with authentication and error handling
	 * Uses fetch API compatible with Cloudflare Workers
	 */
	async request(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>,
		timeoutMs = DEFAULT_TIMEOUT_MS
	): Promise<unknown> {
		// Above the try on purpose. Everything inside it is rewrapped as a ZendeskRequestError,
		// and one of those carrying no status is how the retry policy recognises a request that
		// never got an answer — which is worth sending again. A missing credential is not that.
		// It will be just as missing on the third attempt, so leaving this inside would buy
		// three seconds of backoff and the identical failure.
		if (!this.subdomain || !this.email || !this.apiToken) {
			throw new Error('Zendesk credentials not configured. Please set environment variables.')
		}

		// Preparing the request happens outside the try, and where the try starts is the whole
		// point rather than a detail of layout. What it does is rewrap whatever it catches as a
		// ZendeskRequestError, and one of those carrying no status is how the retry policy
		// recognises a request that went out and got nothing back. None of the work below is
		// that, and some of it can throw: `btoa` rejects any credential containing a character
		// outside Latin-1, which is what a token pasted with a smart quote looks like, and
		// JSON.stringify rejects a body it cannot serialize. Both fail identically on the third
		// attempt. Leaving here as plain Errors is what tells the classifier no request was
		// ever made — the same reason the credentials check above sits where it does.
		const sanitizedEndpoint = this.sanitizeEndpoint(endpoint)

		const url = new URL(`${this.getBaseUrl()}${sanitizedEndpoint}`)

		// Add query parameters if provided
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

		// Only include body for non-GET requests
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
				throw new ZendeskRequestError(
					`Zendesk API Error: ${response.status} - ${describeRedirect(response, url)}`,
					response.status
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

				throw new ZendeskRequestError(
					`Zendesk API Error: ${response.status} - ${errorText}`,
					response.status,
					parseRetryAfter(response.headers.get('retry-after'))
				)
			}

			// Handle empty responses (e.g., from DELETE requests)
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
					throw new ZendeskRequestError(
						`Zendesk answered ${response.status} with a body that is not valid JSON`,
						response.status,
						undefined,
						{ cause }
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
	 * Check if an error is retryable (transient failure)
	 *
	 * Classification reads the status and nothing else, and never the message text. The
	 * message is built out of the Zendesk response body, so matching on it cannot tell a 502
	 * that happened from a 502 the body merely quotes.
	 *
	 * The rule asks two questions in order: did this come from `request` at all, and if so did
	 * Zendesk answer it. A ZendeskRequestError means a request was actually sent, and a status
	 * on it means an answer came back. No status therefore means the request went out and
	 * nothing returned, which is worth sending again whatever the underlying cause was.
	 *
	 * Written that way because the previous version matched specifics that do not exist on the
	 * runtime this deploys to. It looked for a `code` of ECONNRESET and friends, which is a
	 * Node convention — true of undici under Vitest, false of workerd. Probed against the real
	 * runtime before this was changed: an unreachable port gives a plain `Error` reading
	 * "Network connection lost." with no `code` at all, and a host that will not resolve gives
	 * "internal error; reference = <opaque id>". There is no name, code or wording worth keying
	 * on, and asking whether a response arrived makes the rule independent of all three.
	 */
	private isRetryableError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false
		}

		for (const link of causeChain(error)) {
			if (link instanceof ZendeskRequestError) {
				// A status means Zendesk answered. Retry only the ones that mean "ask again";
				// anything else it refused will be refused just as firmly on a second attempt.
				if (link.status !== undefined) {
					return RETRYABLE_STATUSES.has(link.status)
				}
				return true
			}
		}

		// Nothing in the chain came from `request`, so no request was ever made. A missing
		// credential or a malformed id fails here, and will fail identically next time.
		return false
	}

	/**
	 * Request with automatic retry for transient failures
	 * Uses exponential backoff for retry delays
	 *
	 * One deadline governs the call. Attempts fit inside it rather than each starting a fresh
	 * timeout, because what a caller cares about is how long until it hears back, not how long
	 * any individual attempt was allowed to run.
	 *
	 * `maxRetries` stays, but it is no longer the interesting bound. It caps the loop when
	 * failures arrive instantly and the deadline would otherwise permit a great many of them;
	 * the deadline is what decides in every case where an attempt takes real time.
	 */
	async requestWithRetry(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>,
		maxRetries = 3
	): Promise<unknown> {
		const deadline = Date.now() + TOTAL_TIMEOUT_MS
		let lastError: Error | undefined

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				return await this.request(method, endpoint, data, params, deadline - Date.now())
			} catch (error) {
				lastError = error as Error

				// Don't retry if this is the last attempt or error is not retryable
				if (attempt === maxRetries - 1 || !this.isRetryableError(error)) {
					throw error
				}

				// Calculate exponential backoff delay: 1s, 2s, 4s (capped at 5s)
				const backoff = Math.min(1000 * Math.pow(2, attempt), 5000)

				// A rate limit says how long to wait, and asking again sooner is worse than not
				// asking at all: the early retry spends more of a quota already exhausted, and
				// providers commonly extend the penalty for a caller that keeps knocking. The
				// ladder is the fallback for the responses that say nothing.
				const requested = retryAfterFrom(error)
				const delay = requested ?? backoff

				// Decide whether the next attempt fits before sleeping, rather than sleeping and
				// then discovering it does not. Waiting out a backoff only to send a request the
				// deadline aborts on arrival wastes the one thing the caller is short of.
				//
				// This is also the only cap on `Retry-After`, and the right one. Asked to wait
				// 60 seconds inside a 30 second budget, the honest answer is to stop and say so,
				// not to clamp the wait down to something Zendesk did not agree to.
				if (Date.now() + delay + MINIMUM_ATTEMPT_MS > deadline) {
					console.warn(
						`Request failed (attempt ${attempt + 1}/${maxRetries}) and the ${TOTAL_TIMEOUT_MS}ms deadline leaves no room to wait ${delay}ms and retry`,
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
					`Request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`,
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

	// === TICKETS API ===
	async listTickets(params?: Record<string, unknown>) {
		return this.request('GET', '/tickets.json', null, params)
	}

	async getTicket(id: number) {
		this.validateId(id)
		return this.requestWithRetry('GET', `/tickets/${id}.json`)
	}

	async createTicket(data: any) {
		return this.request('POST', '/tickets.json', { ticket: data })
	}

	async updateTicket(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/tickets/${id}.json`, { ticket: data })
	}

	async deleteTicket(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/tickets/${id}.json`)
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
		return this.requestWithRetry('GET', '/users/me.json')
	}

	async listUsers(params?: Record<string, unknown>) {
		return this.request('GET', '/users.json', null, params)
	}

	async getUser(id: number) {
		this.validateId(id)
		return this.requestWithRetry('GET', `/users/${id}.json`)
	}

	async createUser(data: any) {
		return this.request('POST', '/users.json', { user: data })
	}

	async updateUser(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/users/${id}.json`, { user: data })
	}

	async deleteUser(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/users/${id}.json`)
	}

	// === ORGANIZATIONS API ===
	async listOrganizations(params?: Record<string, unknown>) {
		return this.request('GET', '/organizations.json', null, params)
	}

	async getOrganization(id: number) {
		this.validateId(id)
		return this.request('GET', `/organizations/${id}.json`)
	}

	async createOrganization(data: any) {
		return this.request('POST', '/organizations.json', { organization: data })
	}

	async updateOrganization(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/organizations/${id}.json`, { organization: data })
	}

	async deleteOrganization(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/organizations/${id}.json`)
	}

	// === GROUPS API ===
	async listGroups(params?: Record<string, unknown>) {
		return this.request('GET', '/groups.json', null, params)
	}

	async getGroup(id: number) {
		this.validateId(id)
		return this.request('GET', `/groups/${id}.json`)
	}

	async createGroup(data: any) {
		return this.request('POST', '/groups.json', { group: data })
	}

	async updateGroup(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/groups/${id}.json`, { group: data })
	}

	async deleteGroup(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/groups/${id}.json`)
	}

	// === MACROS API ===
	async listMacros(params?: Record<string, unknown>) {
		return this.request('GET', '/macros.json', null, params)
	}

	async getMacro(id: number) {
		this.validateId(id)
		return this.request('GET', `/macros/${id}.json`)
	}

	/**
	 * The two typed payloads on this client. Their types come from the macro tools' own Zod
	 * schemas, so what a caller may send is whatever MCP already validated. The other sixteen
	 * create and update payloads are still `any` and are #12's to settle.
	 */
	async createMacro(data: MacroCreatePayload) {
		return this.request('POST', '/macros.json', { macro: data })
	}

	async updateMacro(id: number, data: MacroUpdatePayload) {
		this.validateId(id)
		return this.request('PUT', `/macros/${id}.json`, { macro: data })
	}

	async deleteMacro(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/macros/${id}.json`)
	}

	// === VIEWS API ===
	async listViews(params?: Record<string, unknown>) {
		return this.request('GET', '/views.json', null, params)
	}

	async getView(id: number) {
		this.validateId(id)
		return this.request('GET', `/views/${id}.json`)
	}

	async createView(data: any) {
		return this.request('POST', '/views.json', { view: data })
	}

	async updateView(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/views/${id}.json`, { view: data })
	}

	async deleteView(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/views/${id}.json`)
	}

	// === TRIGGERS API ===
	async listTriggers(params?: Record<string, unknown>) {
		return this.request('GET', '/triggers.json', null, params)
	}

	async getTrigger(id: number) {
		this.validateId(id)
		return this.request('GET', `/triggers/${id}.json`)
	}

	async createTrigger(data: any) {
		return this.request('POST', '/triggers.json', { trigger: data })
	}

	async updateTrigger(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/triggers/${id}.json`, { trigger: data })
	}

	async deleteTrigger(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/triggers/${id}.json`)
	}

	// === AUTOMATIONS API ===
	async listAutomations(params?: Record<string, unknown>) {
		return this.request('GET', '/automations.json', null, params)
	}

	async getAutomation(id: number) {
		this.validateId(id)
		return this.request('GET', `/automations/${id}.json`)
	}

	async createAutomation(data: any) {
		return this.request('POST', '/automations.json', { automation: data })
	}

	async updateAutomation(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/automations/${id}.json`, { automation: data })
	}

	async deleteAutomation(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/automations/${id}.json`)
	}

	// === SEARCH API ===
	async search(query: string, params: Record<string, unknown> = {}) {
		return this.requestWithRetry('GET', '/search.json', null, { query, ...params })
	}

	// === HELP CENTER API ===
	async listArticles(params?: Record<string, unknown>) {
		return this.request('GET', '/help_center/articles.json', null, params)
	}

	async getArticle(id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/articles/${id}.json`)
	}

	async createArticle(data: any, sectionId: number) {
		this.validateId(sectionId)
		return this.request('POST', `/help_center/sections/${sectionId}/articles.json`, {
			article: data,
		})
	}

	async updateArticle(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/help_center/articles/${id}.json`, { article: data })
	}

	async deleteArticle(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/help_center/articles/${id}.json`)
	}

	async searchArticles(params?: Record<string, unknown>) {
		return this.requestWithRetry('GET', '/help_center/articles/search.json', null, params)
	}

	// Categories
	async listCategories(params?: Record<string, unknown>) {
		return this.request('GET', '/help_center/categories.json', null, params)
	}

	async getCategory(id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/categories/${id}.json`)
	}

	/* DISABLED FOR SECURITY - create_category method
	async createCategory (data: any) {
		return this.request('POST', '/help_center/categories.json', { category: data })
	}
	*/

	/* DISABLED FOR SECURITY - update_category method
	async updateCategory (id: number, data: any) {
		return this.request('PUT', `/help_center/categories/${id}.json`, { category: data })
	}
	*/

	/* DISABLED FOR SECURITY - delete_category method
	async deleteCategory (id: number) {
		return this.request('DELETE', `/help_center/categories/${id}.json`)
	}
	*/

	// Sections
	async listSections(params?: Record<string, unknown>) {
		return this.request('GET', '/help_center/sections.json', null, params)
	}

	async getSection(id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/sections/${id}.json`)
	}

	/* DISABLED FOR SECURITY - create_section method
	async createSection (data: any, categoryId: number) {
		return this.request('POST', `/help_center/categories/${categoryId}/sections.json`, { section: data })
	}
	*/

	/* DISABLED FOR SECURITY - update_section method
	async updateSection (id: number, data: any) {
		return this.request('PUT', `/help_center/sections/${id}.json`, { section: data })
	}
	*/

	/* DISABLED FOR SECURITY - delete_section method
	async deleteSection (id: number) {
		return this.request('DELETE', `/help_center/sections/${id}.json`)
	}
	*/

	async listSectionsByCategory(categoryId: number, params?: Record<string, unknown>) {
		this.validateId(categoryId)
		return this.request('GET', `/help_center/categories/${categoryId}/sections.json`, null, params)
	}

	async listArticlesBySection(sectionId: number, params?: Record<string, unknown>) {
		this.validateId(sectionId)
		return this.request('GET', `/help_center/sections/${sectionId}/articles.json`, null, params)
	}

	// === TALK API ===
	async getTalkStats() {
		return this.request('GET', '/channels/voice/stats.json')
	}

	// === CHAT API ===
	async listChats(params?: Record<string, unknown>) {
		return this.request('GET', '/chats.json', null, params)
	}
}
