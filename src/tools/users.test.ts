/**
 * What these pin is the gap between the two user shapes: creation states who a user is, and
 * the update deliberately cannot restate it. `email` decides where the account's mail goes,
 * `verified` asserts a check this server never performed, and `organization_id` decides what
 * shared tickets they may see — so all three are settable at creation only, and an update
 * that smuggles one in loses it at validation rather than rewriting somebody's account.
 * `role` is held harder still: neither shape accepts it, and the create handler pins every
 * account it makes to `end-user`, since a privileged account at a caller-chosen email is a
 * takeover in one call.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { usersTools } from './users'
import { createUserSchema, updateUserSchema } from '../types/zendesk'
import type { UserCreatePayload, UserUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const createUser = usersTools.find((tool) => tool.name === 'create_user')!
const updateUser = usersTools.find((tool) => tool.name === 'update_user')!

const createPayload = z.object(createUserSchema)
const updatePayload = z.object(updateUserSchema)

const stubClient = (user: unknown = { user: { id: 1 } }) => ({
	createUser: vi.fn(async (_data: UserCreatePayload) => user),
	updateUser: vi.fn(async (_id: number, _data: UserUpdatePayload) => user),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (client: StubbedClient, params: Record<string, unknown>) =>
	updateUser.handler(client as unknown as ZendeskClient, params)

describe('the user schemas', () => {
	it.each(['name', 'email'])('creation refuses a user without %s', (field) => {
		const user = { name: 'Ada', email: 'ada@example.com' }
		const { [field]: _omitted, ...withoutField } = user as Record<string, unknown>

		expect(createPayload.safeParse(withoutField).success).toBe(false)
	})

	// The identity fields. Zod strips what a shape does not declare, so a smuggled one is
	// absent from the parsed update rather than refused — absence is the guarantee.
	it.each(['email', 'role', 'verified', 'organization_id'])(
		'the update shape does not accept %s, so an update cannot change who a user is',
		(field) => {
			expect(updatePayload.parse({ [field]: 'admin' })).not.toHaveProperty(field)
		}
	)

	// The create shape refuses `role` the same way: a caller stating one loses it at
	// validation, whatever they asked for.
	it.each(['admin', 'agent', 'end-user'])(
		'creation does not accept a caller-chosen role (%s)',
		(role) => {
			const user = { name: 'Ada', email: 'ada@example.com', role }

			expect(createPayload.parse(user)).not.toHaveProperty('role')
		}
	)
})

describe('create_user', () => {
	// The other half of the schema stripping `role`: the handler is the only place the role
	// can come from, and it always says end-user.
	it('pins every account it creates to the end-user role', async () => {
		const client = stubClient()

		await createUser.handler(client as unknown as ZendeskClient, {
			name: 'Ada',
			email: 'ada@example.com',
		})

		expect(client.createUser).toHaveBeenCalledWith({
			name: 'Ada',
			email: 'ada@example.com',
			role: 'end-user',
		})
	})
})

describe('update_user', () => {
	it('addresses the user by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(client, { id: 42, name: 'Ada Lovelace' })

		expect(client.updateUser).toHaveBeenCalledWith(42, { name: 'Ada Lovelace' })
	})

	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(client, { id: 42 })).rejects.toThrow(
			'update_user needs at least one field to change'
		)
		expect(client.updateUser).not.toHaveBeenCalled()
	})
})
