/**
 * View management tools for creating and managing ticket filtering views
 */

import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const viewsTools: ToolDefinition[] = [
	createTool(
		'list_views',
		'List views in Zendesk',
		paginationSchema,
		async (client: ZendeskClient, params: { page?: number; per_page?: number }) => {
			return client.listViews(params)
		}
	),

	createTool(
		'get_view',
		'Get a specific view by ID',
		{ id: idSchema.describe('View ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getView(id)
		}
	)
]