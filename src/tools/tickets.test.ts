/**
 * The ticket writes reshape what they are given before sending it, which is what earns them
 * tests: both wrap the comment string into the `{ body }` object Zendesk wants, and
 * `delete_ticket` words its own answer because a successful delete comes back empty.
 *
 * None of the three is published today — registration withholds every write but the two macro
 * ones — so these cover the payloads rather than anything a client can currently reach.
 */

import { describe, expect, it, vi } from 'vitest'
import { ticketsTools } from './tickets'
import { createTicketSchema, updateTicketSchema } from '../types/zendesk'
import type { TicketCreatePayload, TicketUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const createTicket = ticketsTools.find((tool) => tool.name === 'create_ticket')!
const updateTicket = ticketsTools.find((tool) => tool.name === 'update_ticket')!
const deleteTicket = ticketsTools.find((tool) => tool.name === 'delete_ticket')!

/** Stands in for the three client methods, under the signatures they actually declare. */
const stubClient = (ticket: unknown = { ticket: { id: 42 } }) => ({
	createTicket: vi.fn(async (_data: TicketCreatePayload) => ticket),
	updateTicket: vi.fn(async (_id: number, _data: TicketUpdatePayload) => ticket),
	deleteTicket: vi.fn(async (_id: number) => ({})),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (tool: typeof createTicket, client: StubbedClient, params: Record<string, unknown>) =>
	tool.handler(client as unknown as ZendeskClient, params)

/** What each write actually sent. `updateTicket` takes the id first, so the payload is second. */
const created = (client: StubbedClient) => client.createTicket.mock.calls[0][0]
const updated = (client: StubbedClient) => client.updateTicket.mock.calls[0][1]

describe('create_ticket', () => {
	// The one rename in the handler: the schema takes a comment as a string because that is what
	// a model has to hand, and Zendesk wants an object carrying it under `body`.
	it('wraps the comment string into the body Zendesk expects', async () => {
		const client = stubClient()

		await call(createTicket, client, { subject: 'Printer down', comment: 'It will not print' })

		expect(created(client)).toMatchObject({
			subject: 'Printer down',
			comment: { body: 'It will not print' },
		})
	})

	it('passes the optional fields it was given straight through', async () => {
		const client = stubClient()

		await call(createTicket, client, {
			subject: 'Printer down',
			comment: 'It will not print',
			priority: 'urgent',
			status: 'open',
			type: 'incident',
			assignee_id: 7,
			group_id: 9,
			requester_id: 11,
			tags: ['hardware'],
		})

		expect(created(client)).toEqual({
			subject: 'Printer down',
			comment: { body: 'It will not print' },
			priority: 'urgent',
			status: 'open',
			type: 'incident',
			assignee_id: 7,
			group_id: 9,
			requester_id: 11,
			tags: ['hardware'],
		})
	})

	// The handler spreads what it was given, and MCP's validation strips what nobody supplied,
	// so the payload never carries the field at all — there is no undefined for JSON.stringify
	// to have to drop.
	it('omits a field nobody supplied rather than sending it as undefined', async () => {
		const client = stubClient()

		await call(createTicket, client, { subject: 'Printer down', comment: 'It will not print' })
		const payload = created(client)

		expect(payload).not.toHaveProperty('priority')
		expect(payload).toEqual({
			subject: 'Printer down',
			comment: { body: 'It will not print' },
		})
	})

	it('answers with what Zendesk sent back, for the registry to head', async () => {
		const response = { ticket: { id: 42, subject: 'Printer down' } }

		expect(
			await call(createTicket, stubClient(response), { subject: 'Printer down', comment: 'Help' }),
		).toBe(response)
	})
})

describe('update_ticket', () => {
	it('addresses the ticket by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(updateTicket, client, { id: 42, status: 'solved' })

		expect(client.updateTicket).toHaveBeenCalledWith(42, { status: 'solved' })
	})

	it('does not put the id in the payload, where Zendesk would ignore it', async () => {
		const client = stubClient()

		await call(updateTicket, client, { id: 42, subject: 'Renamed' })

		expect(updated(client)).not.toHaveProperty('id')
	})

	it('passes every optional field it was given straight through', async () => {
		const client = stubClient()

		await call(updateTicket, client, {
			id: 42,
			subject: 'Renamed',
			comment: 'Following up',
			priority: 'urgent',
			status: 'open',
			assignee_id: 7,
			group_id: 9,
			type: 'incident',
			tags: ['hardware'],
		})

		expect(client.updateTicket).toHaveBeenCalledWith(42, {
			subject: 'Renamed',
			comment: { body: 'Following up' },
			priority: 'urgent',
			status: 'open',
			assignee_id: 7,
			group_id: 9,
			type: 'incident',
			tags: ['hardware'],
		})
	})

	it('wraps a new comment the way create does', async () => {
		const client = stubClient()

		await call(updateTicket, client, { id: 42, comment: 'Following up' })

		expect(client.updateTicket).toHaveBeenCalledWith(42, { comment: { body: 'Following up' } })
	})

	// Zendesk updates the fields it is given and leaves the rest of the ticket alone, so what
	// matters is that "supplied as something falsy" still travels — a truthiness check anywhere
	// in the handler would silently stop forwarding this one.
	it('forwards a field it was given even when the value is falsy', async () => {
		const client = stubClient()

		await call(updateTicket, client, { id: 42, subject: '' })

		expect(client.updateTicket).toHaveBeenCalledWith(42, { subject: '' })
	})

	// Zendesk accepts an update with nothing in it and changes nothing, which reads back as a
	// success. A model that sent no fields meant to send some, so say that instead.
	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(updateTicket, client, { id: 42 })).rejects.toThrow(
			'update_ticket needs at least one field to change',
		)
		expect(client.updateTicket).not.toHaveBeenCalled()
	})

	// Zendesk replaces a ticket's tag set with whatever an update sends, so the wording tells
	// the caller to send them all — the same pin the organization tags and article labels carry.
	it('tells a caller to send the complete tag list', () => {
		const wording = updateTicketSchema.tags.description ?? ''

		expect(wording).toMatch(/complete/i)
		expect(wording).not.toBe(createTicketSchema.tags.description)
	})
})

describe('delete_ticket', () => {
	it('names the ticket it deleted rather than reporting the empty body', async () => {
		const client = stubClient()

		expect(await call(deleteTicket, client, { id: 42 })).toBe('Ticket 42 deleted successfully!')
		expect(client.deleteTicket).toHaveBeenCalledWith(42)
	})

	// The sentence is written after the delete resolves, so a rejected one throws for the single
	// wrapper in registerTools to turn into an isError response. A handler that reported success
	// alongside the failure is exactly what #28 was about.
	it('says nothing about success when the delete failed', async () => {
		const client = stubClient()
		client.deleteTicket.mockRejectedValue(new Error('Zendesk API Error: 404 - RecordNotFound'))

		await expect(call(deleteTicket, client, { id: 42 })).rejects.toThrow('404 - RecordNotFound')
	})
})
