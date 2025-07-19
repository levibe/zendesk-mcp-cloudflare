/**
 * Macro management tools for creating and managing ticket action shortcuts
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, descriptionSchema, macroActionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'

export const macrosTools: ToolDefinition[] = [
	createTool(
		'list_macros',
		'List macros in Zendesk',
		paginationSchema,
		async (client: ZendeskClient, params: { page?: number; per_page?: number }) => {
			return client.listMacros(params)
		}
	),

	createTool(
		'get_macro',
		'Get a specific macro by ID',
		{ id: idSchema.describe('Macro ID') },
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getMacro(id)
		}
	),

	createTool(
		'create_macro',
		'Create a new macro',
		{
			title: z.string().describe('Macro title'),
			description: descriptionSchema.describe('Macro description'),
			actions: z.array(macroActionSchema).describe('Actions to perform when macro is applied')
		},
		async (client: ZendeskClient, params: {
      title: string;
      description?: string;
      actions: Array<{ field: string; value: any }>;
    }) => {
			return withCreateHandling(() => client.createMacro(params), 'Macro')()
		}
	)
]