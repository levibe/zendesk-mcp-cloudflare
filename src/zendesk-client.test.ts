/**
 * The two checks the client makes on its inputs — the subdomain it sanitizes and the ids it
 * validates — and its retry policy all sit on the path from a tool argument to an outbound
 * request, so these drive them the way a tool does: through the public methods, against a
 * stubbed fetch, rather than reaching past `private`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZendeskClient, ZendeskRequestError } from './zendesk-client'

const credentials = {
	subdomain: 'example',
	email: 'agent@example.com',
	apiToken: 'secret-token',
}

/**
 * What the client actually hands fetch. Named separately from `RequestInit` so a test can
 * read a header or the body without casting; `vi.stubGlobal` takes the mock untyped, so
 * nothing has to line up with the real fetch signature.
 */
interface SentRequest {
	method: string
	headers: Record<string, string>
	body?: string
	redirect?: string
	signal: AbortSignal
}

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const failedResponse = (status: number, body: string) => new Response(body, { status })

/** Three seconds, in the numeric form Zendesk actually sends. */
const retryAfter = { 'retry-after': '3' }

/**
 * A response whose status arrives but whose body does not. The headers are in hand and the
 * stream then errors, which is how a connection dropped mid-body reaches the client.
 */
const unreadableResponse = (status: number) =>
	new Response(
		new ReadableStream({
			start(controller) {
				controller.error(new TypeError('body stream error'))
			},
		}),
		{ status }
	)

const redirectResponse = (status: number, location?: string) =>
	new Response(null, { status, headers: location ? { location } : {} })

/**
 * A Response body can only be read once, so `respond` is called per attempt rather than a
 * single Response being reused — a retry test would otherwise fail on a spent body.
 */
const stubFetch = (respond: (url: string, init: SentRequest) => Promise<Response>) => {
	const fetchMock = vi.fn(respond)
	vi.stubGlobal('fetch', fetchMock)
	return fetchMock
}

const urlOf = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => fetchMock.mock.calls[call][0]
const sent = (fetchMock: ReturnType<typeof stubFetch>, call = 0) => fetchMock.mock.calls[call][1]

/**
 * A request that never answers, rejecting the way fetch does once its signal is aborted.
 *
 * Both Node and workerd reject with a DOMException rather than a renamed Error, and that it
 * is an Error at all is what lets causeChain walk to it, so the real type is pinned here.
 * The wording is workerd's, taken from a probe against the runtime rather than guessed —
 * note it has no trailing full stop, where Node's does.
 */
const stubUnanswered = () =>
	stubFetch(
		(_url, init) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted', 'AbortError'))
				})
			})
	)

/**
 * Advances past both backoff waits. They are ranges rather than fixed steps — [500, 1000]
 * after the first failure and [1000, 2000] after the second — so this has to clear the top of
 * both, and 3000 is that ceiling rather than the sum of two known waits.
 *
 * The extra 500 is deliberate slack. At exactly 3000 this works, but only because a wait that
 * lands on the boundary still fires; anyone widening the jitter or adding a fourth attempt
 * would then get `expected 3 calls, got 2` from whichever test ran, pointing at that test
 * rather than at the budget here that stopped covering it.
 */
const drainBackoff = () => vi.advanceTimersByTimeAsync(3500)

let client: ZendeskClient

beforeEach(() => {
	// Fake timers throughout: it keeps the 30s abort from ever firing on its own, and lets
	// the retry tests assert on the backoff instead of waiting three real seconds.
	vi.useFakeTimers()
	// Sanitizing a subdomain warns, and so does each retry before it waits.
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	client = new ZendeskClient(credentials)
})

// The stubbed fetch and the console spy are undone by restoreMocks/unstubGlobals in
// vitest.config.ts; timers have no such switch, so they are put back by hand.
afterEach(() => {
	vi.useRealTimers()
})

describe('the subdomain', () => {
	const hostOf = async (subdomain: string) => {
		const fetchMock = stubFetch(async () => jsonResponse({ tickets: [] }))
		await new ZendeskClient({ ...credentials, subdomain }).listTickets()
		return new URL(urlOf(fetchMock)).host
	}

	it('becomes the host the request goes to', async () => {
		expect(await hostOf('example')).toBe('example.zendesk.com')
	})

	it('cannot smuggle in another host through a dot', async () => {
		expect(await hostOf('example.attacker.com')).toBe('exampleattackercom.zendesk.com')
	})

	it('cannot smuggle in a path or a query string', async () => {
		expect(await hostOf('evil.com/tickets?a=b')).toBe('evilcomticketsab.zendesk.com')
	})

	it('keeps the hyphens and underscores a real subdomain may contain', async () => {
		expect(await hostOf('my-help_desk')).toBe('my-help_desk.zendesk.com')
	})

	it('says so when it had to change the subdomain', () => {
		new ZendeskClient({ ...credentials, subdomain: 'exam ple' })

		expect(console.warn).toHaveBeenCalledWith(
			'Subdomain was sanitized from "exam ple" to "example"'
		)
	})

	it('refuses to send anything once it has sanitized away to nothing', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		const bare = new ZendeskClient({ ...credentials, subdomain: '...' })

		await expect(bare.listTickets()).rejects.toThrow('Zendesk credentials not configured')
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('falls back to the Worker env when no config is passed', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({ tickets: [] }))
		const fromEnv = new ZendeskClient(undefined, {
			ZENDESK_SUBDOMAIN: 'from-env',
			ZENDESK_EMAIL: credentials.email,
			ZENDESK_API_TOKEN: credentials.apiToken,
		})

		await fromEnv.listTickets()

		expect(new URL(urlOf(fetchMock)).host).toBe('from-env.zendesk.com')
	})
})

