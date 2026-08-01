import { describe, expect, it, vi } from 'vitest'
import { clientIdAlreadyApproved } from './workers-oauth-utils'

const COOKIE_NAME = 'mcp-approved-clients'
const SECRET = 'test-cookie-secret'

/**
 * Builds a correctly signed approval cookie the way the module writes one, so the happy path
 * is exercised through the same verification the malformed cases fall out of.
 *
 * The signing is duplicated here rather than reached for inside the module because it is
 * private, and because a test that computes the HMAC itself would still pass if the module
 * stopped signing at all. This one only passes when both sides agree.
 */
const signedCookie = async (approvedClients: string[]): Promise<string> => {
	const payload = JSON.stringify(approvedClients)
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(SECRET),
		{ hash: 'SHA-256', name: 'HMAC' },
		false,
		['sign']
	)
	const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload))
	const signatureHex = Array.from(new Uint8Array(signature))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('')

	return `${signatureHex}.${btoa(payload)}`
}

const requestWithCookie = (value: string): Request =>
	new Request('https://example.com/authorize', {
		headers: { Cookie: `${COOKIE_NAME}=${value}` },
	})

describe('clientIdAlreadyApproved', () => {
	it('approves a client named in a correctly signed cookie', async () => {
		const request = requestWithCookie(await signedCookie(['client-a', 'client-b']))

		await expect(clientIdAlreadyApproved(request, 'client-b', SECRET)).resolves.toBe(true)
	})

	it('does not approve a client absent from a correctly signed cookie', async () => {
		const request = requestWithCookie(await signedCookie(['client-a']))

		await expect(clientIdAlreadyApproved(request, 'client-b', SECRET)).resolves.toBe(false)
	})

	// #4. A cookie only has to look structurally right — two dot-separated parts — to reach the
	// `atob` call, and `atob` throws on anything outside the base64 alphabet. That throw used to
	// escape to Hono as a 500, and the cookie's one-year Max-Age meant every later /authorize
	// hit the same 500 until the user cleared cookies by hand. The recovery is that it now falls
	// through to the approval dialog like every other malformed cookie.
	it('recovers from a payload that is not valid base64 rather than throwing', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const request = requestWithCookie('deadbeef.not-valid-base64!!')

		await expect(clientIdAlreadyApproved(request, 'client-a', SECRET)).resolves.toBe(false)
		expect(warn).toHaveBeenCalledWith('Cookie payload is not valid base64.')
	})

	it('does not approve when the signature does not match the payload', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
		const request = requestWithCookie(`deadbeef.${btoa(JSON.stringify(['client-a']))}`)

		await expect(clientIdAlreadyApproved(request, 'client-a', SECRET)).resolves.toBe(false)
		expect(warn).toHaveBeenCalledWith('Cookie signature verification failed.')
	})

	it('does not approve when there is no cookie at all', async () => {
		const request = new Request('https://example.com/authorize')

		await expect(clientIdAlreadyApproved(request, 'client-a', SECRET)).resolves.toBe(false)
	})
})
