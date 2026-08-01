/**
 * Agent group management tools for organizing support agents into teams
 */

import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, nameSchema, descriptionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'

export const groupsTools: ToolDefinition[] = [
	createTool(
		'list_groups',
		'List agent groups in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listGroups(params)
		}
	),

	createTool(
		'get_group',
		'Get a specific group by ID',
		{ id: idSchema.describe('Group ID') },
		async (client, { id }) => {
			return client.getGroup(id)
		}
	),

	createTool(
		'create_group',
		'Create a new agent group',
		{
			name: nameSchema.describe('Group name'),
			description: descriptionSchema.describe('Group description'),
		},
		async (client, params) => {
			return withCreateHandling(() => client.createGroup(params), 'Group')()
		}
	),
]
