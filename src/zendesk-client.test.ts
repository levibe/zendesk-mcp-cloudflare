/**
 * The client's three sanitizers and its retry policy all sit on the path from a tool
 * argument to an outbound request, so these drive them the way a tool does — through the
 * public methods, against a stubbed fetch — rather than reaching past `private`.
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
	signal: AbortSignal
}

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const failedResponse = (status: number, body: string) => new Response(body, { status })

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

/** Advances past both backoff waits — 1s after the first failure, 2s after the second. */
const drainBackoff = () => vi.advanceTimersByTimeAsync(3000)

let client: ZendeskClient

beforeEach(() => {
	// Fake timers throughout: it keeps the 30s abort from ever firing on its own, and lets
	// the retry tests assert on the backoff instead of waiting three real seconds.
	vi.useFakeTimers()
	// The constructor warns about missing credentials and each retry warns about the wait.
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

describe('the endpoint path', () => {
	const pathOf = async (endpoint: string) => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		await client.request('GET', endpoint)
		return new URL(urlOf(fetchMock)).pathname
	}

	it('is left alone when it is already well formed', async () => {
		expect(await pathOf('/tickets.json')).toBe('/api/v2/tickets.json')
	})

	it('gains a leading slash when it is missing one', async () => {
		expect(await pathOf('tickets.json')).toBe('/api/v2/tickets.json')
	})

	it('collapses a doubled slash', async () => {
		expect(await pathOf('/tickets//1.json')).toBe('/api/v2/tickets/1.json')
	})

	// Both replacements are a single pass, so removing the two `..` leaves three slashes and
	// the collapse only closes one of them. The traversal is gone either way — the request
	// stays under /api/v2 — but the surviving `//` is why this asserts the exact path.
	it('cannot climb out of /api/v2', async () => {
		expect(await pathOf('/../../admin.json')).toBe('/api/v2//admin.json')
	})

	it('strips a relative segment from an endpoint with no leading slash', async () => {
		expect(await pathOf('../secrets.json')).toBe('/api/v2/secrets.json')
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

		await client.createTicket({ subject: 'Cannot log in' })

		expect(sent(fetchMock).method).toBe('POST')
		expect(sent(fetchMock).body).toBe(JSON.stringify({ ticket: { subject: 'Cannot log in' } }))
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

	it('leaves the status unset when the request never got an answer', async () => {
		stubFetch(async () => {
			throw new TypeError('fetch failed')
		})

		const failure = client.request('GET', '/tickets.json')

		await expect(failure).rejects.toBeInstanceOf(ZendeskRequestError)
		await expect(failure).rejects.toHaveProperty('status', undefined)
	})

	// `request` rewraps every failure, so the Zendesk error itself survives only as the cause.
	// executeSearchWithStandardizedResponse reads that back out into metadata.errorCause, and
	// asserting only on the message above would let the two halves drift apart unnoticed:
	// dropping the cause would strip the real reason out of every failed search, silently.
	it('keeps the underlying error as the cause of the one it throws', async () => {
		stubFetch(async () => failedResponse(404, '{"error":"RecordNotFound"}'))

		await expect(client.request('GET', '/tickets/42.json')).rejects.toHaveProperty(
			'cause.message',
			'Zendesk API Error: 404 - {"error":"RecordNotFound"}'
		)
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

	it('waits one second, then two, and never sleeps after the last attempt', async () => {
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