/**
 * There used to be a sanitizer rewriting this path, and five tests here describing what it
 * rewrote. It is gone, so what is left to pin is the property that made it pointless: the path
 * an API method writes is the path that goes out, and the only part of it a caller can move is
 * an id that `validateId` has already checked.
 *
 * One test rather than none, because reinstating a rewriting step would be invisible otherwise.
 * Every endpoint in the client is already well formed, so a filter added back would leave all
 * of them untouched and nothing else in this file would notice.
 */
describe('the endpoint path', () => {
	it('is sent exactly as the calling method wrote it', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		// A doubled slash, which no method in the client would ever write. It is here because
		// the old sanitizer would have collapsed it, so this is the assertion that fails if
		// one is put back — a well-formed path would survive a filter unchanged and prove
		// nothing.
		await client.request('GET', '/tickets//42.json')

		expect(new URL(urlOf(fetchMock)).pathname).toBe('/api/v2/tickets//42.json')
	})
})

describe('id validation', () => {
	it.each([
		['zero', 0],
		['a negative id', -1],
		['a fraction', 1.5],
		['NaN', Number.NaN],
		['Infinity', Number.POSITIVE_INFINITY],
	])('rejects %s without reaching the network', async (_label, id) => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await expect(client.getTicket(id)).rejects.toThrow(
			`Invalid ID: ${id}. ID must be a positive integer.`
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('lets a positive integer through', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({ ticket: { id: 42 } }))

		await expect(client.getTicket(42)).resolves.toEqual({ ticket: { id: 42 } })
		expect(new URL(urlOf(fetchMock)).pathname).toBe('/api/v2/tickets/42.json')
	})
})

