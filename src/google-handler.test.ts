/**
 * `/callback` is a public, unauthenticated endpoint, and every value it reads arrives through
 * the user's browser. Most of what is asserted here is therefore about what it refuses: a
 * malformed `state` has to come back as a 400 that says one fixed thing, never as the bare 500
 * an unhandled `atob` or `JSON.parse` throw used to produce.
 *
 * The whole handler is driven through `GoogleHandler.request(...)` with a stubbed env, which is
 * the same shape a real request takes. Nothing here needs workerd: Google is reached through
 * the global `fetch` these tests stub, and the OAuth provider is an object on that env.
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AuthRequest, OAuthHelpers } from '@cloudflare/workers-oauth-provider'
import { GoogleHandler } from './google-handler'

const authRequest: AuthRequest = {
	responseType: 'code',
	clientId: 'test-client',
	redirectUri: 'https://client.example.com/oauth/callback',
	scope: ['profile', 'email'],
	state: 'client-state',
}

/** The state exactly as redirectToGoogle mints it. */
const validState = btoa(JSON.stringify(authRequest))

let completeAuthorization: Mock
let googleFetch: Mock
let tokenResponse: () => Response
let userinfoResponse: () => Response

const testEnv = (overrides: Record<string, unknown> = {}) =>
	({
		GOOGLE_CLIENT_ID: 'test-google-client-id',
		GOOGLE_CLIENT_SECRET: 'test-google-client-secret',
		COOKIE_ENCRYPTION_KEY: 'test-cookie-secret',
		ZENDESK_SUBDOMAIN: 'example',
		ZENDESK_EMAIL: 'service-account@example.com',
		ZENDESK_API_TOKEN: 'test-zendesk-token',
		OAUTH_PROVIDER: { completeAuthorization },
		...overrides,
	}) as unknown as Env & { OAUTH_PROVIDER: OAuthHelpers }

const callback = (query: Record<string, string>, env = testEnv()) =>
	GoogleHandler.request(`/callback?${new URLSearchParams(query).toString()}`, undefined, env)

beforeEach(() => {
	completeAuthorization = vi.fn(async () => ({
		redirectTo: 'https://client.example.com/oauth/callback?code=granted',
	}))

	// Both Google calls answer successfully by default, so a test only has to say what it wants
	// to go wrong. Anything else asking for the network is a bug in the test rather than a
	// request worth answering, hence the throw.
	tokenResponse = () => Response.json({ access_token: 'google-access-token' })
	userinfoResponse = () =>
		Response.json({ id: 'google-user-1', name: 'Ada Lovelace', email: 'ada@example.com' })

	googleFetch = vi.fn(async (input: RequestInfo | URL) => {
		const url = input instanceof Request ? input.url : String(input)
		if (url.startsWith('https://accounts.google.com/o/oauth2/token')) return tokenResponse()
		if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) return userinfoResponse()
		throw new Error(`Unexpected fetch to ${url}`)
	})
	vi.stubGlobal('fetch', googleFetch)
})

