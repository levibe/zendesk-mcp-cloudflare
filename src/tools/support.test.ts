/**
 * `support_info` is the tool someone calls to find out whether the server is configured, so the
 * only property worth pinning is that it asks Zendesk. It previously returned a fixed sentence,
 * which meant it answered successfully on a worker holding no credentials at all — the one
 * circumstance it exists to reveal. This drives the handler the way the registry does, against a
 * stubbed fetch, and asserts on the request that leaves rather than on what the handler returns.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supportTools } from './support'
import { ZendeskClient } from '../zendesk-client'

const supportInfo = supportTools.find((tool) => tool.name === 'support_info')!

const credentials = {
	subdomain: 'example',
	email: 'agent@example.com',
	apiToken: 'secret-token',
}

let client: ZendeskClient

beforeEach(() => {
	// The constructor warns when credentials are missing, which these supply; silenced so a
	// future change to that path does not start printing through the suite.
	vi.spyOn(console, 'warn').mockImplementation(() => {})
	client = new ZendeskClient(credentials)
})

describe('support_info', () => {
	it('asks Zendesk who the credentials authenticate as', async () => {
		// Typed with the arguments the client actually passes, so the URL assertion below can read
		// call zero without casting. `vi.stubGlobal` takes the mock untyped either way.
		const fetchMock = vi.fn(
			async (_url: string, _init: RequestInit) =>
				new Response(JSON.stringify({ user: { id: 1, email: credentials.email } }), {
					headers: { 'content-type': 'application/json' },
				})
		)
		vi.stubGlobal('fetch', fetchMock)

		const result = await supportInfo.handler(client, {})

		expect(fetchMock).toHaveBeenCalledOnce()
		expect(fetchMock.mock.calls[0][0]).toBe('https://example.zendesk.com/api/v2/users/me.json')
		expect(result).toEqual({ user: { id: 1, email: credentials.email } })
	})

	// The regression that matters. A handler that resolves without touching fetch is exactly the
	// shape of the old hardcoded string, and it reports a broken deployment as a healthy one.
	it('fails when the credentials are rejected, rather than reporting success', async () => {
		const fetchMock = vi.fn(
			async () => new Response('{"error":"Couldn\'t authenticate you"}', { status: 401 })
		)
		vi.stubGlobal('fetch', fetchMock)

		await expect(supportInfo.handler(client, {})).rejects.toThrow(/401/)
		expect(fetchMock).toHaveBeenCalledOnce()
	})
})
