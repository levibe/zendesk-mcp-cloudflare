/**
 * Organization management tools for creating and managing customer organizations
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, nameSchema, tagsSchema, descriptionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withDeleteHandling, withCreateHandling, withUpdateHandling } from '../utils/error-handling'

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
	)
]