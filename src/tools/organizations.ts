/**
 * Organization management tools for creating and managing customer organizations
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, sortingSchema, idSchema, nameSchema, tagsSchema, descriptionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

export const organizationsTools: ToolDefinition[] = [
	createTool(
		'list_organizations',
		'List organizations in Zendesk',
		paginationSchema,
		async (client: ZendeskClient, params: { page?: number; per_page?: number }) => {
			return client.listOrganizations(params)
		}
	),

	createTool(
		'get_organization',
		'Get a specific organization by ID',
		{ id: idSchema.describe('Organization ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getOrganization(id)
		}
	),

	createTool(
		'create_organization',
		'Create a new organization',
		{
			name: nameSchema.describe('Organization name'),
			domain_names: z.array(z.string()).optional().describe('Domain names for the organization'),
			details: descriptionSchema.describe('Details about the organization'),
			notes: z.string().optional().describe('Notes about the organization'),
			tags: tagsSchema.describe('Tags for the organization')
		},
		async (client: ZendeskClient, params: {
      name: string;
      domain_names?: string[];
      details?: string;
      notes?: string;
      tags?: string[];
    }) => {
			return withCreateHandling(() => client.createOrganization(params), 'Organization')()
		}
	),

	createTool(
		'search_organizations',
		'Search for organizations with organization-specific filtering',
		{
			query: z.string().describe('Search query for organizations (e.g., company name, domain)'),
			domain: z.string().optional().describe('Filter by organization domain'),
			created_after: z.string().optional().describe('Filter organizations created after date (ISO format)'),
			created_before: z.string().optional().describe('Filter organizations created before date (ISO format)'),
			...sortingSchema,
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
			query: string;
			domain?: string;
			created_after?: string;
			created_before?: string;
			sort_by?: string;
			sort_order?: 'asc' | 'desc';
			page?: number;
			per_page?: number;
		}) => {
			const { query } = params
			
			// Build the search query with filters
			let searchQuery = `type:organization ${query}`
			
			if (params.domain) searchQuery += ` domain:${params.domain}`
			if (params.created_after) searchQuery += ` created>${params.created_after}`
			if (params.created_before) searchQuery += ` created<${params.created_before}`
			
			return executeSearchWithStandardizedResponse(
				() => client.search(searchQuery, {
					sort_by: params.sort_by,
					sort_order: params.sort_order,
					page: params.page,
					per_page: params.per_page
				}),
				'organization'
			)
		}
	)
]