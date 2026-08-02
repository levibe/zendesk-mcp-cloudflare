/**
 * These two writes are the first any client is offered. `WRITE_TOOLS_ENABLED` in
 * utils/tool-registry is where that decision lives, and says why a macro is safe to publish
 * when a trigger and an automation are not.
 */

import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, createMacroSchema, updateMacroSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { requireChanges } from '../utils/require-changes'

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
		createMacroSchema,
		async (client, params) => {
			return client.createMacro(params)
		},
		'Macro created successfully!'
	),

	createTool(
		'update_macro',
		'Update an existing macro. Any field left out keeps its current value, except that sending actions replaces the entire action list rather than adding to it.',
		{ id: idSchema.describe('Macro ID to update'), ...updateMacroSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_macro', updateMacroSchema, changes)

			return client.updateMacro(id, changes)
		},
		'Macro updated successfully!'
	),
]
