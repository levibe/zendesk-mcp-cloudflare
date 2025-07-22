/**
 * Help Center tools for managing knowledge base articles, categories, and sections
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, sortingSchema, idSchema, nameSchema, descriptionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

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
		'Search knowledge base articles and help content',
		{
			query: z.string().describe('Search query for articles (e.g., "password reset", "billing")'),
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
      query: string;
      page?: number;
      per_page?: number;
    }) => {
			const { query, ...searchParams } = params
			return executeSearchWithStandardizedResponse(
				() => client.searchArticles({ query, ...searchParams }),
				'article'
			)
		}
	),

	// === CATEGORY TOOLS ===
	createTool(
		'list_categories',
		'List Help Center categories to understand content hierarchy',
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
			return client.listCategories(params)
		}
	),

	createTool(
		'get_category',
		'Get a specific Help Center category by ID',
		{ id: idSchema.describe('Category ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getCategory(id)
		}
	),

	createTool(
		'search_categories',
		'Search Help Center categories to explore content organization',
		{
			query: z.string().describe('Search query for categories (e.g., "billing", "technical")'),
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
			query: string;
			page?: number;
			per_page?: number;
		}) => {
			// Use general search with type filter for categories
			return executeSearchWithStandardizedResponse(
				() => client.search(`type:topic ${params.query}`, {
					page: params.page,
					per_page: params.per_page
				}),
				'category'
			)
		}
	),

	// === SECTION TOOLS ===
	createTool(
		'list_sections',
		'List Help Center sections (optionally filtered by category)',
		{
			category_id: z.number().optional().describe('Filter sections by category ID'),
			...paginationSchema,
			...sortingSchema
		},
		async (client: ZendeskClient, params: {
			category_id?: number;
			page?: number;
			per_page?: number;
			sort_by?: string;
			sort_order?: 'asc' | 'desc';
		}) => {
			if (params.category_id) {
				const { category_id, ...otherParams } = params
				return client.listSectionsByCategory(category_id, otherParams)
			}
			return client.listSections(params)
		}
	),

	createTool(
		'get_section',
		'Get a specific Help Center section by ID',
		{ id: idSchema.describe('Section ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getSection(id)
		}
	),

	createTool(
		'search_sections',
		'Search Help Center sections to find specific content areas',
		{
			query: z.string().describe('Search query for sections (e.g., "getting started", "troubleshooting")'),
			category_id: z.number().optional().describe('Limit search to specific category'),
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
			query: string;
			category_id?: number;
			page?: number;
			per_page?: number;
		}) => {
			// Build search query
			let searchQuery = `type:topic ${params.query}`
			if (params.category_id) {
				searchQuery += ` category:${params.category_id}`
			}

			return executeSearchWithStandardizedResponse(
				() => client.search(searchQuery, {
					page: params.page,
					per_page: params.per_page
				}),
				'section'
			)
		}
	),

	// === HIERARCHY NAVIGATION TOOLS ===
	createTool(
		'get_help_center_hierarchy',
		'Get the complete Help Center content hierarchy (categories > sections > articles)',
		{
			include_articles: z.boolean().optional().describe('Include articles in the hierarchy (default: false)'),
			category_id: z.number().optional().describe('Limit to specific category')
		},
		async (client: ZendeskClient, params: {
			include_articles?: boolean;
			category_id?: number;
		}) => {
			try {
				// Get categories
				const categoriesResponse = params.category_id
					? await client.getCategory(params.category_id)
					: await client.listCategories()

				const categories = params.category_id
					? [categoriesResponse.category]
					: categoriesResponse.categories || []

				const hierarchy = await Promise.all(
					categories.map(async (category: any) => {
						// Get sections for this category
						const sectionsResponse = await client.listSectionsByCategory(category.id)
						const sections = sectionsResponse.sections || []

						const sectionsWithArticles = params.include_articles
							? await Promise.all(
									sections.map(async (section: any) => {
										const articlesResponse = await client.listArticlesBySection(section.id)
										return {
											...section,
											articles: articlesResponse.articles || []
										}
									})
								)
							: sections

						return {
							...category,
							sections: sectionsWithArticles
						}
					})
				)

				return {
					hierarchy,
					total_categories: hierarchy.length,
					total_sections: hierarchy.reduce((sum, cat) => sum + cat.sections.length, 0),
					...(params.include_articles && {
						total_articles: hierarchy.reduce(
							(sum, cat) => sum + cat.sections.reduce((secSum: number, sec: any) => secSum + (sec.articles?.length || 0), 0),
							0
						)
					})
				}
			} catch (error) {
				return { error: 'Failed to fetch Help Center hierarchy', details: error }
			}
		}
	),

	createTool(
		'list_articles_by_section',
		'List articles within a specific Help Center section',
		{
			section_id: idSchema.describe('Section ID'),
			...paginationSchema,
			...sortingSchema
		},
		async (client: ZendeskClient, params: {
			section_id: number;
			page?: number;
			per_page?: number;
			sort_by?: string;
			sort_order?: 'asc' | 'desc';
		}) => {
			const { section_id, ...otherParams } = params
			return client.listArticlesBySection(section_id, otherParams)
		}
	)
]