/**
 * The group writes carry no shape decision of their own — name and description, nothing
 * sharper — so all there is to pin is the empty-update guard being wired in.
 */

import { describe, expect, it, vi } from 'vitest'
import { groupsTools } from './groups'
import type { GroupUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const updateGroup = groupsTools.find((tool) => tool.name === 'update_group')!

const stubClient = (group: unknown = { group: { id: 1 } }) => ({
	updateGroup: vi.fn(async (_id: number, _data: GroupUpdatePayload) => group),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (client: StubbedClient, params: Record<string, unknown>) =>
	updateGroup.handler(client as unknown as ZendeskClient, params)

describe('update_group', () => {
	it('addresses the group by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(client, { id: 42, name: 'Tier 2' })

		expect(client.updateGroup).toHaveBeenCalledWith(42, { name: 'Tier 2' })
	})

	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(client, { id: 42 })).rejects.toThrow(
			'update_group needs at least one field to change',
		)
		expect(client.updateGroup).not.toHaveBeenCalled()
	})
})
