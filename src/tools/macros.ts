/**
 * These two writes are the first any client is offered: macros is the one group whose shipped
 * ceiling in wrangler.jsonc is `stage` rather than `read`. A macro is inert by nature — it
 * changes nothing when created and sits in a menu until an agent deliberately applies it — so
 * `stage` is its honest level, where a trigger is only inert because its schema forces it.
 */

import { paginationSchema, idSchema, createMacroSchema, updateMacroSchema } from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { requireChanges } from '@levibe/mcp-worker/registry'

export const macrosTools: ZendeskToolDefinition[] = [
	createTool(
		'list_macros',
		'read',
		'List macros in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listMacros(params)
		},
	),

	createTool(
		'get_macro',
		'read',
		'Get a specific macro by ID',
		{ id: idSchema.describe('Macro ID') },
		async (client, { id }) => {
			return client.getMacro(id)
		},
	),

	createTool(
		'create_macro',
		'stage',
		'Create a new macro',
		createMacroSchema,
		async (client, params) => {
			return client.createMacro(params)
		},
		'Macro created successfully!',
	),

	createTool(
		'update_macro',
		'stage',
		'Update an existing macro. Any field left out keeps its current value, except that sending actions replaces the entire action list rather than adding to it.',
		{ id: idSchema.describe('Macro ID to update'), ...updateMacroSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_macro', updateMacroSchema, changes)

			return client.updateMacro(id, changes)
		},
		'Macro updated successfully!',
	),
]