describe('GET /callback', () => {
	describe('a state it cannot trust', () => {
		beforeEach(() => {
			// The base64 and JSON cases log their real reason. Silenced so a passing run stays
			// readable; the test below asserts on what that log actually carries.
			vi.spyOn(console, 'warn').mockImplementation(() => {})
		})

		// Every entry below reached `atob` or `JSON.parse` unguarded before, so each was a 500
		// anyone could produce by hand. Asserting the body as well as the status is what proves
		// the handler answered rather than Hono's onError catching a throw on its way out —
		// an escaping exception reads as 500 'Internal Server Error', not 400 'Invalid state'.
		it.each([
			['the parameter is absent', undefined],
			['the parameter is empty', ''],
			['it is not valid base64', 'not-valid-base64!!'],
			['it is base64 but not JSON', btoa('not json at all')],
			['it decodes to JSON null', btoa('null')],
			['it decodes to a bare number', btoa('7')],
			['it decodes to a bare string', btoa('"a string"')],
			['it parses but carries no clientId', btoa(JSON.stringify({ scope: ['profile'] }))],
			['its clientId is not a string', btoa(JSON.stringify({ ...authRequest, clientId: 7 }))],
			['its clientId is empty', btoa(JSON.stringify({ ...authRequest, clientId: '' }))],
		])('answers 400 when %s', async (_label, state) => {
			const response = await callback(state === undefined ? { code: 'g' } : { state, code: 'g' })

			expect(response.status).toBe(400)
			await expect(response.text()).resolves.toBe('Invalid state')
		})

		it('never reaches Google with a state it rejected', async () => {
			await callback({ state: 'not-valid-base64!!', code: 'google-code' })

			expect(googleFetch).not.toHaveBeenCalled()
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// Same split as the catch around parseAuthRequest on /authorize: the caller is
		// unauthenticated, so the reason goes to the log and the response stays a fixed string.
		// Relaying the decoder's own text would tell a prober which of the three steps it broke.
		it('logs the real decode failure without relaying it to the caller', async () => {
			const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

			const response = await callback({ state: btoa('not json at all'), code: 'google-code' })

			expect(warn).toHaveBeenCalledWith(
				'Callback state could not be decoded:',
				expect.stringMatching(/./)
			)
			await expect(response.text()).resolves.toBe('Invalid state')
		})
	})

	it('answers 400 when the code is missing', async () => {
		const response = await callback({ state: validState })

		expect(response.status).toBe(400)
		await expect(response.text()).resolves.toBe('Missing code')
		expect(googleFetch).not.toHaveBeenCalled()
	})

	describe('the Google exchange', () => {
		it('answers 500 when the token exchange fails', async () => {
			vi.spyOn(console, 'log').mockImplementation(() => {})
			tokenResponse = () => new Response('invalid_grant', { status: 400 })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(500)
			await expect(response.text()).resolves.toBe('Failed to fetch access token')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('answers 400 when Google returns no access token', async () => {
			tokenResponse = () => Response.json({ token_type: 'Bearer' })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(400)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('answers 500 when the user info request fails', async () => {
			userinfoResponse = () => new Response('token expired', { status: 401 })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(500)
			await expect(response.text()).resolves.toContain('Failed to fetch user info')
			expect(completeAuthorization).not.toHaveBeenCalled()
		})
	})

	describe('HOSTED_DOMAIN', () => {
		it('refuses a sign-in from outside the hosted domain', async () => {
			userinfoResponse = () =>
				Response.json({ id: 'google-user-2', name: 'Outsider', email: 'ada@elsewhere.com' })

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: 'example.com' })
			)

			expect(response.status).toBe(403)
			await expect(response.text()).resolves.toBe(
				'Access restricted to example.com domain users only'
			)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		// The check is `endsWith('@' + HOSTED_DOMAIN)` rather than a suffix match on the domain
		// alone, which is what keeps a lookalike domain out. Worth pinning, because dropping the
		// '@' would look like a harmless simplification and would admit both of these.
		it.each(['ada@notexample.com', 'ada@sub.example.com'])(
			'refuses %s against a hosted domain of example.com',
			async (email) => {
				userinfoResponse = () => Response.json({ id: 'google-user-3', name: 'Lookalike', email })

				const response = await callback(
					{ state: validState, code: 'google-code' },
					testEnv({ HOSTED_DOMAIN: 'example.com' })
				)

				expect(response.status).toBe(403)
			}
		)

		it('admits a sign-in from inside the hosted domain', async () => {
			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: 'example.com' })
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// A domain is case-insensitive, so neither of these should turn a permitted user away.
		// Google hands back a lowercase address in practice, which is why nobody was hitting
		// this — an access control should not rest on a habit of the identity provider's.
		it.each([
			['an address Google sent in mixed case', 'Ada@EXAMPLE.COM', 'example.com'],
			['a HOSTED_DOMAIN written in mixed case', 'ada@example.com', 'Example.COM'],
			['both sides in mixed case', 'ADA@Example.com', 'EXAMPLE.com'],
		])('admits %s', async (_label, email, hostedDomain) => {
			userinfoResponse = () => Response.json({ id: 'google-user-5', name: 'Ada', email })

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: hostedDomain })
			)

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})

		// Lowercasing must not weaken the lookalike check the block above pins.
		it('still refuses a lookalike domain when the case differs', async () => {
			userinfoResponse = () =>
				Response.json({ id: 'google-user-6', name: 'Lookalike', email: 'Ada@NOTEXAMPLE.COM' })

			const response = await callback(
				{ state: validState, code: 'google-code' },
				testEnv({ HOSTED_DOMAIN: 'Example.com' })
			)

			expect(response.status).toBe(403)
			expect(completeAuthorization).not.toHaveBeenCalled()
		})

		it('admits any domain when HOSTED_DOMAIN is unset', async () => {
			userinfoResponse = () =>
				Response.json({ id: 'google-user-4', name: 'Anyone', email: 'anyone@elsewhere.com' })

			const response = await callback({ state: validState, code: 'google-code' })

			expect(response.status).toBe(302)
			expect(completeAuthorization).toHaveBeenCalledOnce()
		})
	})

	it('completes the authorization and redirects the client back to its own callback', async () => {
		const response = await callback({ state: validState, code: 'google-code' })

		expect(completeAuthorization).toHaveBeenCalledWith({
			metadata: { label: 'Ada Lovelace' },
			props: {
				accessToken: 'google-access-token',
				email: 'ada@example.com',
				name: 'Ada Lovelace',
			},
			request: authRequest,
			scope: authRequest.scope,
			userId: 'google-user-1',
		})
		expect(response.status).toBe(302)
		expect(response.headers.get('location')).toBe(
			'https://client.example.com/oauth/callback?code=granted'
		)
	})

	// The state is unsigned, so a hand-built one the server never minted completes the flow just
	// as a genuine one does. This passing is the point: it records the CSRF property the comment
	// on the handler describes, so that binding state to a session — which #20 forces — has to
	// invert this test rather than quietly leave it passing. See that comment for why the impact
	// is bounded today.
	it('accepts a state the server never issued', async () => {
		const forged = btoa(JSON.stringify({ ...authRequest, clientId: 'someone-elses-client' }))

		const response = await callback({ state: forged, code: 'google-code' })

		expect(response.status).toBe(302)
		expect(completeAuthorization).toHaveBeenCalledOnce()
	})
})
