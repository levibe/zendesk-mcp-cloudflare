/**
 * Help Center tools for managing knowledge base articles, categories, and sections
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, sortingSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const helpCenterTools: ToolDefinition[] = [
	createTool(
		'list_articles',
		'List Help Center articles',
		{
			...paginationSchema,
			...sortingSchema
		},
		async (client: ZendeskClient, params: {
      page?: number;
      per_page?: number;
      sort_by?: string;
      sort_order?: 'asc' | 'desc';
    }) => {
			return client.listArticles(params)
		}
	),

	createTool(
		'get_article',
		'Get a specific Help Center article by ID',
		{ id: idSchema.describe('Article ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getArticle(id)
		}
	),

	createTool(
		'search_articles',
		'Search Help Center articles',
		{
			query: z.string().describe('Search query'),
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
      query: string;
      page?: number;
      per_page?: number;
    }) => {
			const { query, ...searchParams } = params
			return client.searchArticles({ query, ...searchParams })
		}
	)
]