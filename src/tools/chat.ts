/**
 * Zendesk Chat tools for managing chat conversations and live chat data
 */

import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const chatTools: ToolDefinition[] = [
	createTool(
		'list_chats',
		'List Zendesk Chat conversations',
		paginationSchema,
		async (client, params) => {
			return client.listChats(params)
		}
	),
]
