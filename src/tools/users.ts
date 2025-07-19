/**
 * User management tools for creating, reading, and managing end users and agents
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import {
	paginationSchema,
	userRoleSchema,
	idSchema,
	nameSchema,
	emailSchema
} from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'

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
	)
]