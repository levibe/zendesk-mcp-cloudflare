import { z } from 'zod'
import type { ToolDefinition } from '../types/zendesk'
import {
	paginationSchema,
	sortingSchema,
	idSchema,
	createOrganizationSchema,
	updateOrganizationSchema,
} from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { requireChanges } from '../utils/require-changes'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

export const organizationsTools: ToolDefinition[] = [
	createTool(
		'list_organizations',
		'List organizations in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listOrganizations(params)
		}
	),

	createTool(
		'get_organization',
		'Get a specific organization by ID',
		{ id: idSchema.describe('Organization ID') },
		async (client, { id }) => {
			return client.getOrganization(id)
		}
	),

	// Withheld by `WRITE_TOOLS_ENABLED` in utils/tool-registry. `domain_names` is settable at
	// creation only, because it is a membership rule rather than a property — see
	// `createOrganizationSchema` for that argument.
	createTool(
		'create_organization',
		'Create a new organization',
		createOrganizationSchema,
		async (client, params) => {
			return client.createOrganization(params)
		},
		'Organization created successfully!'
	),

	createTool(
		'update_organization',
		"Update an existing organization. Any field left out keeps its current value, except that sending tags replaces the whole set. This cannot change the organization's domain names, which decide automatic membership and are managed in the Zendesk UI.",
		{ id: idSchema.describe('Organization ID to update'), ...updateOrganizationSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_organization', updateOrganizationSchema, changes)

			return client.updateOrganization(id, changes)
		},
		'Organization updated successfully!'
	),

	createTool(
		'search_organizations',
		'Search for organizations with organization-specific filtering',
		{
			query: z.string().describe('Search query for organizations (e.g., company name, domain)'),
			domain: z.string().optional().describe('Filter by organization domain'),
			created_after: z
				.string()
				.optional()
				.describe('Filter organizations created after date (ISO format)'),
			created_before: z
				.string()
				.optional()
				.describe('Filter organizations created before date (ISO format)'),
			...sortingSchema,
			...paginationSchema,
		},
		async (client, params) => {
			const { query } = params

			let searchQuery = `type:organization ${query}`

			if (params.domain) searchQuery += ` domain:${params.domain}`
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
				'organization'
			)
		}
	),
]