describe('request', () => {
	it('authenticates with the email/token form of basic auth', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await client.request('GET', '/tickets.json')

		expect(sent(fetchMock).headers.Authorization).toBe(
			`Basic ${btoa('agent@example.com/token:secret-token')}`
		)
	})

	it('appends query parameters and drops the ones with no value', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await client.request('GET', '/tickets.json', null, {
			page: 2,
			sort_by: 'created_at',
			per_page: undefined,
			status: null,
		})

		const { searchParams } = new URL(urlOf(fetchMock))
		expect(searchParams.get('page')).toBe('2')
		expect(searchParams.get('sort_by')).toBe('created_at')
		expect(searchParams.has('per_page')).toBe(false)
		expect(searchParams.has('status')).toBe(false)
	})

	it('sends no body on a GET', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await client.request('GET', '/tickets.json', { subject: 'ignored' })

		expect(sent(fetchMock).body).toBeUndefined()
	})

	it('serializes the body on a POST', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))

		await client.createTicket({ subject: 'Cannot log in', comment: { body: 'Help' } })

		expect(sent(fetchMock).method).toBe('POST')
		expect(sent(fetchMock).body).toBe(
			JSON.stringify({ ticket: { subject: 'Cannot log in', comment: { body: 'Help' } } })
		)
	})

	it('answers a response that is not JSON with a bare success', async () => {
		// 204 is what a Zendesk delete answers with, and a 204 may not carry a body at all.
		stubFetch(async () => new Response(null, { status: 204 }))

		await expect(client.deleteTicket(42)).resolves.toEqual({ success: true })
	})

	it('turns a non-2xx into an error carrying the status and the body', async () => {
		stubFetch(async () => failedResponse(404, '{"error":"RecordNotFound"}'))

		await expect(client.request('GET', '/tickets/42.json')).rejects.toThrow(
			'Zendesk request failed: Zendesk API Error: 404 - {"error":"RecordNotFound"}'
		)
	})

	// The status is what the retry policy classifies on, so it has to survive the rewrap that
	// turns the failure into a sentence. Asserting it here is asserting the thing that makes
	// requestWithRetry able to tell a 429 from a body that quotes one.
	it('carries the status Zendesk answered with', async () => {
		stubFetch(async () => failedResponse(429, 'Number of allowed API requests per minute'))

		const failure = client.request('GET', '/tickets.json')

		await expect(failure).rejects.toBeInstanceOf(ZendeskRequestError)
		await expect(failure).rejects.toHaveProperty('status', 429)
	})

	it('carries the status even when the body it answered with will not parse', async () => {
		stubFetch(
			async () =>
				new Response('<html>maintenance</html>', {
					headers: { 'content-type': 'application/json' },
				})
		)

		const failure = client.request('GET', '/tickets.json')

		await expect(failure).rejects.toThrow('Zendesk answered 200 with a body that is not valid JSON')
		await expect(failure).rejects.toHaveProperty('status', 200)
	})

	// Every branch that raises once a response is in hand goes through one helper built from that
	// response, so none of them can leave the status off — there is no argument to omit. The
	// point of the table is that it holds for a branch nobody had this invariant in mind while
	// writing, which is how all four of the instances in #56 got there.
	//
	// `Retry-After` comes along on all three, including the two whose status can never be
	// retried. That is the uniformity being asserted rather than a claim it is useful: reading
	// the header everywhere is what stops a site deciding it does not need one, which is exactly
	// how the JSON-parse branch came to omit it.
	it.each([
		['a refusal', 429, () => new Response('rate limited', { status: 429, headers: retryAfter })],
		['a redirect', 301, () => new Response(null, { status: 301, headers: retryAfter })],
		[
			'a body that will not parse',
			200,
			() =>
				new Response('<html>', {
					headers: { ...retryAfter, 'content-type': 'application/json' },
				}),
		],
	])(
		'carries the status and Retry-After of the response behind %s',
		async (_label, status, response) => {
			stubFetch(async () => response())

			const failure = client.request('GET', '/tickets.json')

			await expect(failure).rejects.toBeInstanceOf(ZendeskRequestError)
			await expect(failure).rejects.toHaveProperty('status', status)
			await expect(failure).rejects.toHaveProperty('retryAfterMs', 3_000)
		}
	)

	it('leaves the status unset when the request never got an answer', async () => {
		stubFetch(async () => {
			throw new TypeError('fetch failed')
		})

		const failure = client.request('GET', '/tickets.json')

		await expect(failure).rejects.toBeInstanceOf(ZendeskRequestError)
		await expect(failure).rejects.toHaveProperty('status', undefined)
	})

	// `request` rewraps every failure, so the Zendesk error itself survives only as the cause.
	// Two things downstream read it back out, and asserting only on the message above would let
	// them drift apart from this unnoticed. `executeSearchWithStandardizedResponse` puts the
	// cause in the structured record it logs for Workers observability, and `isRetryableError`
	// walks the whole chain looking for the link that carries a status. Dropping the cause would
	// strip the real reason out of every failed search and leave the retry policy classifying a
	// refusal it can no longer see.
	it('keeps the underlying error as the cause of the one it throws', async () => {
		stubFetch(async () => failedResponse(404, '{"error":"RecordNotFound"}'))

		await expect(client.request('GET', '/tickets/42.json')).rejects.toHaveProperty(
			'cause.message',
			'Zendesk API Error: 404 - {"error":"RecordNotFound"}'
		)
	})
})

/**
 * Confirmed against workerd before any of this was written, rather than read off the flag's
 * documentation: under `follow`, a hop from 127.0.0.1 to localhost arrived carrying no
 * Authorization header at all, and under `manual` the 301 came back intact with `Location`
 * readable — not the opaque status-0 response a browser would hand back. The fix depends on
 * both of those, so they were worth establishing rather than assuming.
 */
describe('a redirect', () => {
	it('is not followed', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({ tickets: [] }))

		await client.listTickets()

		expect(sent(fetchMock).redirect).toBe('manual')
	})

	// The whole point of #39: this used to be a 401 carrying a Zendesk authentication-error
	// body, which reads exactly like a revoked token and names nothing worth acting on.
	it('to another host names that host and the secret to change', async () => {
		stubFetch(async () => redirectResponse(301, 'https://renamed.zendesk.com/api/v2/tickets.json'))

		await expect(client.request('GET', '/tickets.json')).rejects.toThrow(
			/redirected to renamed\.zendesk\.com\..*does not survive a hop to another host.*update ZENDESK_SUBDOMAIN/s
		)
	})

	// A same-origin redirect would have kept the credential, so it is a different problem
	// with a different fix. Saying so keeps it from being read as the credential failure.
	it('to the same host says so instead', async () => {
		stubFetch(async () => redirectResponse(307, '/api/v2/tickets.json?page=2'))

		await expect(client.request('GET', '/tickets.json')).rejects.toThrow(
			'redirected to /api/v2/tickets.json on the same host'
		)
	})

	it('with no destination still fails rather than reporting an empty body', async () => {
		stubFetch(async () => redirectResponse(302))

		await expect(client.request('GET', '/tickets.json')).rejects.toThrow(
			'redirected without naming a destination'
		)
	})

	it('carries the status it answered with', async () => {
		stubFetch(async () => redirectResponse(301, 'https://renamed.zendesk.com/'))

		await expect(client.request('GET', '/tickets.json')).rejects.toHaveProperty('status', 301)
	})

	// It carries a status, so it is classified as an answer Zendesk gave rather than as a
	// request that never completed. 3xx is not in the retryable set, so it is asked once.
	it('is not retried', async () => {
		const fetchMock = stubFetch(async () =>
			redirectResponse(301, 'https://renamed.zendesk.com/api/v2/tickets.json')
		)

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow('redirected to')

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})
})

