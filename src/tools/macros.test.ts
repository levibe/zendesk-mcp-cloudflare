/**
 * `create_macro` and `update_macro` are the first tools a client can use to change anything
 * in a Zendesk instance, which makes their schema the boundary between a model-generated
 * payload and a live account. These cover what that schema turns away, and what the two
 * handlers do with what it lets through.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { macrosTools } from './macros'
import { createMacroSchema, updateMacroSchema } from '../types/zendesk'
import type { MacroCreatePayload, MacroUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const createMacro = macrosTools.find((tool) => tool.name === 'create_macro')!
const updateMacro = macrosTools.find((tool) => tool.name === 'update_macro')!

/** What MCP validates against before a handler is ever called. */
const createPayload = z.object(createMacroSchema)
const updatePayload = z.object(updateMacroSchema)

/** Stands in for the two client methods, under the signatures they actually declare. */
const stubClient = (macro: unknown = { macro: { id: 1 } }) => ({
	createMacro: vi.fn(async (_data: MacroCreatePayload) => macro),
	updateMacro: vi.fn(async (_id: number, _data: MacroUpdatePayload) => macro),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (tool: typeof createMacro, client: StubbedClient, params: Record<string, unknown>) =>
	tool.handler(client as unknown as ZendeskClient, params)

const solve = { field: 'status', value: 'solved' }

describe('the macro action schema', () => {
	it('takes a plain string, which is what most actions carry', () => {
		expect(createPayload.parse({ title: 'Solve', actions: [solve] }).actions).toEqual([solve])
	})

	// comment_value can lead with a channel, and a notification is a recipient, subject and body.
	it('takes an array of strings for the actions that carry several parts', () => {
		const comment = { field: 'comment_value', value: ['channel:web', 'Thanks for writing in.'] }

		expect(createPayload.parse({ title: 'Reply', actions: [comment] }).actions).toEqual([comment])
	})

	// comment_mode_is_public is documented as taking `true` or `false` rather than a string, and
	// it is how a macro says whether its reply is public — so a reply macro is unbuildable
	// without it, and a reply macro built in the Zendesk UI is uneditable, since `update_macro`
	// asks the caller to read the existing actions with get_macro and send them all back.
	it('takes a bare boolean, which one macro action is documented to need', () => {
		const isPublic = { field: 'comment_mode_is_public', value: true }

		expect(createPayload.parse({ title: 'Reply', actions: [isPublic] }).actions).toEqual([isPublic])
	})

	// The mismatch #13 found: `z.any()` admits undefined, so the old schema called `value`
	// required while inferring it as optional. An action with no value does nothing.
	it('turns away an action with no value at all', () => {
		const result = createPayload.safeParse({ title: 'Solve', actions: [{ field: 'status' }] })

		expect(result.success).toBe(false)
	})

	// Zendesk writes ids as strings inside an action — { field: 'group_id', value: '12345' } —
	// so a bare number is the wrong shape rather than a convenience worth accepting.
	it('turns away a numeric value', () => {
		expect(
			createPayload.safeParse({ title: 'Assign', actions: [{ field: 'group_id', value: 1 }] })
		).toMatchObject({ success: false })
	})

	it('turns away an action that names no field', () => {
		const result = createPayload.safeParse({ title: 'Solve', actions: [{ field: '', value: 'x' }] })

		expect(result.success).toBe(false)
	})
})

describe('the create schema', () => {
	it('needs a title', () => {
		expect(createPayload.safeParse({ actions: [solve] }).success).toBe(false)
	})

	it('needs a title with something in it', () => {
		expect(createPayload.safeParse({ title: '', actions: [solve] }).success).toBe(false)
	})

	// A macro that does nothing is not a macro, and Zendesk rejects one anyway.
	it('needs at least one action', () => {
		expect(createPayload.safeParse({ title: 'Empty', actions: [] }).success).toBe(false)
	})

	it('leaves the description and the active flag optional', () => {
		expect(createPayload.parse({ title: 'Solve', actions: [solve] })).toEqual({
			title: 'Solve',
			actions: [solve],
		})
	})
})

describe('the update schema', () => {
	it('requires nothing, since Zendesk changes only the fields it is given', () => {
		expect(updatePayload.parse({})).toEqual({})
	})

	it('still validates the fields it is given', () => {
		expect(updatePayload.safeParse({ actions: [{ field: 'status' }] }).success).toBe(false)
	})

	// Zendesk clears any action left out of an update, so `actions` is the one field that means
	// something different here than it does on create, and it says so in its own words. If a
	// later tidy-up collapses that override back into the shared `.partial()` shape, this is
	// what refuses — the field would go back to reading as the actions to add, and a caller
	// following that would strip every action the macro already had. Read through `unwrap`
	// because `.partial()` leaves the description on the array inside the optional.
	it('warns on actions that an update replaces the whole list', () => {
		const wording = updateMacroSchema.actions.unwrap().description

		expect(wording).toMatch(/replaces/i)
		expect(wording).not.toBe(createMacroSchema.actions.description)
	})
})

describe('create_macro', () => {
	it('sends the validated params on as the payload', async () => {
		const client = stubClient()

		await call(createMacro, client, { title: 'Solve', actions: [solve] })

		expect(client.createMacro).toHaveBeenCalledWith({ title: 'Solve', actions: [solve] })
	})

	// Returning the response rather than a finished McpToolResponse is what keeps `isError`
	// reaching the client, since registerTools wraps every handler once already. #28.
	it('answers with what Zendesk sent back, not with a wrapped response', async () => {
		const created = { macro: { id: 42, title: 'Solve' } }

		expect(await call(createMacro, stubClient(created), { title: 'Solve', actions: [solve] })).toBe(
			created
		)
	})

	// These two are the only writes a client can reach, so the confirmation they carry is the
	// only one anybody sees. It travels on the definition because the handler above must not
	// build the response that carries it — registration heads the macro with this instead.
	it('carries the confirmation registration heads the macro with', () => {
		expect(createMacro.successMessage).toBe('Macro created successfully!')
	})
})

describe('update_macro', () => {
	it('addresses the macro by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(updateMacro, client, { id: 42, title: 'Solve and thank', active: false })

		expect(client.updateMacro).toHaveBeenCalledWith(42, { title: 'Solve and thank', active: false })
	})

	it('does not put the id in the payload, where Zendesk would ignore it', async () => {
		const client = stubClient()

		await call(updateMacro, client, { id: 42, title: 'Renamed' })

		expect(client.updateMacro.mock.calls[0][1]).not.toHaveProperty('id')
	})

	// Zendesk accepts an update with nothing in it and changes nothing, which reads back as a
	// success. A model that sent no fields meant to send some, so say that instead.
	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(updateMacro, client, { id: 42 })).rejects.toThrow(
			'update_macro needs at least one field to change'
		)
		expect(client.updateMacro).not.toHaveBeenCalled()
	})

	it('carries the confirmation registration heads the macro with', () => {
		expect(updateMacro.successMessage).toBe('Macro updated successfully!')
	})
})
