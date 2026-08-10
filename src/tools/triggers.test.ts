/**
 * A trigger fires on every ticket create and update that matches it, with nobody in the loop.
 * These cover the two things standing between a model-generated payload and a rule like that:
 * the schema, which refuses conditions and actions a trigger must not carry, and the handler,
 * which is what actually forces the rule dormant.
 *
 * The shared condition and action shapes are exercised here rather than twice, since
 * automations use the same ones — automations.test.ts covers only what differs.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { triggersTools } from './triggers'
import { createTriggerSchema, updateTriggerSchema } from '../types/zendesk'
import type { TriggerCreatePayload, TriggerUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const createTrigger = triggersTools.find((tool) => tool.name === 'create_trigger')!
const updateTrigger = triggersTools.find((tool) => tool.name === 'update_trigger')!

/** What MCP validates against before a handler is ever called. */
const createPayload = z.object(createTriggerSchema)
const updatePayload = z.object(updateTriggerSchema)

/** Stands in for the two client methods, under the signatures they actually declare. */
const stubClient = (trigger: unknown = { trigger: { id: 1 } }) => ({
	createTrigger: vi.fn(async (_data: TriggerCreatePayload) => trigger),
	updateTrigger: vi.fn(async (_id: number, _data: TriggerUpdatePayload) => trigger),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (tool: typeof createTrigger, client: StubbedClient, params: Record<string, unknown>) =>
	tool.handler(client as unknown as ZendeskClient, params)

const solve = { field: 'status', value: 'solved' }
const whenUrgent = { all: [{ field: 'priority', operator: 'is', value: 'urgent' }] }

/** The smallest trigger the schema accepts, so a test can vary one thing about it. */
const validTrigger = { title: 'Escalate', conditions: whenUrgent, actions: [solve] }

describe('the business rule action schema', () => {
	// The guardrail this issue turns on. A trigger can reach every address matching it, so the
	// actions that leave Zendesk are refused at the boundary rather than left to be noticed.
	it.each([
		'notification_user',
		'notification_group',
		'notification_target',
		'notification_webhook',
		'tweet_requester',
		'satisfaction_score',
	])('turns away the %s action, which reaches outside Zendesk', (field) => {
		const result = createPayload.safeParse({
			...validTrigger,
			actions: [{ field, value: 'anyone@example.com' }],
		})

		expect(result.success).toBe(false)
	})

	// The prefix is what carries the rule, rather than the six names above. Zendesk has named
	// every notification action `notification_*`, so one added tomorrow is refused too. If this
	// ever fails, the denylist has been flattened into a list of literals and the shape that
	// made it survive Zendesk adding an action has been lost.
	it('turns away a notification action nobody has heard of yet', () => {
		const result = createPayload.safeParse({
			...validTrigger,
			actions: [{ field: 'notification_carrier_pigeon', value: 'x' }],
		})

		expect(result.success).toBe(false)
	})

	// The refusal has to say which action to drop. A model told only that its payload was
	// invalid rewrites the whole rule, or retries the same one.
	it('names the offending action in the error, not just the payload', () => {
		const result = createPayload.safeParse({
			...validTrigger,
			actions: [solve, { field: 'notification_user', value: 'x' }],
		})

		expect(result.error?.issues[0].path).toEqual(['actions', 1, 'field'])
	})

	it('takes the ordinary field-setting actions a rule is built from', () => {
		const actions = [solve, { field: 'set_tags', value: 'escalated' }]

		expect(createPayload.parse({ ...validTrigger, actions }).actions).toEqual(actions)
	})

	it('needs at least one action, since a rule that does nothing is not a rule', () => {
		expect(createPayload.safeParse({ ...validTrigger, actions: [] }).success).toBe(false)
	})
})

describe('the business rule condition schema', () => {
	// Stricter than Zendesk, which documents conditions as optional on a trigger. A trigger with
	// none matches every create and every update there is, and it is reached by leaving a field
	// out rather than by asking for it — so the shape makes the caller say what it matches.
	it('refuses a trigger with no conditions at all', () => {
		expect(createPayload.safeParse({ title: 'Everything', actions: [solve] }).success).toBe(false)
	})

	it('refuses condition groups that are present but empty', () => {
		const result = createPayload.safeParse({
			...validTrigger,
			conditions: { all: [], any: [] },
		})

		expect(result.success).toBe(false)
	})

	it.each([
		['all', { all: [{ field: 'status', operator: 'is', value: 'open' }] }],
		['any', { any: [{ field: 'status', operator: 'is', value: 'open' }] }],
	])('accepts a rule conditioned only through %s', (_group, conditions) => {
		expect(createPayload.parse({ ...validTrigger, conditions }).conditions).toEqual(conditions)
	})

	// Zendesk documents conditions carrying neither an operator nor a value, so requiring either
	// would refuse rules it accepts.
	it('leaves the operator and the value optional', () => {
		const conditions = { all: [{ field: 'update_type' }] }

		expect(createPayload.parse({ ...validTrigger, conditions }).conditions).toEqual(conditions)
	})

	// Zendesk writes condition values as strings, hour counts included, so a bare number is the
	// wrong shape rather than a convenience. Same call as the macro action schema.
	it('turns away a numeric condition value', () => {
		const conditions = { all: [{ field: 'NEW', operator: 'greater_than', value: 24 }] }

		expect(createPayload.safeParse({ ...validTrigger, conditions }).success).toBe(false)
	})
})

describe('the create schema', () => {
	it('needs a title with something in it', () => {
		expect(createPayload.safeParse({ ...validTrigger, title: '' }).success).toBe(false)
	})

	// The whole guardrail: no shape here accepts `active`, so a model cannot ask for a live
	// trigger. Zod strips what it does not declare, which is why this asserts on absence rather
	// than on a refusal.
	it('does not accept active, so a caller cannot ask for a live trigger', () => {
		expect(createPayload.parse({ ...validTrigger, active: true })).not.toHaveProperty('active')
	})
})

describe('the update schema', () => {
	it('requires nothing, since Zendesk changes only the fields it is given', () => {
		expect(updatePayload.parse({})).toEqual({})
	})

	// The other half of the guardrail. A trigger that could be created dormant and enabled by
	// the very next call was never really dormant, so enabling one stays a human action in the
	// Zendesk UI and this server offers no way to do it.
	it('does not accept active either, so nothing here can enable a trigger', () => {
		expect(updatePayload.parse({ active: true })).not.toHaveProperty('active')
	})

	it('still refuses a notification action in the fields it is given', () => {
		const result = updatePayload.safeParse({
			actions: [{ field: 'notification_user', value: 'x' }],
		})

		expect(result.success).toBe(false)
	})

	// `.partial()` makes conditions optional; it must not make an empty one acceptable, since an
	// update replaces the whole set and would leave the trigger matching everything.
	it('still refuses an empty condition set when one is sent', () => {
		expect(updatePayload.safeParse({ conditions: { all: [] } }).success).toBe(false)
	})

	// Zendesk replaces both sets wholesale, so each says so in its own words rather than
	// inheriting create's. A caller following create's wording would strip what it did not
	// restate — and a trigger left with fewer conditions matches more tickets, not fewer. If a
	// later tidy-up collapses these back into the shared `.partial()` shape, this is what
	// refuses. Read through `unwrap` because `.partial()` leaves the description inside.
	it.each(['conditions', 'actions'] as const)(
		'warns that an update replaces the whole %s set',
		(field) => {
			const wording = updateTriggerSchema[field].unwrap().description

			expect(wording).toMatch(/replaces/i)
			expect(wording).not.toBe(createTriggerSchema[field].description)
		},
	)
})

describe('create_trigger', () => {
	// The forced flag, which is the only thing making a schema that never accepts `active` add
	// up to a dormant rule. Zendesk defaults a new trigger to active, so leaving the field out
	// would create a live one.
	it('forces the trigger inactive rather than leaving Zendesk to default it', async () => {
		const client = stubClient()

		await call(createTrigger, client, validTrigger)

		expect(client.createTrigger).toHaveBeenCalledWith({ ...validTrigger, active: false })
	})

	// Belt and braces against the schema being loosened later: even handed `active: true`
	// directly, the handler overrides it rather than passing it on.
	it('overrides an active flag that reaches it anyway', async () => {
		const client = stubClient()

		await call(createTrigger, client, { ...validTrigger, active: true })

		expect(client.createTrigger.mock.calls[0][0].active).toBe(false)
	})

	// Returning the response rather than a finished McpToolResponse is what keeps `isError`
	// reaching the client, since registerTools wraps every handler once already. #28.
	it('answers with what Zendesk sent back, not with a wrapped response', async () => {
		const created = { trigger: { id: 42 } }

		expect(await call(createTrigger, stubClient(created), validTrigger)).toBe(created)
	})

	// The confirmation has to say the trigger is not running, because a bare "created
	// successfully" is what would leave a model believing the rule is live.
	it('says in its confirmation that the trigger is not yet live', () => {
		expect(createTrigger.successMessage).toMatch(/inactive/i)
	})
})

describe('update_trigger', () => {
	it('addresses the trigger by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(updateTrigger, client, { id: 42, title: 'Renamed' })

		expect(client.updateTrigger).toHaveBeenCalledWith(42, { title: 'Renamed' })
	})

	it('does not put the id in the payload, where Zendesk would ignore it', async () => {
		const client = stubClient()

		await call(updateTrigger, client, { id: 42, title: 'Renamed' })

		expect(client.updateTrigger.mock.calls[0][1]).not.toHaveProperty('id')
	})

	// Zendesk accepts an update with nothing in it and changes nothing, which reads back as a
	// success. A model that sent no fields meant to send some, so say that instead.
	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(updateTrigger, client, { id: 42 })).rejects.toThrow(
			'update_trigger needs at least one field to change',
		)
		expect(client.updateTrigger).not.toHaveBeenCalled()
	})

	it('carries the confirmation registration heads the trigger with', () => {
		expect(updateTrigger.successMessage).toBe('Trigger updated successfully!')
	})
})
