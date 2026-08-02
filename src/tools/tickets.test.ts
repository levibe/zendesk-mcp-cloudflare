/**
 * `delete_ticket` is the one tool that words its whole answer instead of handing back a record,
 * because a successful delete comes back empty and there is nothing for a `successMessage` to
 * head. What it says, and that it only says it once the delete has actually happened, is the
 * whole of its behaviour — and it is what the deleted `withDeleteHandling` used to do.
 */

import { describe, expect, it, vi } from 'vitest'
import { ticketsTools } from './tickets'
import type { ZendeskClient } from '../zendesk-client'

const deleteTicket = ticketsTools.find((tool) => tool.name === 'delete_ticket')!

const stubClient = (deleteTicketImpl: () => Promise<unknown>) =>
	({ deleteTicket: vi.fn(deleteTicketImpl) }) as unknown as ZendeskClient & {
		deleteTicket: ReturnType<typeof vi.fn>
	}

describe('delete_ticket', () => {
	it('names the ticket it deleted rather than reporting the empty body', async () => {
		const client = stubClient(async () => ({}))

		expect(await deleteTicket.handler(client, { id: 42 })).toBe('Ticket 42 deleted successfully!')
		expect(client.deleteTicket).toHaveBeenCalledWith(42)
	})

	// The sentence is written after the delete resolves, so a rejected one throws for the single
	// wrapper in registerTools to turn into an isError response. A handler that reported success
	// alongside the failure is exactly what #28 was about.
	it('says nothing about success when the delete failed', async () => {
		const client = stubClient(async () => {
			throw new Error('Zendesk API Error: 404 - RecordNotFound')
		})

		await expect(deleteTicket.handler(client, { id: 42 })).rejects.toThrow('404 - RecordNotFound')
	})
})
