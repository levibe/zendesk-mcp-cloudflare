/**
 * Automation management tools for creating time-based automated actions
 */

import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const automationsTools: ToolDefinition[] = [
	createTool(
		'list_automations',
		'List automations in Zendesk',
		paginationSchema,
		async (client: ZendeskClient, params: { page?: number; per_page?: number }) => {
			return client.listAutomations(params)
		}
	),

	createTool(
		'get_automation',
		'Get a specific automation by ID',
		{ id: idSchema.describe('Automation ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getAutomation(id)
		}
	)
]