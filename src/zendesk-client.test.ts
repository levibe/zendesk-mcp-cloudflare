/**
 * What the Zendesk client adds on top of the transport: the subdomain it sanitizes, the ids
 * it validates, the credential closure it hands `HttpClient`, and the one doorway (`send`)
 * every API method goes through. All of it sits on the path from a tool argument to an
 * outbound request, so these drive it the way a tool does: through the public methods,
 * against a stubbed fetch, rather than reaching past `private`.
 *
 * The transport's own behaviour — retry policy, deadline, Retry-After, redirects, timeouts —
 * is covered in utils/http-client.test.ts, where it moved with the code (#93).
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

/**
 * The credential closure the constructor hands `HttpClient`. It throws from `authHeader`,
 * which the transport calls outside its try — so a bad credential is a plain, never-retried
 * error, and these assert that end to end through a real API method.
 */
describe('the credentials', () => {
	it('authenticate with the email/token form of basic auth', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({ tickets: [] }))

		await client.listTickets()

		expect(sent(fetchMock).headers.Authorization).toBe(
			`Basic ${btoa('agent@example.com/token:secret-token')}`
		)
	})

	// A missing credential also produces no status, so it would be indistinguishable from a
	// lost connection if the transport wrapped it. It is thrown from `authHeader` for exactly
	// this reason: three seconds of backoff cannot conjure a token that was never set.
	it('do not retry when one is missing', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		const unconfigured = new ZendeskClient({ ...credentials, apiToken: '' })

		await expect(unconfigured.listTickets()).rejects.toThrow('Zendesk credentials not configured')

		expect(fetchMock).not.toHaveBeenCalled()
	})

	/**
	 * The same shape as the missing credential above. `btoa` rejects any credential holding a
	 * character outside Latin-1, which is what a token pasted with a smart quote looks like.
	 * Wrapped as a ZendeskRequestError it would be indistinguishable from a dropped connection
	 * and asked three times over; staying a plain error is the mechanism, so that is what this
	 * asserts, alongside fetch never being reached and no timer being left behind.
	 */
	it('do not retry a token btoa cannot encode', async () => {
		const fetchMock = stubFetch(async () => jsonResponse({}))
		// A smart quote, which is what a token pasted out of a document or a chat carries.
		const smartQuoted = new ZendeskClient({ ...credentials, apiToken: 'abc’def' })

		const failure = smartQuoted.listTickets()

		// Pinned by name rather than left at "something threw", so that an unrelated failure
		// inside the retry loop cannot pass as this one. The name is the stable half of a
		// DOMException across Node and workerd; the message wording is not.
		await expect(failure).rejects.toHaveProperty('name', 'InvalidCharacterError')
		await expect(failure).rejects.not.toBeInstanceOf(ZendeskRequestError)
		expect(fetchMock).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})
})

describe('the request an API method makes', () => {
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
})

/**
 * The rule #54 settled, as #58 narrowed it: the HTTP verb decides what may be sent again. The
 * probe here is a 503, which is ambiguous — it may have been acted on — so it stays the status
 * that separates the verbs cleanly, a GET attempted three times against it and everything else
 * once. The refusals a write may now retry are covered in `the per-verb retry policy` below.
 *
 * `send` is what makes that true, so what this really asks of each method is whether it went
 * through `send` at all. Nothing stops one reaching the transport's own methods directly and
 * choosing for itself, which is exactly what the fifty-eight methods used to do.
 *
 * Driven off the prototype rather than a list of method names kept here, because a list kept
 * here is the same discipline that produced the split in the first place — five methods
 * retried, fifty-odd did not, and nothing said which was intended. Walking the class means a
 * read that goes around `send` fails on the day it is written rather than whenever someone
 * next reads the client top to bottom.
 */
describe('which methods retry', () => {
	/**
	 * Everything on the prototype that does not reach Zendesk — all ordinary prototype
	 * properties at runtime, whatever TypeScript calls them. The transport's methods left the
	 * prototype with the extraction (they live on `HttpClient` now), and `sanitizeSubdomain`
	 * became a module function, so what remains is the constructor, the dispatcher, and the
	 * id check.
	 *
	 * A denylist on purpose, and the one place in this file where that is the right shape. An
	 * allowlist would let a new method be forgotten silently, which is the failure being fixed;
	 * this way a new API method is covered by default, and a new private helper announces itself
	 * by failing here until it is named.
	 */
	const notAnApiCall = new Set(['constructor', 'send', 'validateId'])

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
 * Driven through `createTicket` and `listTickets` rather than through the transport with a
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
