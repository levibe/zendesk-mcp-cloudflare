/**
 * Macro management tools for creating and managing ticket action shortcuts
 *
 * These two writes are the first any client is offered. A macro is safe to let through on
 * its own because it does nothing until an agent picks it from a menu and applies it to a
 * ticket by hand — unlike a trigger, which fires on every matching update, or an automation,
 * which runs on a schedule. See WRITE_TOOLS_ENABLED in utils/tool-registry.
 */

import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, createMacroSchema, updateMacroSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

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
			// Zendesk accepts an empty update and changes nothing, which reads as success. Say
			// what happened instead, since a model that sent no fields meant to send some. The
			// field names come from the schema for the same reason the schema is derived: one
			// added there should not need remembering here.
			if (Object.keys(changes).length === 0) {
				throw new Error(
					`update_macro needs at least one field to change: ${Object.keys(updateMacroSchema).join(', ')}.`
				)
			}

			return client.updateMacro(id, changes)
		},
		'Macro updated successfully!'
	),
]
