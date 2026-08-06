/**
 * An automation runs on a schedule against every matching ticket, including the backlog that
 * already exists when it is first enabled. Both writes ship withheld under a `read` ceiling.
 * `create_automation` declares `stage`: creation forces `active: false` and no shape here
 * accepts `active`, so it can only build a dormant rule. `update_automation` declares
 * `write`: it can rewrite an automation a human has enabled, whose next scheduled run acts
 * on everything the changed conditions now match.
 */

import {
	paginationSchema,
	idSchema,
	createAutomationSchema,
	updateAutomationSchema,
} from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { requireChanges } from '../utils/require-changes'

export const automationsTools: ZendeskToolDefinition[] = [
	createTool(
		'list_automations',
		'read',
		'List automations in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listAutomations(params)
		}
	),

	createTool(
		'get_automation',
		'read',
		'Get a specific automation by ID',
		{ id: idSchema.describe('Automation ID') },
		async (client, { id }) => {
			return client.getAutomation(id)
		}
	),

	createTool(
		'create_automation',
		'stage',
		'Create a new automation. It is created inactive and runs nothing until someone enables it in the Zendesk UI, and it cannot carry notification actions. Note that the first run of an enabled automation sweeps the existing backlog, not only new activity.',
		createAutomationSchema,
		async (client, params) => {
			return client.createAutomation({ ...params, active: false })
		},
		'Automation created successfully, and is inactive. Enable it in the Zendesk UI once you have read it back — its first run will sweep every ticket that already matches.'
	),

	createTool(
		'update_automation',
		'write',
		'Update an existing automation. Any field left out keeps its current value, except that sending conditions or actions replaces that whole set rather than adding to it. This cannot enable or disable an automation.',
		{ id: idSchema.describe('Automation ID to update'), ...updateAutomationSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_automation', updateAutomationSchema, changes)

			return client.updateAutomation(id, changes)
		},
		'Automation updated successfully!'
	),
]
