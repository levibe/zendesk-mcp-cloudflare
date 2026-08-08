import { z } from 'zod'
import {
	paginationSchema,
	sortingSchema,
	userRoleSchema,
	idSchema,
	createUserSchema,
	updateUserSchema,
} from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { requireChanges } from '@levibe/mcp-worker/registry'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

export const usersTools: ZendeskToolDefinition[] = [
	createTool(
		'list_users',
		'read',
		'List users in Zendesk',
		{
			...paginationSchema,
			role: z.string().optional().describe('Filter by user role'),
		},
		async (client, params) => {
			return client.listUsers(params)
		},
	),

	createTool(
		'get_user',
		'read',
		'Get a specific user by ID',
		{
			id: idSchema.describe('User ID'),
		},
		async (client, { id }) => {
			return client.getUser(id)
		},
	),

	// Declared `write`, not `stage`: the account it makes is live the moment the call returns.
	// Withheld while the users ceiling ships at `read`. Who a user is — their email, verified
	// state and organization — is settable at creation only, and every account this server
	// creates is an end-user; see `createUserSchema` for both arguments.
	createTool(
		'create_user',
		'write',
		'Create a new end-user — a customer tickets can be filed for. Agent and admin accounts stay a human action in the Zendesk UI.',
		createUserSchema,
		async (client, params) => {
			return client.createUser({ ...params, role: 'end-user' })
		},
		'User created successfully!',
	),

	createTool(
		'update_user',
		'write',
		"Update an existing user's profile fields — their name or phone. This cannot change a user's email, role, verified state or organization — email, verified state and organization are set at creation, and role stays managed in the Zendesk UI.",
		{ id: idSchema.describe('User ID to update'), ...updateUserSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_user', updateUserSchema, changes)

			return client.updateUser(id, changes)
		},
		'User updated successfully!',
	),

	createTool(
		'search_users',
		'read',
		'Search for users with user-specific filtering',
		{
			query: z.string().describe('Search query for users (e.g., name, email, or partial matches)'),
			role: userRoleSchema.optional().describe('Filter by user role'),
			verified: z.boolean().optional().describe('Filter by verification status'),
			organization_id: z.number().optional().describe('Filter by organization ID'),
			created_after: z.string().optional().describe('Filter users created after date (ISO format)'),
			created_before: z
				.string()
				.optional()
				.describe('Filter users created before date (ISO format)'),
			...sortingSchema,
			...paginationSchema,
		},
		async (client, params) => {
			const { query } = params

			let searchQuery = `type:user ${query}`

			if (params.role) searchQuery += ` role:${params.role}`
			if (params.verified !== undefined) searchQuery += ` verified:${params.verified}`
			if (params.organization_id) searchQuery += ` organization:${params.organization_id}`
			if (params.created_after) searchQuery += ` created>${params.created_after}`
			if (params.created_before) searchQuery += ` created<${params.created_before}`

			return executeSearchWithStandardizedResponse(
				() =>
					client.search(searchQuery, {
						sort_by: params.sort_by,
						sort_order: params.sort_order,
						page: params.page,
						per_page: params.per_page,
					}),
				'user',
			)
		},
	),
]
