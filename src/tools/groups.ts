/**
 * Agent group management tools for organizing support agents into teams
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, nameSchema, descriptionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'

export const groupsTools: ToolDefinition[] = [
	createTool(
		'list_groups',
		'List agent groups in Zendesk',
		paginationSchema,
		async (client: ZendeskClient, params: { page?: number; per_page?: number }) => {
			return client.listGroups(params)
		}
	),

	createTool(
		'get_group',
		'Get a specific group by ID',
		{ id: idSchema.describe('Group ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getGroup(id)
		}
	),

	createTool(
		'create_group',
		'Create a new agent group',
		{
			name: nameSchema.describe('Group name'),
			description: descriptionSchema.describe('Group description')
		},
		async (client: ZendeskClient, params: { name: string; description?: string }) => {
			return withCreateHandling(() => client.createGroup(params), 'Group')()
		}
	)
]