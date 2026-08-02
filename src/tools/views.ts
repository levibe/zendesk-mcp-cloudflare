import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const viewsTools: ToolDefinition[] = [
	createTool('list_views', 'List views in Zendesk', paginationSchema, async (client, params) => {
		return client.listViews(params)
	}),

	createTool(
		'get_view',
		'Get a specific view by ID',
		{ id: idSchema.describe('View ID') },
		async (client, { id }) => {
			return client.getView(id)
		}
	),
]
