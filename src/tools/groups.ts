import { paginationSchema, idSchema, createGroupSchema, updateGroupSchema } from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { requireChanges } from '@levibe/mcp-worker/registry'

export const groupsTools: ZendeskToolDefinition[] = [
	createTool(
		'list_groups',
		'read',
		'List agent groups in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listGroups(params)
		},
	),

	createTool(
		'get_group',
		'read',
		'Get a specific group by ID',
		{ id: idSchema.describe('Group ID') },
		async (client, { id }) => {
			return client.getGroup(id)
		},
	),

	// Declared `write` — an agent group is live routing the moment it exists — and withheld
	// while its ceiling ships at `read`.
	createTool(
		'create_group',
		'write',
		'Create a new agent group',
		createGroupSchema,
		async (client, params) => {
			return client.createGroup(params)
		},
		'Group created successfully!',
	),

	createTool(
		'update_group',
		'write',
		'Update an existing agent group. Any field left out keeps its current value.',
		{ id: idSchema.describe('Group ID to update'), ...updateGroupSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_group', updateGroupSchema, changes)

			return client.updateGroup(id, changes)
		},
		'Group updated successfully!',
	),
]
