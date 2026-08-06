/**
 * A view is a saved, filtered ticket list — the queue agents actually work from — built on
 * the same condition grammar as the business rules. Both writes stay withheld while the views
 * ceiling ships at `read`. `create_view` declares `stage`, since every view it builds is
 * inactive and offered to nobody; `update_view` declares `write`, since it can re-filter an
 * active queue a team is working from right now.
 *
 * What made them safe to write ahead of that decision is the same pair of guardrails the
 * business rules carry. A view does not act, but it is where agents work, and a
 * wrongly-filtered queue misdirects a team in proportion to how much they trust it — so
 * creation forces `active: false`, no shape here accepts `active`, and showing a view to
 * agents is a human action in the Zendesk UI. Who is offered the queue has to be stated at
 * creation and cannot be changed by an update; see `createViewSchema` for both arguments.
 */

import { z } from 'zod'
import {
	paginationSchema,
	idSchema,
	createViewSchema,
	updateViewSchema,
	viewConditionsSchema,
} from '../types/zendesk'
import { createTool, type ZendeskToolDefinition } from './create-tool'
import { requireChanges } from '../utils/require-changes'

/**
 * The nested condition groups, flattened to the top-level `all`/`any` Zendesk's views API
 * takes — with both arrays always present. Zendesk replaces each array independently on
 * update, touching only the ones that arrive, so sending only what the caller mentioned
 * would leave conditions they meant to remove still matching. Sending both is what makes
 * "what arrives replaces every existing condition" true.
 */
const replaceConditions = (conditions: z.infer<typeof viewConditionsSchema>) => ({
	all: conditions.all,
	any: conditions.any ?? [],
})

export const viewsTools: ZendeskToolDefinition[] = [
	createTool(
		'list_views',
		'read',
		'List views in Zendesk',
		paginationSchema,
		async (client, params) => {
			return client.listViews(params)
		}
	),

	createTool(
		'get_view',
		'read',
		'Get a specific view by ID',
		{ id: idSchema.describe('View ID') },
		async (client, { id }) => {
			return client.getView(id)
		}
	),

	// A null restriction means every agent, and Zendesk documents that as the property being
	// omitted — so the stated-null the schema requires is translated to omission here.
	createTool(
		'create_view',
		'stage',
		'Create a new view — a saved, filtered ticket list agents work from. It is created inactive and is offered to nobody until someone activates it in the Zendesk UI.',
		createViewSchema,
		async (client, { conditions, restriction, ...rest }) => {
			return client.createView({
				...rest,
				...replaceConditions(conditions),
				...(restriction !== null && { restriction }),
				active: false,
			})
		},
		'View created successfully, and is inactive. Activate it in the Zendesk UI once you have read it back.'
	),

	createTool(
		'update_view',
		'write',
		'Update an existing view. Any field left out keeps its current value, except that sending conditions or output replaces that whole set rather than adding to it. This cannot activate or deactivate a view, and cannot change which agents it is offered to.',
		{ id: idSchema.describe('View ID to update'), ...updateViewSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_view', updateViewSchema, changes)

			const { conditions, ...rest } = changes
			return client.updateView(
				id,
				conditions !== undefined ? { ...rest, ...replaceConditions(conditions) } : rest
			)
		},
		'View updated successfully!'
	),
]
