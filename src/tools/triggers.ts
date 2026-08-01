/**
 * Trigger automation tools for creating event-driven automated actions
 */

import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const triggersTools: ToolDefinition[] = [
	createTool(
		'list_triggers',
		'List triggers in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listTriggers(params)
		}
	),

	createTool(
		'get_trigger',
		'Get a specific trigger by ID',
		{ id: idSchema.describe('Trigger ID') },
		async (client, { id }) => {
			return client.getTrigger(id)
		}
	),
]
