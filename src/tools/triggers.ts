/**
 * A trigger fires on its own, on every ticket create and update that matches it, so these two
 * writes are the ones `WRITE_TOOLS_ENABLED` in utils/tool-registry deliberately does not name.
 * They are defined, type-checked and tested, and no client is offered them.
 *
 * What makes them safe to build ahead of that decision is that neither can produce a rule that
 * acts. Creation forces `active: false` and no shape here accepts `active`, so every trigger
 * these tools can build is dormant until a human enables it in the Zendesk UI.
 */

import type { ToolDefinition } from '../types/zendesk'
import {
	paginationSchema,
	idSchema,
	createTriggerSchema,
	updateTriggerSchema,
} from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const triggersTools: ToolDefinition[] = [
	createTool(
		'list_triggers',
		'List triggers in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listTriggers(params)
		}
	),

	createTool(
		'get_trigger',
		'Get a specific trigger by ID',
		{ id: idSchema.describe('Trigger ID') },
		async (client, { id }) => {
			return client.getTrigger(id)
		}
	),

	createTool(
		'create_trigger',
		'Create a new trigger. It is created inactive and fires nothing until someone enables it in the Zendesk UI, and it cannot carry notification actions.',
		createTriggerSchema,
		async (client, params) => {
			return client.createTrigger({ ...params, active: false })
		},
		'Trigger created successfully, and is inactive. Enable it in the Zendesk UI once you have read it back.'
	),

	createTool(
		'update_trigger',
		'Update an existing trigger. Any field left out keeps its current value, except that sending conditions or actions replaces that whole set rather than adding to it. This cannot enable or disable a trigger.',
		{ id: idSchema.describe('Trigger ID to update'), ...updateTriggerSchema },
		async (client, { id, ...changes }) => {
			// Zendesk accepts an empty update and changes nothing, which reads as success. Say what
			// happened instead, since a model that sent no fields meant to send some. The field
			// names come from the schema so that one added there does not need remembering here.
			if (Object.keys(changes).length === 0) {
				throw new Error(
					`update_trigger needs at least one field to change: ${Object.keys(updateTriggerSchema).join(', ')}.`
				)
			}

			return client.updateTrigger(id, changes)
		},
		'Trigger updated successfully!'
	),
]
