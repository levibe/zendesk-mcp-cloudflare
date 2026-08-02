/**
 * The ticket writes are the only handlers that reshape what they are given before sending it,
 * which is what earns them tests while the passthrough writes get none. `create_ticket` renames
 * a field, `update_ticket` decides which fields travel at all, and `delete_ticket` words its own
 * answer because a successful delete comes back empty.
 *
 * None of the three is published today — registration withholds every write but the two macro
 * ones — so these cover the payloads rather than anything a client can currently reach.
 */

import { describe, expect, it, vi } from 'vitest'
import { ticketsTools } from './tickets'
import type { ZendeskClient } from '../zendesk-client'

const createTicket = ticketsTools.find((tool) => tool.name === 'create_ticket')!
const updateTicket = ticketsTools.find((tool) => tool.name === 'update_ticket')!
const deleteTicket = ticketsTools.find((tool) => tool.name === 'delete_ticket')!

/**
 * Stands in for the three client methods, matching the arguments each takes and the order they
 * come in. The payloads are narrowed to what the handlers build rather than to what the client
 * declares, which is `any` on both — the open question #12 carries, not something to mirror here.
 */
const stubClient = (ticket: unknown = { ticket: { id: 42 } }) => ({
	createTicket: vi.fn(async (_data: Record<string, unknown>) => ticket),
	updateTicket: vi.fn(async (_id: number, _data: Record<string, unknown>) => ticket),
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

	// Every optional field is written unconditionally, so one nobody supplied rides along as
	// `undefined` rather than being left out. That is why create needs none of the guards update
	// has: the client serializes the body with JSON.stringify, which drops an undefined value, so
	// the request Zendesk receives carries only the fields that were actually set.
	it('leaves an unsupplied field undefined rather than omitting it', async () => {
		const client = stubClient()

		await call(createTicket, client, { subject: 'Printer down', comment: 'It will not print' })
		const payload = created(client)

		expect(payload).toHaveProperty('priority', undefined)
		expect(payload).toEqual({
			subject: 'Printer down',
			comment: { body: 'It will not print' },
		})
	})

	it('answers with what Zendesk sent back, for the registry to head', async () => {
		const response = { ticket: { id: 42, subject: 'Printer down' } }

		expect(
			await call(createTicket, stubClient(response), { subject: 'Printer down', comment: 'Help' })
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

	// One assertion over all eight guards, because they are eight copies of a line and the mistake
	// they invite is a copy that names the wrong field on one side — `ticketData.group_id =
	// params.assignee_id` reads correctly and silently sends the wrong value. Naming every field
	// once is what catches that, and what catches a guard someone drops.
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

	// Zendesk updates the fields it is given and leaves the rest of the ticket alone, so the eight
	// guards exist to tell "not supplied" apart from "supplied as something falsy". This is the
	// case that separates them: rewritten as a truthiness check, every guard would still pass the
	// tests above and would silently stop forwarding this one.
	it('forwards a field it was given even when the value is falsy', async () => {
		const client = stubClient()

		await call(updateTicket, client, { id: 42, subject: '' })

		expect(client.updateTicket).toHaveBeenCalledWith(42, { subject: '' })
	})

	// Pinned rather than endorsed. `update_macro` refuses an update carrying no fields, because
	// Zendesk accepts one, changes nothing, and reports success — which is not what a model that
	// forgot to send fields needs to hear. `update_ticket` has no such guard and sends the empty
	// payload. Only the macro one is reachable today, so the divergence costs nothing yet — the
	// laxer of the two is the one no client can call. If this grows a guard, invert this test.
	it('sends an empty payload when it was given nothing to change', async () => {
		const client = stubClient()

		await call(updateTicket, client, { id: 42 })

		expect(client.updateTicket).toHaveBeenCalledWith(42, {})
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
