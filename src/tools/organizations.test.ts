/**
 * What these pin is `domain_names` being settable at creation only. It is a membership rule
 * rather than a property — any user whose email matches a listed domain joins the
 * organization automatically — so an update that could widen it would be how a whole domain
 * of strangers ends up inside an existing organization.
 */

import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { organizationsTools } from './organizations'
import { createOrganizationSchema, updateOrganizationSchema } from '../types/zendesk'
import type { OrganizationUpdatePayload } from '../types/zendesk'
import type { ZendeskClient } from '../zendesk-client'

const updateOrganization = organizationsTools.find((tool) => tool.name === 'update_organization')!

const updatePayload = z.object(updateOrganizationSchema)

const stubClient = (organization: unknown = { organization: { id: 1 } }) => ({
	updateOrganization: vi.fn(async (_id: number, _data: OrganizationUpdatePayload) => organization),
})

type StubbedClient = ReturnType<typeof stubClient>

const call = (client: StubbedClient, params: Record<string, unknown>) =>
	updateOrganization.handler(client as unknown as ZendeskClient, params)

describe('the organization update schema', () => {
	// Zod strips what a shape does not declare, so a smuggled membership rule is absent from
	// the parsed update rather than refused — absence is the guarantee.
	it('does not accept domain_names, so an update cannot widen membership', () => {
		const parsed = updatePayload.parse({ domain_names: ['example.com'] })

		expect(parsed).not.toHaveProperty('domain_names')
	})

	// Zendesk does not document whether sending tags replaces the set or merges into it, so the
	// wording is chosen to be right either way: send them all.
	it('tells a caller to send the complete tag list', () => {
		const wording = updateOrganizationSchema.tags.description ?? ''

		expect(wording).toMatch(/complete/i)
		expect(wording).not.toBe(createOrganizationSchema.tags.description)
	})
})

describe('update_organization', () => {
	it('addresses the organization by id and sends everything else as the payload', async () => {
		const client = stubClient()

		await call(client, { id: 42, notes: 'Enterprise plan' })

		expect(client.updateOrganization).toHaveBeenCalledWith(42, { notes: 'Enterprise plan' })
	})

	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubClient()

		await expect(call(client, { id: 42 })).rejects.toThrow(
			'update_organization needs at least one field to change',
		)
		expect(client.updateOrganization).not.toHaveBeenCalled()
	})
})
