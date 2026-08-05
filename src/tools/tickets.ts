import { z } from 'zod'
import type { ToolDefinition } from '../types/zendesk'
import {
	paginationSchema,
	sortingSchema,
	ticketPrioritySchema,
	ticketStatusSchema,
	ticketTypeSchema,
	idSchema,
	createTicketSchema,
	updateTicketSchema,
} from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { requireChanges } from '../utils/require-changes'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

export const ticketsTools: ToolDefinition[] = [
	createTool(
		'list_tickets',
		'List tickets in Zendesk',
		{
			...paginationSchema,
			...sortingSchema,
		},
		async (client, params) => {
			return client.listTickets(params)
		}
	),

	createTool(
		'get_ticket',
		'Get a specific ticket by ID',
		{
			id: idSchema.describe('Ticket ID'),
		},
		async (client, { id }) => {
			return client.getTicket(id)
		}
	),

	// The one reshaping either ticket write does: the schema takes the comment as a string,
	// because that is what a model has to hand, and Zendesk wants it wrapped as `{ body }`.
	createTool(
		'create_ticket',
		'Create a new ticket',
		createTicketSchema,
		async (client, { comment, ...rest }) => {
			return client.createTicket({ ...rest, comment: { body: comment } })
		},
		'Ticket created successfully!'
	),

	createTool(
		'search_tickets',
		'Search specifically for tickets with ticket-focused parameters',
		{
			query: z
				.string()
				.describe('Search query for tickets (e.g., "urgent", "billing issue", "bug")'),
			status: ticketStatusSchema.optional().describe('Filter by ticket status'),
			priority: ticketPrioritySchema.optional().describe('Filter by ticket priority'),
			type: ticketTypeSchema.optional().describe('Filter by ticket type'),
			assignee_id: z.number().optional().describe('Filter by assignee user ID'),
			requester_id: z.number().optional().describe('Filter by requester user ID'),
			group_id: z.number().optional().describe('Filter by group ID'),
			created_after: z
				.string()
				.optional()
				.describe('Filter tickets created after date (ISO format)'),
			created_before: z
				.string()
				.optional()
				.describe('Filter tickets created before date (ISO format)'),
			...sortingSchema,
			...paginationSchema,
		},
		async (client, params) => {
			const { query } = params

			let searchQuery = `type:ticket ${query}`

			if (params.status) searchQuery += ` status:${params.status}`
			if (params.priority) searchQuery += ` priority:${params.priority}`
			if (params.type) searchQuery += ` ticket_type:${params.type}`
			if (params.assignee_id) searchQuery += ` assignee:${params.assignee_id}`
			if (params.requester_id) searchQuery += ` requester:${params.requester_id}`
			if (params.group_id) searchQuery += ` group:${params.group_id}`
			if (params.created_after) searchQuery += ` created>${params.created_after}`
			if (params.created_before) searchQuery += ` created<${params.created_before}`

			return executeSearchWithStandardizedResponse(
				() =>
					client.search(searchQuery, {
						sort_by: params.sort_by,
						sort_order: params.sort_order,
						page: params.page,
						per_page: params.per_page,
					}),
				'ticket'
			)
		}
	),

	createTool(
		'update_ticket',
		'Update an existing ticket. Any field left out keeps its current value.',
		{ id: idSchema.describe('Ticket ID to update'), ...updateTicketSchema },
		async (client, { id, ...changes }) => {
			requireChanges('update_ticket', updateTicketSchema, changes)

			const { comment, ...rest } = changes
			return client.updateTicket(
				id,
				comment !== undefined ? { ...rest, comment: { body: comment } } : rest
			)
		},
		'Ticket updated successfully!'
	),

	createTool(
		'delete_ticket',
		'Delete a ticket',
		{
			id: idSchema.describe('Ticket ID to delete'),
		},
		// The one write with nothing to report: a successful delete comes back empty, so there is
		// no record for a `successMessage` to head. Wording the whole answer as a string is how a
		// handler says something a heading cannot — this one names the id it deleted.
		async (client, { id }) => {
			await client.deleteTicket(id)
			return `Ticket ${id} deleted successfully!`
		}
	),
]