describe('the 30 second timeout', () => {
	it('aborts a request that has not answered', async () => {
		stubUnanswered()

		const attempt = client.request('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow(
			'Zendesk request failed: The operation was aborted'
		)

		await vi.advanceTimersByTimeAsync(29_999)
		await vi.advanceTimersByTimeAsync(1)
		await rejects
	})

	it('leaves no timer behind after a request succeeds', async () => {
		stubFetch(async () => jsonResponse({ tickets: [] }))

		await client.request('GET', '/tickets.json')

		expect(vi.getTimerCount()).toBe(0)
	})

	it('leaves no timer behind after the server answers with an error', async () => {
		stubFetch(async () => failedResponse(500, 'boom'))

		await expect(client.request('GET', '/tickets.json')).rejects.toThrow()

		expect(vi.getTimerCount()).toBe(0)
	})

	// The two above clear their timer on the line straight after `await fetch`, which is
	// reached whenever fetch answered at all. This is the one path that gets there through
	// the `finally` instead — fetch rejecting outright — and it is the path requestWithRetry
	// walks three times per call, so a leak here strands three live 30s timers in the isolate.
	it('leaves no timer behind when fetch itself rejects', async () => {
		stubFetch(async () => {
			throw new Error('fetch failed: ECONNRESET')
		})

		await expect(client.request('GET', '/tickets.json')).rejects.toThrow('ECONNRESET')

		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('requestWithRetry', () => {
	// 408 is here because it means the request timed out on Zendesk's side. The old classifier
	// retried it only when the response body happened to contain the word "timeout", so an
	// empty-bodied 408 was dropped — this makes it the same answer either way.
	it.each([408, 429, 502, 503, 504])(
		'retries a %i and gives up after three attempts',
		async (status) => {
			const fetchMock = stubFetch(async () => failedResponse(status, 'transient'))

			const attempt = client.requestWithRetry('GET', '/tickets.json')
			const rejects = expect(attempt).rejects.toThrow(`Zendesk API Error: ${status}`)
			await drainBackoff()
			await rejects

			expect(fetchMock).toHaveBeenCalledTimes(3)
		}
	)

	/**
	 * The shapes a failed connection actually arrives in. They differ by runtime and share
	 * nothing worth matching on, which is the whole of #29.
	 *
	 * The first two are undici's, as Node and Vitest produce them — a bare "fetch failed" with
	 * the real socket error as its cause, carrying the `code` the old classifier looked for.
	 * The rest were probed against workerd, which is what actually serves production: an
	 * unreachable port is a plain `Error` reading "Network connection lost." with no `code` at
	 * all, and a host that will not resolve is an opaque reference id. None of the last three
	 * matched anything the old rule knew about, so all three went unretried where it counted.
	 *
	 * What they do share is that no response came back, and that is now what is asked.
	 */
	it.each([
		[
			'undici reporting a reset socket',
			() =>
				new TypeError('fetch failed', {
					cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
				}),
		],
		[
			'undici reporting a refused connection',
			() =>
				new TypeError('fetch failed', {
					cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
				}),
		],
		['workerd losing the connection', () => new Error('Network connection lost.')],
		[
			'workerd failing to resolve the host',
			() => new Error('internal error; reference = lfgpejlogahfrh23do9e5eib'),
		],
		// This one inverted with #29, and the inversion is the point. It used to assert a
		// single attempt, on the grounds that there was no code to go on — which describes
		// every dropped connection workerd will ever report.
		['a bare fetch failure with nothing beneath it', () => new TypeError('fetch failed')],
	])('retries %s', async (_label, makeError) => {
		const fetchMock = stubFetch(async () => {
			throw makeError()
		})

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk request failed')
		await drainBackoff()
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	// A missing credential also produces no status, so it would be indistinguishable from a
	// lost connection if `request` still wrapped it. It is thrown before the try for exactly
	// this reason: three seconds of backoff cannot conjure a token that was never set.
	it('does not retry a missing credential', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		const unconfigured = new ZendeskClient({ ...credentials, apiToken: '' })

		await expect(unconfigured.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk credentials not configured'
		)

		expect(fetchMock).not.toHaveBeenCalled()
	})

	/**
	 * The same shape as the missing credential above, and the reason the try starts where it
	 * does rather than at the top of `request`.
	 *
	 * Preparing a request can fail, and none of those failures mean "nothing came back" —
	 * they mean nothing was sent. `btoa` rejects any credential holding a character outside
	 * Latin-1, which is what a token pasted with a smart quote looks like, and JSON.stringify
	 * rejects a body it cannot serialize. Wrapped as ZendeskRequestErrors they would be
	 * indistinguishable from a dropped connection and asked three times over.
	 *
	 * Staying a plain Error is the mechanism, so that is what these assert, alongside fetch
	 * never being reached and no timer being left behind.
	 */
	it('does not retry a credential btoa cannot encode', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		// A smart quote, which is what a token pasted out of a document or a chat carries.
		const smartQuoted = new ZendeskClient({ ...credentials, apiToken: 'abc’def' })

		const failure = smartQuoted.requestWithRetry('GET', '/tickets.json')

		// Pinned by name rather than left at "something threw", so that an unrelated failure
		// inside requestWithRetry cannot pass as this one. The name is the stable half of a
		// DOMException across Node and workerd; the message wording is not.
		await expect(failure).rejects.toHaveProperty('name', 'InvalidCharacterError')
		await expect(failure).rejects.not.toBeInstanceOf(ZendeskRequestError)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it('does not retry a body that will not serialize', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		const circular: Record<string, unknown> = {}
		circular.self = circular

		const failure = client.requestWithRetry('POST', '/tickets.json', circular)

		await expect(failure).rejects.toThrow(/circular/i)
		await expect(failure).rejects.not.toBeInstanceOf(ZendeskRequestError)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	// Zendesk answered, so this is not a request that failed to complete. The status is put on
	// the error to say so — without it, the rule above would send the request a second time,
	// re-asking for something that already arrived because its body would not parse.
	it('does not retry a body that will not parse', async () => {
		const fetchMock = stubFetch(
			async () =>
				new Response('<html>maintenance</html>', {
					headers: { 'content-type': 'application/json' },
				})
		)

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk answered 200 with a body that is not valid JSON'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// The sibling of the case above, on the failure branch rather than the success one, and
	// the one that got missed. A body is a stream, so reading it can fail after the status is
	// already in hand. Letting that propagate would hand the outer catch a plain Error, which
	// it rewraps carrying no status — and the rule below reads a statusless error as a request
	// that never got an answer, so a flatly refused 400 would go out twice more. Asserting on
	// the count is the point; the message only shows the status survived to be reported.
	it('does not retry a 400 whose body cannot be read', async () => {
		const fetchMock = stubFetch(async () => unreadableResponse(400))

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 400'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// 500 is in here deliberately. It is a server error and it is not retried, because Zendesk
	// uses it for faults that will fail the same way again — 502, 503 and 504 are the ones
	// that mean the request never reached a healthy backend.
	it.each([400, 401, 403, 404, 422, 500])('does not retry a %i', async (status) => {
		const fetchMock = stubFetch(async () => failedResponse(status, 'refused'))

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			`Zendesk API Error: ${status}`
		)
		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// This was #18. The classifier used to search the error message, which `request` builds
	// out of the response body, so three digits quoted in that body were indistinguishable
	// from the status itself. It reads `status` now, so the body can say whatever it likes.
	it('does not retry a 400 whose body happens to mention 502', async () => {
		const fetchMock = stubFetch(async () =>
			failedResponse(400, '{"description":"upstream returned 502 earlier"}')
		)

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 400'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
	})

	// This was #17, and it inverted with #32. It used to advance step by step through three
	// 30s attempts and two backoffs, roughly 93 seconds, precisely so the cost was visible.
	// The deadline covers the whole call now, so a hung endpoint spends it on the first
	// attempt and there is nothing left to retry into — 30 seconds, as it was before #24 made
	// retrying a timeout possible. The AbortError is still two links down the chain, which is
	// why the classifier walks `cause` rather than reading only what it was handed.
	it('does not retry a hung request, because one attempt spends the whole deadline', async () => {
		const fetchMock = stubUnanswered()

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('The operation was aborted')

		await vi.advanceTimersByTimeAsync(30_000)
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	// The second attempt inherits what is left rather than starting its own 30 seconds, so
	// the whole call still lands on the deadline instead of at 61 seconds.
	it('gives a later attempt only the time the deadline has left', async () => {
		// Pinned to the top of the jitter so the backoff is exactly the second the arithmetic
		// below talks about. The assertions hold at any point in the range — the deadline is an
		// absolute instant, so a shorter backoff just means a longer second attempt — but the
		// comments would stop describing what ran.
		vi.spyOn(Math, 'random').mockReturnValue(1)
		let calls = 0
		const fetchMock = stubFetch((_url, init) => {
			calls += 1
			if (calls === 1) return Promise.resolve(failedResponse(503, 'unavailable'))
			return new Promise<Response>((_resolve, reject) => {
				init.signal.addEventListener('abort', () => {
					reject(new DOMException('The operation was aborted', 'AbortError'))
				})
			})
		})

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('The operation was aborted')

		await vi.advanceTimersByTimeAsync(1_000) // backoff, then the second attempt starts
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// 29s more reaches the deadline, not 30 — the second attempt started a second late.
		await vi.advanceTimersByTimeAsync(28_999)
		await vi.advanceTimersByTimeAsync(1)
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(2)
		expect(vi.getTimerCount()).toBe(0)
	})

	// The decision is taken before the sleep rather than after it. Waiting out a backoff only
	// to send a request that gets aborted on arrival spends the one thing the caller is short
	// of, and reports the failure a second later than it was already known.
	it('stops instead of sleeping into a retry the deadline cannot fit', async () => {
		const fetchMock = stubFetch(
			() =>
				new Promise<Response>((resolve) =>
					setTimeout(() => resolve(failedResponse(503, 'unavailable')), 29_000)
				)
		)

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 503')

		await vi.advanceTimersByTimeAsync(29_000)
		await rejects

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	/**
	 * The ladder is jittered across the lower half of each step, so it is a range rather than a
	 * pair of numbers and these two tests take its ends. Pinning `Math.random` is what makes
	 * either end assertable; the alternative is a test that accepts a window, which would pass
	 * just as happily if the spread quietly widened to something that undid the backoff.
	 */
	it('waits at most one second, then at most two, and never sleeps after the last attempt', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 503')

		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(1999)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		await rejects
		expect(vi.getTimerCount()).toBe(0)
	})

	/**
	 * The floor, which is the half of the spread worth pinning hardest. Jitter that can reach
	 * zero is not a spread but a retry storm with extra steps, so the first wait has to stay
	 * half a second even when the roll comes up as low as it goes.
	 */
	it('waits at least half of each step when the jitter rolls low', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 503')

		await vi.advanceTimersByTimeAsync(499)
		expect(fetchMock).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(2)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(3)

		await rejects
		expect(vi.getTimerCount()).toBe(0)
	})

	/**
	 * What the jitter is actually for, which neither end of the range shows on its own: two
	 * callers that failed at the same instant have to come back at different ones. This is the
	 * fan-out case in miniature — `get_help_center_hierarchy` issues a read per category and
	 * then one per section through nested Promise.all, so a 503 fails all of them together, and
	 * on a fixed ladder all of them would return together too.
	 */
	it('does not send two callers that failed together back together', async () => {
		const rolls = [0, 1]
		vi.spyOn(Math, 'random').mockImplementation(() => rolls.shift() ?? 0)
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const first = client.requestWithRetry('GET', '/tickets.json')
		const second = client.requestWithRetry('GET', '/macros.json')
		const settled = Promise.allSettled([first, second])

		await vi.advanceTimersByTimeAsync(0)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		// The one that rolled low is back at 500ms; the one that rolled high waits out the
		// full second. Same failure, same instant, different return.
		await vi.advanceTimersByTimeAsync(500)
		expect(fetchMock).toHaveBeenCalledTimes(3)
		await vi.advanceTimersByTimeAsync(500)
		expect(fetchMock).toHaveBeenCalledTimes(4)

		await drainBackoff()
		await settled
	})

	it('stops as soon as an attempt succeeds', async () => {
		let calls = 0
		const fetchMock = stubFetch(async () => {
			calls += 1
			return calls === 1 ? failedResponse(503, 'unavailable') : jsonResponse({ tickets: [] })
		})

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		await drainBackoff()

		await expect(attempt).resolves.toEqual({ tickets: [] })
		expect(fetchMock).toHaveBeenCalledTimes(2)
	})
})

/**
 * The rule #54 settled, as #58 narrowed it: the HTTP verb decides what may be sent again. The
 * probe here is a 503, which is ambiguous — it may have been acted on — so it stays the status
 * that separates the verbs cleanly, a GET attempted three times against it and everything else
 * once. The refusals a write may now retry are covered in `the per-verb retry policy` below.
 *
 * `send` is what makes that true, so what this really asks of each method is whether it went
 * through `send` at all. Nothing stops one reaching `request` or `requestWithRetry` directly
 * and choosing for itself, which is exactly what the fifty-eight methods used to do.
 *
 * Driven off the prototype rather than a list of method names kept here, because a list kept
 * here is the same discipline that produced the split in the first place — five methods
 * retried, fifty-odd did not, and nothing said which was intended. Walking the class means a
 * read that goes around `send` fails on the day it is written rather than whenever someone
 * next reads the client top to bottom.
 */
describe('which methods retry', () => {
	/**
	 * Everything on the prototype that does not reach Zendesk: the constructor, the request
	 * methods and the dispatcher itself, and the private helpers — all ordinary prototype
	 * properties at runtime, whatever TypeScript calls them.
	 *
	 * A denylist on purpose, and the one place in this file where that is the right shape. An
	 * allowlist would let a new method be forgotten silently, which is the failure being fixed;
	 * this way a new API method is covered by default, and a new private helper announces itself
	 * by failing here until it is named.
	 */
	const notAnApiCall = new Set([
		'constructor',
		'request',
		'requestWithRetry',
		'send',
		'sanitizeSubdomain',
		'validateId',
		'getBaseUrl',
		'getAuthHeader',
		'isRetryableError',
	])

	const apiMethods = Object.getOwnPropertyNames(ZendeskClient.prototype).filter(
		(name) => !notAnApiCall.has(name)
	)

	/**
	 * One value passed in both positions, which is what lets a single probe drive methods whose
	 * signatures disagree about what goes where. Across the class, the first two parameters are
	 * some arrangement of an id, a payload, a query string and a params object, so the probe has
	 * to be a value every one of those accepts.
	 *
	 * A positive integer is that value, and the test below pins the three reasons rather than
	 * leaving them to be rediscovered — they are the sort of thing that reads as an arbitrary
	 * choice once the person who made it has moved on.
	 */
	const PROBE = 1
	const probeArguments = [PROBE, PROBE]

	/**
	 * Why `1` works everywhere. Each of these is load-bearing: if one stopped holding, the probe
	 * would throw before reaching fetch and every case below would fail at once, which is loud
	 * but says nothing about the cause. Asserting them separately is what makes the cause
	 * readable, and stops the probe being changed to a value that only looks equivalent.
	 */
	it('is driven by a value every parameter position accepts', () => {
		// An id: positive and whole, so validateId passes it.
		expect(Number.isInteger(PROBE) && PROBE > 0).toBe(true)
		// A payload: serializes rather than throwing the way a circular object would.
		expect(JSON.stringify(PROBE)).toBe('1')
		// A params object: yields no query parameters. A string here would enumerate to its
		// characters and put `0=x` on the URL instead. This covers `search` spreading its
		// second argument too, since a spread enumerates exactly what Object.entries does.
		expect(Object.entries(PROBE)).toEqual([])
	})

	const callable = (name: string) =>
		(client as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[name]

	/**
	 * `it.each` over an empty array runs nothing and still reports the file green, so what the
	 * walk found is asserted rather than assumed. Without this, a change in how the class is
	 * built — methods moved to instance fields, or reached through a mixin — would retire the
	 * whole block silently, which is the failure it exists to prevent happening one level up.
	 */
	it('found the methods to drive', () => {
		expect(apiMethods).toContain('listTickets')
		expect(apiMethods).toContain('createTicket')
		expect(apiMethods.length).toBeGreaterThan(50)
	})

	it.each(apiMethods)('sends %s again against a 503 only if it is a GET', async (name) => {
		const fetchMock = stubFetch(async () => failedResponse(503, 'unavailable'))

		const call = callable(name).apply(client, probeArguments)
		const rejects = expect(call).rejects.toThrow('Zendesk API Error: 503')
		await drainBackoff()
		await rejects

		// Read off what went out rather than off the method's name, so the assertion turns on
		// the same fact the client does. A method whose arguments never reached fetch has
		// already failed the line above, so there is a call to read here.
		const expected = sent(fetchMock).method === 'GET' ? 3 : 1
		expect(fetchMock).toHaveBeenCalledTimes(expected)
	})
})

/**
 * #58: a write retries the refusals that cannot have acted on it, and nothing else.
 *
 * Driven through `createTicket` and `listTickets` rather than through `requestWithRetry` with a
 * verb argument, because the thing worth pinning is what an API method actually gets — the
 * dispatch in `send` and the classifier agreeing is the whole of the feature, and a test that
 * called the retry loop directly would pass with `send` routing writes anywhere at all.
 */
describe('the per-verb retry policy', () => {
	const attemptsAgainst = async (status: number, call: () => Promise<unknown>) => {
		const fetchMock = stubFetch(async () => failedResponse(status, 'refused'))
		const rejects = expect(call()).rejects.toThrow(`Zendesk API Error: ${status}`)
		await drainBackoff()
		await rejects
		return fetchMock.mock.calls.length
	}

	const aWrite = () => client.createTicket({ subject: 'hi', comment: { body: 'hi' } })
	const aRead = () => client.listTickets()

	// The two that mean the request was refused before anything happened. A rate limit is
	// Zendesk declining to start the work, and a 408 is Zendesk giving up before the request
	// finished arriving. Neither can have made a ticket, so a write is as safe to resend as a
	// read — and a rate limit is the failure a busy account actually meets.
	it.each([408, 429])('sends a write again on a %i', async (status) => {
		expect(await attemptsAgainst(status, aWrite)).toBe(3)
	})

	// The ambiguous ones. A 504 means a gateway stopped waiting for a backend that may have gone
	// on to finish the work, and nothing here can tell that from one that never got it.
	it.each([502, 503, 504])('sends a write once on a %i', async (status) => {
		expect(await attemptsAgainst(status, aWrite)).toBe(1)
	})

	it.each([408, 429, 502, 503, 504])('sends a read again on a %i', async (status) => {
		expect(await attemptsAgainst(status, aRead)).toBe(3)
	})

	// The sharp edge, and the reason this is not just a narrower set. No status means the
	// request went out and nothing came back, so we never learned whether the work happened —
	// strictly less than a 504 tells us, and a 504 is already refused above. A read asks again
	// because asking costs only time; a write cannot, because this is the case that makes the
	// second ticket.
	describe('when no answer came back at all', () => {
		const dropped = () =>
			stubFetch(async () => {
				throw new TypeError('fetch failed')
			})

		it('sends a write exactly once', async () => {
			const fetchMock = dropped()

			const rejects = expect(
				client.createTicket({ subject: 'hi', comment: { body: 'hi' } })
			).rejects.toThrow('Zendesk request failed')
			await drainBackoff()
			await rejects

			expect(fetchMock).toHaveBeenCalledTimes(1)
		})

		it('still sends a read again', async () => {
			const fetchMock = dropped()

			const rejects = expect(client.listTickets()).rejects.toThrow('Zendesk request failed')
			await drainBackoff()
			await rejects

			expect(fetchMock).toHaveBeenCalledTimes(3)
		})
	})
})

describe('Retry-After', () => {
	const rateLimited = (retryAfter: string) =>
		new Response('Number of allowed API requests per minute exceeded', {
			status: 429,
			headers: { 'retry-after': retryAfter },
		})

	it('is carried on the error, next to the status', async () => {
		stubFetch(async () => rateLimited('30'))

		await expect(client.request('GET', '/tickets.json')).rejects.toHaveProperty(
			'retryAfterMs',
			30_000
		)
	})

	// The ladder would have asked again within a second. Retrying sooner than you were told to
	// is worse than not retrying: it spends more of a quota already exhausted, and providers
	// commonly extend the penalty for a caller that keeps knocking. The spread on top answers
	// the other way of keeping knocking: the header speaks in whole seconds, so every caller
	// refused together is told the same figure, and without the spread they would all arrive
	// back in one burst at the reset moment. Pinned at the top of the spread here; the floor
	// is the test below.
	it('waits out the requested figure plus a spread instead of running its own ladder', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => rateLimited('2'))

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(2_999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(3_000)
		await rejects
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	// The floor of the spread window, which is the half worth pinning hardest: at its lowest
	// roll the wait is exactly the figure Zendesk named. The spread only ever adds — a roll
	// that could land the retry before the reset would be asking earlier than agreed, which
	// is the thing this path exists to avoid.
	it('never retries before the moment Zendesk named', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const fetchMock = stubFetch(async () => rateLimited('2'))

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(1_999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await vi.advanceTimersByTimeAsync(2_000)
		await rejects
		expect(fetchMock).toHaveBeenCalledTimes(3)
	})

	// The deadline from #32 is the only cap on this, and the right one. Clamping a 60 second
	// wait down to something Zendesk never agreed to would defeat the point of reading the
	// header, so the honest answer to a wait that will not fit the budget is to stop.
	it('ends the call when the wait it asks for exceeds the deadline', async () => {
		const fetchMock = stubFetch(async () => rateLimited('60'))

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 429'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	// The spread counts against the deadline the same way the wait it rides on does, because
	// the fit check reads the delay with the spread already in it. Twenty-nine seconds fits
	// the budget on its own; with the spread at its widest it does not, and the honest answer
	// stays the one above — stop and say so rather than sleep into a retry that cannot run.
	it('counts the spread against the deadline when deciding whether a retry fits', async () => {
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => rateLimited('29'))

		await expect(client.requestWithRetry('GET', '/tickets.json')).rejects.toThrow(
			'Zendesk API Error: 429'
		)

		expect(fetchMock).toHaveBeenCalledTimes(1)
		expect(vi.getTimerCount()).toBe(0)
	})

	// Zendesk sends seconds, but the header is defined as seconds or an HTTP date, and
	// reading only half of it without saying so is the kind of gap that gets found in
	// production rather than here.
	it('understands the date form as well as the seconds form', async () => {
		vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
		// The spread is pinned to its floor because this test is about reading the header
		// form, and the arithmetic below should be the date's four seconds and nothing else.
		vi.spyOn(Math, 'random').mockReturnValue(0)
		const fetchMock = stubFetch(async () => rateLimited('Sat, 01 Aug 2026 12:00:04 GMT'))

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(3_999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await drainBackoff()
		await rejects
	})

	/**
	 * None of these says anything usable about how long to wait, so the ladder answers instead.
	 * `Math.random` is pinned to the top of the jitter so that "the ladder answered" is a single
	 * number to assert rather than a window — what these are about is which of the two sources
	 * decided, not what the spread does with it.
	 *
	 * The last three are why the guard is a positive-wait check rather than a tighter pattern.
	 * `Date.parse` reads '-5' as May 2001 and '120' as the year 120, so it cannot be trusted
	 * to reject nonsense on its own — and a header that resolves into the past would otherwise
	 * mean "retry now", which against an exhausted quota is the one answer worth avoiding.
	 */
	it.each([
		['a word', 'soon'],
		['an empty header', ''],
		['exponential notation', '1e3'],
		['zero seconds', '0'],
		['a negative number', '-5'],
		['a date already past', 'Sat, 01 Aug 2026 11:59:00 GMT'],
	])('falls back to the ladder for %s', async (_label, header) => {
		vi.setSystemTime(new Date('2026-08-01T12:00:00Z'))
		vi.spyOn(Math, 'random').mockReturnValue(1)
		const fetchMock = stubFetch(async () => rateLimited(header))

		const attempt = client.requestWithRetry('GET', '/tickets.json')
		const rejects = expect(attempt).rejects.toThrow('Zendesk API Error: 429')

		await vi.advanceTimersByTimeAsync(999)
		expect(fetchMock).toHaveBeenCalledTimes(1)

		await vi.advanceTimersByTimeAsync(1)
		expect(fetchMock).toHaveBeenCalledTimes(2)

		await drainBackoff()
		await rejects
	})
})
