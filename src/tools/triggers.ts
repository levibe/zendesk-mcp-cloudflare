/**
 * A trigger fires on its own, on every ticket create and update that matches it, so both
 * writes ship withheld under the `read` ceiling until raising it is somebody's deliberate
 * decision. They are defined, type-checked and tested, and no client is offered them.
 *
 * They declare different levels, and the split is the vocabulary working as intended.
 * `create_trigger` is `stage`: creation forces `active: false` and no shape here accepts
 * `active`, so every rule it can build is dormant until a human enables it in the Zendesk UI.
 * `update_trigger` is `write`: its target may be a rule a human has already enabled, and
 * rewriting an active trigger's conditions changes what fires on live tickets immediately.
 */

import {
	paginationSchema,
	idSchema,
	createTriggerSchema,
	updateTriggerSchema,
} from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { requireChanges } from '@levibe/mcp-worker/registry'

export const triggersTools: ZendeskToolDefinition[] = [
	createTool(
		'list_triggers',
		'read',
		'List triggers in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listTriggers(params)
		},
	),

	createTool(
		'get_trigger',
		'read',
		'Get a specific trigger by ID',
		{ id: idSchema.describe('Trigger ID') },
		async (client, { id }) => {
			return client.getTrigger(id)
		},
	),

	createTool(
		'create_trigger',
		'stage',
		'Create a new trigger. It is created inactive and fires nothing until someone enables it in the Zendesk UI, and it cannot carry notification actions.',
		createTriggerSchema,
		async (client, params) => {
			return client.createTrigger({ ...params, active: false })
		},
		'Trigger created successfully, and is inactive. Enable it in the Zendesk UI once you have read it back.',
	),

	createTool(
		'update_trigger',
		'write',
		'Update an existing trigger. Any field left out keeps its current value, except that sending conditions or actions replaces that whole set rather than adding to it. This cannot enable or disable a trigger.',
		{ id: idSchema.describe('Trigger ID to update'), ...updateTriggerSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_trigger', updateTriggerSchema, changes)

			return client.updateTrigger(id, changes)
		},
		'Trigger updated successfully!',
	),
]
