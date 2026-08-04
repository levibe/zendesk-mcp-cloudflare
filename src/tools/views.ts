/**
 * A view is a saved, filtered ticket list — the queue agents actually work from — built on
 * the same condition grammar as the business rules. The two writes here are withheld by
 * `WRITE_TOOLS_ENABLED` in utils/tool-registry until someone publishes them deliberately.
 *
 * What made them safe to write ahead of that decision is the same pair of guardrails the
 * business rules carry. A view does not act, but it is where agents work, and a
 * wrongly-filtered queue misdirects a team in proportion to how much they trust it — so
 * creation forces `active: false`, no shape here accepts `active`, and showing a view to
 * agents is a human action in the Zendesk UI. Who is offered the queue has to be stated at
 * creation and cannot be changed by an update; see `createViewSchema` for both arguments.
 */

import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, idSchema, createViewSchema, updateViewSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { requireChanges } from '../utils/require-changes'

export const viewsTools: ToolDefinition[] = [
	createTool('list_views', 'List views in Zendesk', paginationSchema, async (client, params) => {
		return client.listViews(params)
	}),

	createTool(
		'get_view',
		'Get a specific view by ID',
		{ id: idSchema.describe('View ID') },
		async (client, { id }) => {
			return client.getView(id)
		}
	),

	// Both handlers flatten `conditions` into the top-level `all`/`any` Zendesk's views API
	// takes, so a model keeps the one nested condition shape it learned from the triggers.
	createTool(
		'create_view',
		'Create a new view — a saved, filtered ticket list agents work from. It is created inactive and is offered to nobody until someone activates it in the Zendesk UI.',
		createViewSchema,
		async (client, { conditions, ...rest }) => {
			return client.createView({ ...rest, ...conditions, active: false })
		},
		'View created successfully, and is inactive. Activate it in the Zendesk UI once you have read it back.'
	),

	createTool(
		'update_view',
		'Update an existing view. Any field left out keeps its current value, except that sending conditions or output replaces that whole set rather than adding to it. This cannot activate or deactivate a view, and cannot change which agents it is offered to.',
		{ id: idSchema.describe('View ID to update'), ...updateViewSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_view', updateViewSchema, changes)

			const { conditions, ...rest } = changes
			return client.updateView(id, conditions ? { ...rest, ...conditions } : rest)
		},
		'View updated successfully!'
	),
]
