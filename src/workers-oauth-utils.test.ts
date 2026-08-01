import { describe, expect, it, vi } from 'vitest'
import type { ClientInfo } from '@cloudflare/workers-oauth-provider'
import { clientIdAlreadyApproved, renderApprovalDialog } from './workers-oauth-utils'

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

/**
 * Renders the consent page the way `/authorize` does and hands back its HTML.
 *
 * Asserting on the rendered page rather than on the sanitizer directly is deliberate: what
 * matters is the attribute a browser would actually receive, and that assertion survives a
 * refactor of how the sanitizing is arranged.
 */
const renderWith = async (
	client: Partial<ClientInfo>,
	server: { name: string; logo?: string } = { name: 'Test Server' }
): Promise<string> => {
	const response = renderApprovalDialog(new Request('https://mcp.example.com/authorize'), {
		client: { clientId: 'test-client', ...client } as ClientInfo,
		server,
		state: { oauthReqInfo: { clientId: 'test-client' } },
	})

	return response.text()
}

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

// #3. These fields are rendered into `href` and `src` attributes. `sanitizeHtml` escapes
// `&<>"'`, none of which a dangerous scheme needs, so `javascript:` used to reach the page
// untouched and ran on this worker's own origin when clicked. `/register` is public and ran
// under workers-oauth-provider 0.0.5, which checked only that these were strings, and records
// written then have no TTL and are read back unvalidated — so the check has to be here at
// render time, not only at registration.
describe('renderApprovalDialog link schemes', () => {
	const dangerous = [
		['a javascript: URL', 'javascript:alert(document.cookie)'],
		['a mixed-case javascript: URL', 'JaVaScRiPt:alert(1)'],
		['a data: URL', 'data:text/html,<script>alert(1)</script>'],
		['a vbscript: URL', 'vbscript:msgbox(1)'],
		// Leading whitespace and control characters are stripped by the URL parser before the
		// scheme is read, so this parses as javascript: rather than as an unknown scheme.
		['a whitespace-padded javascript: URL', '  javascript:alert(1)'],
		['a relative path, which carries no scheme to trust', '/not-absolute'],
	] as const

	it.each(dangerous)('drops %s in clientUri', async (_label, uri) => {
		const html = await renderWith({ clientUri: uri })

		expect(html).not.toContain('javascript')
		expect(html).not.toContain('vbscript')
		expect(html).not.toContain('data:text/html')
		expect(html).not.toContain('Website:')
	})

	it.each(dangerous)('drops %s in policyUri', async (_label, uri) => {
		const html = await renderWith({ policyUri: uri })

		expect(html).not.toContain('Privacy Policy:')
	})

	it.each(dangerous)('drops %s in tosUri', async (_label, uri) => {
		const html = await renderWith({ tosUri: uri })

		expect(html).not.toContain('Terms of Service:')
	})

	it('drops a javascript: server logo rather than rendering an img src', async () => {
		const html = await renderWith({}, { name: 'Test Server', logo: 'javascript:alert(1)' })

		expect(html).not.toContain('javascript')
		expect(html).not.toContain('<img')
	})

	it('keeps http: and https: links, which are the whole point of the fields', async () => {
		const html = await renderWith({
			clientUri: 'https://example.com/app',
			policyUri: 'https://example.com/privacy',
			tosUri: 'http://example.com/terms',
		})

		expect(html).toContain('href="https://example.com/app"')
		expect(html).toContain('href="https://example.com/privacy"')
		expect(html).toContain('href="http://example.com/terms"')
	})

	it('escapes a quote an http: URL smuggles through, so it cannot end the attribute', async () => {
		// The URL parser leaves `'` alone in a path, so parsing is not on its own enough to make
		// the value safe to interpolate — it still has to be escaped afterwards.
		const html = await renderWith({ clientUri: 'https://example.com/it\'s"here' })

		expect(html).toContain('&#039;')
		expect(html).not.toContain('/it\'s"here')
	})
})
