import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, createGroupSchema, updateGroupSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { requireChanges } from '../utils/require-changes'

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

	// Withheld by `WRITE_TOOLS_ENABLED` in utils/tool-registry, like every write that is not
	// named there.
	createTool(
		'create_group',
		'Create a new agent group',
		createGroupSchema,
		async (client, params) => {
			return client.createGroup(params)
		},
		'Group created successfully!'
	),

	createTool(
		'update_group',
		'Update an existing agent group. Any field left out keeps its current value.',
		{ id: idSchema.describe('Group ID to update'), ...updateGroupSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_group', updateGroupSchema, changes)

			return client.updateGroup(id, changes)
		},
		'Group updated successfully!'
	),
]
