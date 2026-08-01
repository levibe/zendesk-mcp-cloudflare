import { describe, expect, it } from 'vitest'
import type { ClientInfo } from '@cloudflare/workers-oauth-provider'
import { renderApprovalDialog } from './workers-oauth-utils'

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
