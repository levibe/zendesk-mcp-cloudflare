/**
 * Automations share their condition and action shapes with triggers, so what those shapes
 * refuse is covered once in triggers.test.ts rather than twice here. This covers what an
 * automation does differently: it carries no description and no category, its first run sweeps
 * the backlog rather than only new activity, and its confirmation has to say so.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { automationsTools } from './automations'
import { createAutomationSchema, updateAutomationSchema } from '../types/zendesk'
import type { AutomationCreatePayload, AutomationUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const createAutomation = automationsTools.find((tool) => tool.name === 'create_automation')!
const updateAutomation = automationsTools.find((tool) => tool.name === 'update_automation')!

const createPayload = z.object(createAutomationSchema)
const updatePayload = z.object(updateAutomationSchema)

const stubClient = (automation: unknown = { automation: { id: 1 } }) => ({
	createAutomation: vi.fn(async (_data: AutomationCreatePayload) => automation),
	updateAutomation: vi.fn(async (_id: number, _data: AutomationUpdatePayload) => automation),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (
	tool: typeof createAutomation,
	client: StubbedClient,
	params: Record<string, unknown>,
) => tool.handler(client as unknown as ZendeskClient, params)

/** Pending for 24 hours, then closed — the shape of nearly every real automation. */
const validAutomation = {
	title: 'Close stale pending tickets',
	conditions: { all: [{ field: 'PENDING', operator: 'greater_than', value: '24' }] },
	actions: [{ field: 'status', value: 'closed' }],
}

describe('the create schema', () => {
	it('takes a time-based condition and the action that undoes it', () => {
		expect(createPayload.parse(validAutomation)).toEqual(validAutomation)
	})

	// Zendesk requires a time-based condition, and this deliberately does not check for one. The
	// check would mean holding Zendesk's list of time fields in this repo and refusing anything
	// absent from it, so a field Zendesk added would read as our rejection rather than theirs.
	// The rule is named in the schema's own description instead, where the model that has to
	// satisfy it will read it. Inverting this test is the way to change that decision.
	it('lets a rule with no time condition through for Zendesk to refuse', () => {
		const noTimeCondition = {
			...validAutomation,
			conditions: { all: [{ field: 'status', operator: 'is', value: 'pending' }] },
		}

		expect(createPayload.safeParse(noTimeCondition).success).toBe(true)
	})

	// The description is doing the work the schema chose not to, so it has to actually name the
	// rule and the group the condition belongs in.
	it('names the time-based requirement where a model will read it', () => {
		const wording = createAutomationSchema.conditions.description ?? ''

		expect(wording).toMatch(/time-based/i)
		expect(wording).toMatch(/\ball\b/)
	})

	it('does not accept active, so a caller cannot ask for a live automation', () => {
		expect(createPayload.parse({ ...validAutomation, active: true })).not.toHaveProperty('active')
	})

	// An automation has neither, unlike a trigger, so accepting them would offer a model two
	// fields Zendesk silently drops.
	it.each(['description', 'category_id'])(
		'does not accept %s, which an automation does not have',
		(field) => {
			expect(createPayload.parse({ ...validAutomation, [field]: 'x' })).not.toHaveProperty(field)
		},
	)
})

describe('the update schema', () => {
	it('requires nothing, since Zendesk changes only the fields it is given', () => {
		expect(updatePayload.parse({})).toEqual({})
	})

	it('does not accept active either, so nothing here can enable an automation', () => {
		expect(updatePayload.parse({ active: true })).not.toHaveProperty('active')
	})

	it.each(['conditions', 'actions'] as const)(
		'warns that an update replaces the whole %s set',
		(field) => {
			const wording = updateAutomationSchema[field].unwrap().description

			expect(wording).toMatch(/replaces/i)
			expect(wording).not.toBe(createAutomationSchema[field].description)
		},
	)
})

describe('create_automation', () => {
	it('forces the automation inactive rather than leaving Zendesk to default it', async () => {
		const client = stubClient()

		await call(createAutomation, client, validAutomation)

		expect(client.createAutomation).toHaveBeenCalledWith({ ...validAutomation, active: false })
	})

	it('overrides an active flag that reaches it anyway', async () => {
		const client = stubClient()

		await call(createAutomation, client, { ...validAutomation, active: true })

		expect(client.createAutomation.mock.calls[0][0].active).toBe(false)
	})

	it('answers with what Zendesk sent back, not with a wrapped response', async () => {
		const created = { automation: { id: 42 } }

		expect(await call(createAutomation, stubClient(created), validAutomation)).toBe(created)
	})

	// The sweep is the thing a model would not guess and a human would not expect. Enabling an
	// automation does not only govern what happens next; its first run acts on every ticket that
	// already matches, which on a real instance is the backlog.
	it('warns in its confirmation that enabling it sweeps the existing backlog', () => {
		expect(createAutomation.successMessage).toMatch(/inactive/i)
		expect(createAutomation.successMessage).toMatch(/already match/i)
	})
})

describe('update_automation', () => {
	it('addresses the automation by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(updateAutomation, client, { id: 42, title: 'Renamed' })

		expect(client.updateAutomation).toHaveBeenCalledWith(42, { title: 'Renamed' })
	})

	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(updateAutomation, client, { id: 42 })).rejects.toThrow(
			'update_automation needs at least one field to change',
		)
		expect(client.updateAutomation).not.toHaveBeenCalled()
	})

	it('carries the confirmation registration heads the automation with', () => {
		expect(updateAutomation.successMessage).toBe('Automation updated successfully!')
	})
})
