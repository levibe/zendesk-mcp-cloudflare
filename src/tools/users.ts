/**
 * User management tools for creating, reading, and managing end users and agents
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import {
	paginationSchema,
	sortingSchema,
	userRoleSchema,
	idSchema,
	nameSchema,
	emailSchema
} from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

// User management tools
export const usersTools: ToolDefinition[] = [
	createTool(
		'list_users',
		'List users in Zendesk',
		{
			...paginationSchema,
			role: z.string().optional().describe('Filter by user role')
		},
		async (client: ZendeskClient, params: {
      page?: number;
      per_page?: number;
      role?: string;
    }) => {
			return client.listUsers(params)
		}
	),

	createTool(
		'get_user',
		'Get a specific user by ID',
		{
			id: idSchema.describe('User ID')
		},
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getUser(id)
		}
	),

	createTool(
		'create_user',
		'Create a new user',
		{
			name: nameSchema.describe('User name'),
			email: emailSchema.describe('User email'),
			role: userRoleSchema.optional().describe('User role'),
			verified: z.boolean().optional().describe('Whether the user is verified'),
			phone: z.string().optional().describe('User phone number'),
			organization_id: z.number().optional().describe('Organization ID')
		},
		async (client: ZendeskClient, params: {
      name: string;
      email: string;
      role?: string;
      verified?: boolean;
      phone?: string;
      organization_id?: number;
    }) => {
			const userData = {
				name: params.name,
				email: params.email,
				role: params.role,
				verified: params.verified,
				phone: params.phone,
				organization_id: params.organization_id
			}

			return withCreateHandling(
				() => client.createUser(userData),
				'User'
			)()
		}
	),

	createTool(
		'search_users',
		'Search for users with user-specific filtering',
		{
			query: z.string().describe('Search query for users (e.g., name, email, or partial matches)'),
			role: userRoleSchema.optional().describe('Filter by user role'),
			verified: z.boolean().optional().describe('Filter by verification status'),
			organization_id: z.number().optional().describe('Filter by organization ID'),
			created_after: z.string().optional().describe('Filter users created after date (ISO format)'),
			created_before: z.string().optional().describe('Filter users created before date (ISO format)'),
			...sortingSchema,
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
			query: string;
			role?: string;
			verified?: boolean;
			organization_id?: number;
			created_after?: string;
			created_before?: string;
			sort_by?: string;
			sort_order?: 'asc' | 'desc';
			page?: number;
			per_page?: number;
		}) => {
			const { query } = params
			
			// Build the search query with filters
			let searchQuery = `type:user ${query}`
			
			if (params.role) searchQuery += ` role:${params.role}`
			if (params.verified !== undefined) searchQuery += ` verified:${params.verified}`
			if (params.organization_id) searchQuery += ` organization:${params.organization_id}`
			if (params.created_after) searchQuery += ` created>${params.created_after}`
			if (params.created_before) searchQuery += ` created<${params.created_before}`
			
			return executeSearchWithStandardizedResponse(
				() => client.search(searchQuery, {
					sort_by: params.sort_by,
					sort_order: params.sort_order,
					page: params.page,
					per_page: params.per_page
				}),
				'user'
			)
		}
	)
]