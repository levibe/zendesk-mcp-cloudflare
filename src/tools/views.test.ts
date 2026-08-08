/**
 * A view is the queue agents work from, and these cover what stands between a model-generated
 * payload and a live one: the schema, which makes a caller state who is offered the queue,
 * and the handlers, which force the view dormant and flatten the nested condition shape into
 * the top-level `all`/`any` Zendesk's views API takes.
 *
 * The condition grammar itself is exercised in triggers.test.ts, since views reuse the same
 * shared shapes — what is covered here is only what views do differently.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { viewsTools } from './views'
import { createViewSchema, updateViewSchema } from '../types/zendesk'
import type { ViewCreatePayload, ViewUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const createView = viewsTools.find((tool) => tool.name === 'create_view')!
const updateView = viewsTools.find((tool) => tool.name === 'update_view')!

/** What MCP validates against before a handler is ever called. */
const createPayload = z.object(createViewSchema)
const updatePayload = z.object(updateViewSchema)

/** Stands in for the two client methods, under the signatures they actually declare. */
const stubClient = (view: unknown = { view: { id: 1 } }) => ({
	createView: vi.fn(async (_data: ViewCreatePayload) => view),
	updateView: vi.fn(async (_id: number, _data: ViewUpdatePayload) => view),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (tool: typeof createView, client: StubbedClient, params: Record<string, unknown>) =>
	tool.handler(client as unknown as ZendeskClient, params)

// Conditioned on `status`, because the fixture doubles as a worked example of a payload
// Zendesk accepts: it requires at least one `all` condition testing status, type, group_id,
// assignee_id or requester_id.
const whenOpen = { all: [{ field: 'status', operator: 'less_than', value: 'solved' }] }

/** The smallest view the schema accepts, so a test can vary one thing about it. */
const validView = {
	title: 'Open tickets',
	conditions: whenOpen,
	output: { columns: ['subject', 'status'] },
	restriction: null,
}

describe('the view create schema', () => {
	// Required and nullable rather than optional, which is the point: null means every agent,
	// and a caller has to have said so. Who works a queue is not something to inherit from a
	// default.
	it('refuses a view that does not state who is offered it', () => {
		const { restriction: _omitted, ...withoutRestriction } = validView

		expect(createPayload.safeParse(withoutRestriction).success).toBe(false)
	})

	it('takes a null restriction, meaning every agent, but only when it is stated', () => {
		expect(createPayload.parse(validView).restriction).toBeNull()
	})

	it('takes a group restriction naming which groups may use the view', () => {
		const restriction = { type: 'Group', ids: [7, 9] }

		expect(createPayload.parse({ ...validView, restriction }).restriction).toEqual(restriction)
	})

	// A view restricted to a user is that person's personal view, and the only user these
	// credentials could build one for is the service account itself — a queue nobody would see.
	it('refuses a personal restriction, which only Group carries here', () => {
		const restriction = { type: 'User', ids: [7] }

		expect(createPayload.safeParse({ ...validView, restriction }).success).toBe(false)
	})

	it('refuses a view with no columns, since what a queue displays is the queue', () => {
		const result = createPayload.safeParse({ ...validView, output: { columns: [] } })

		expect(result.success).toBe(false)
	})

	// The guardrail. Neither shape accepts `active`, so a caller cannot ask for a live queue,
	// and Zod strips what it does not declare — hence absence rather than a refusal.
	it.each([
		['create', createPayload, validView],
		['update', updatePayload, {}],
	] as const)(
		'the %s shape does not accept active, so a caller cannot ask for a live view',
		(_name, payload, base) => {
			expect(payload.parse({ ...base, active: true })).not.toHaveProperty('active')
		},
	)

	it('requires conditions outright', () => {
		const { conditions: _omitted, ...withoutConditions } = validView

		expect(createPayload.safeParse(withoutConditions).success).toBe(false)
	})

	// Views get a stricter condition shape than the one the business rules share. Zendesk
	// requires `all` on a view — one condition somewhere is not enough — so a shape that
	// accepted an any-only set would promise a payload the endpoint refuses.
	it.each([
		['an any-only condition set', { any: whenOpen.all }],
		['an empty all group', { all: [] }],
	])('refuses %s, which Zendesk would reject', (_name, conditions) => {
		expect(createPayload.safeParse({ ...validView, conditions }).success).toBe(false)
	})
})

describe('create_view', () => {
	// The forced flag, which is what makes a schema that never accepts `active` add up to a
	// queue no agent is offered until a human has looked at it.
	it('forces the view dormant rather than leaving Zendesk to default it live', async () => {
		const client = stubClient()

		await call(createView, client, validView)

		expect(client.createView.mock.calls[0][0].active).toBe(false)
	})

	it('overrides an active flag that reaches it anyway', async () => {
		const client = stubClient()

		await call(createView, client, { ...validView, active: true })

		expect(client.createView.mock.calls[0][0].active).toBe(false)
	})

	// Zendesk's views API takes `all` and `any` at the top level of the view object, where the
	// tools keep them nested under `conditions` so a model reuses the trigger grammar. Both
	// arrays always travel, and a null restriction becomes omission — Zendesk documents
	// "every agent" as the property being left out, not set to null.
	it('flattens the conditions, sends both arrays, and omits the null restriction', async () => {
		const client = stubClient()

		await call(createView, client, validView)

		expect(client.createView).toHaveBeenCalledWith({
			title: 'Open tickets',
			output: { columns: ['subject', 'status'] },
			all: whenOpen.all,
			any: [],
			active: false,
		})
		expect(client.createView.mock.calls[0][0]).not.toHaveProperty('restriction')
	})

	it('sends a group restriction through as given', async () => {
		const client = stubClient()
		const restriction = { type: 'Group', ids: [7, 9] }

		await call(createView, client, { ...validView, restriction })

		expect(client.createView.mock.calls[0][0].restriction).toEqual(restriction)
	})

	it('answers with what Zendesk sent back, not with a wrapped response', async () => {
		const created = { view: { id: 42 } }

		expect(await call(createView, stubClient(created), validView)).toBe(created)
	})

	// A bare "created successfully" is what would leave a model believing agents can see it.
	it('says in its confirmation that the view is inactive', () => {
		expect(createView.successMessage).toMatch(/inactive/i)
	})
})

describe('update_view', () => {
	// The pin that matters: Zendesk replaces each condition array independently, touching only
	// the ones that arrive. A replacement set sent without `any` means "no any conditions", so
	// an empty array has to travel — sending only `all` would leave conditions the caller
	// meant to remove still matching, silently.
	it('sends both condition arrays, so the group that was dropped is cleared', async () => {
		const client = stubClient()

		await call(updateView, client, { id: 42, conditions: whenOpen })

		expect(client.updateView).toHaveBeenCalledWith(42, { all: whenOpen.all, any: [] })
	})

	it('sends a conditionless update untouched, without inventing empty groups', async () => {
		const client = stubClient()

		await call(updateView, client, { id: 42, title: 'Renamed' })

		expect(client.updateView).toHaveBeenCalledWith(42, { title: 'Renamed' })
	})

	// Zendesk accepts an update with nothing in it and changes nothing, which reads back as a
	// success. A model that sent no fields meant to send some, so say that instead.
	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(updateView, client, { id: 42 })).rejects.toThrow(
			'update_view needs at least one field to change',
		)
		expect(client.updateView).not.toHaveBeenCalled()
	})

	it('carries the confirmation registration heads the view with', () => {
		expect(updateView.successMessage).toBe('View updated successfully!')
	})
})
