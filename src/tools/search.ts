import { z } from 'zod'
import type { ToolDefinition } from '../types/zendesk'
import { sortingSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

export const searchTools: ToolDefinition[] = [
	createTool(
		'search',
		'Search tickets, users, organizations and other Zendesk content',
		{
			query: z.string().describe('Search query string (e.g., "urgent ticket", "user@example.com")'),
			type: z
				.enum(['ticket', 'user', 'organization', 'group', 'topic', 'forum'])
				.optional()
				.describe('Filter results by object type'),
			...sortingSchema,
			page: z.number().optional().describe('Page number for pagination (default: 1)'),
		},
		async (client, params) => {
			const { query, type, ...searchParams } = params

			let searchQuery = query
			if (type) {
				searchQuery = `type:${type} ${query}`
			}

			return executeSearchWithStandardizedResponse(
				() => client.search(searchQuery, searchParams),
				type || 'mixed'
			)
		}
	),
]
