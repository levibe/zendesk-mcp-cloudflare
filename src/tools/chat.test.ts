/**
 * `list_chats` hands its response straight to `JSON.stringify` and has no behaviour to lose, so
 * what is worth pinning here is the shape rather than the passthrough.
 *
 * The bug in #67 was that the tool advertised `page` and `per_page` and Chat read neither, which
 * no test could have caught by exercising the handler — the arguments went out and were ignored,
 * and the call succeeded. It is only visible in what the tool declares, so that is what these
 * assert.
 */

import { describe, expect, it, vi } from 'vitest'
import { chatTools } from './chat'
import { paginationSchema } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const listChats = chatTools.find((tool) => tool.name === 'list_chats')!

describe('list_chats', () => {
	// Named individually rather than as "the schema is empty", so that adding a parameter Chat
	// does read stays possible while putting these two back has to be deliberate.
	it.each(Object.keys(paginationSchema))('does not advertise %s', (field) => {
		expect(Object.keys(listChats.schema)).not.toContain(field)
	})

	// The other half of the same fact. A tool could declare nothing and still forward a params
	// object it built itself, which would leave the endpoint receiving arguments no caller could
	// see — the original bug with the advertising removed rather than the sending.
	it('sends no query parameters to Chat', async () => {
		const client = { listChats: vi.fn(async () => ({ chats: [] })) }

		await listChats.handler(client as unknown as ZendeskClient, {})

		expect(client.listChats).toHaveBeenCalledWith()
	})
})
