import { z } from 'zod'
import { paginationSchema, sortingSchema } from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

export const searchTools: ZendeskToolDefinition[] = [
	createTool(
		'search',
		'read',
		'Search tickets, users, organizations and other Zendesk content',
		{
			query: z.string().describe('Search query string (e.g., "urgent ticket", "user@example.com")'),
			type: z
				.enum(['ticket', 'user', 'organization', 'group', 'topic', 'forum'])
				.optional()
				.describe('Filter results by object type'),
			...sortingSchema,
			// Spread rather than declared here. This tool used to carry its own `page` and no
			// `per_page` at all, which meant the one tool named `search` was the one search tool
			// that took neither the shared bounds nor a page size — so `page: 0` and `page: 2.7`
			// travelled to Zendesk unexamined while every sibling refused them.
			...paginationSchema,
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
