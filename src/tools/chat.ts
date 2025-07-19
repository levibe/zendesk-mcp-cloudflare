/**
 * Zendesk Chat tools for managing chat conversations and live chat data
 */

import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const chatTools: ToolDefinition[] = [
	createTool(
		'list_chats',
		'List Zendesk Chat conversations',
		paginationSchema,
		async (client: ZendeskClient, params: { page?: number; per_page?: number }) => {
			return client.listChats(params)
		}
	)
]