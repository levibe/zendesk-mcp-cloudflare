import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const automationsTools: ToolDefinition[] = [
	createTool(
		'list_automations',
		'List automations in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listAutomations(params)
		}
	),

	createTool(
		'get_automation',
		'Get a specific automation by ID',
		{ id: idSchema.describe('Automation ID') },
		async (client, { id }) => {
			return client.getAutomation(id)
		}
	),
]
