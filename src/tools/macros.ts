/**
 * Macro management tools for creating and managing ticket action shortcuts
 */

import { z } from 'zod'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, descriptionSchema, macroActionSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'

export const macrosTools: ToolDefinition[] = [
	createTool('list_macros', 'List macros in Zendesk', paginationSchema, async (client, params) => {
		return client.listMacros(params)
	}),

	createTool(
		'get_macro',
		'Get a specific macro by ID',
		{ id: idSchema.describe('Macro ID') },
		async (client, { id }) => {
			return client.getMacro(id)
		}
	),

	createTool(
		'create_macro',
		'Create a new macro',
		{
			title: z.string().describe('Macro title'),
			description: descriptionSchema.describe('Macro description'),
			actions: z.array(macroActionSchema).describe('Actions to perform when macro is applied'),
		},
		async (client, params) => {
			return withCreateHandling(() => client.createMacro(params), 'Macro')()
		}
	),
]
