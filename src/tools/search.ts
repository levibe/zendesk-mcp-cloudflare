/**
 * Search tools for searching across Zendesk data
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { sortingSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const searchTools: ToolDefinition[] = [
	createTool(
		'search',
		'Search across Zendesk data',
		{
			query: z.string().describe('Search query'),
			...sortingSchema,
			page: z.number().optional().describe('Page number for pagination')
		},
		async (client: ZendeskClient, params: {
      query: string;
      sort_by?: string;
      sort_order?: 'asc' | 'desc';
      page?: number;
    }) => {
			const { query, ...searchParams } = params
			return client.search(query, searchParams)
		}
	)
]