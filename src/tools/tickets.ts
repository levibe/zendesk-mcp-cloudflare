/**
 * Ticket management tools for creating, reading, updating, and deleting support tickets
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import {
	paginationSchema,
	sortingSchema,
	ticketPrioritySchema,
	ticketStatusSchema,
	ticketTypeSchema,
	idSchema,
	tagsSchema
} from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { withCreateHandling } from '../utils/error-handling'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'

// Ticket management tools
export const ticketsTools: ToolDefinition[] = [
	createTool(
		'list_tickets',
		'List tickets in Zendesk',
		{
			...paginationSchema,
			...sortingSchema
		},
		async (client: ZendeskClient, params: {
      page?: number;
      per_page?: number;
      sort_by?: string;
      sort_order?: 'asc' | 'desc';
    }) => {
			return client.listTickets(params)
		}
	),

	createTool(
		'get_ticket',
		'Get a specific ticket by ID',
		{
			id: idSchema.describe('Ticket ID')
		},
		async (client: ZendeskClient, { id }: { id: number }) => {
			return client.getTicket(id)
		}
	),

	createTool(
		'create_ticket',
		'Create a new ticket',
		{
			subject: z.string().describe('Ticket subject'),
			comment: z.string().describe('Ticket comment/description'),
			priority: ticketPrioritySchema.optional().describe('Ticket priority'),
			status: ticketStatusSchema.optional().describe('Ticket status'),
			requester_id: z.number().optional().describe('User ID of the requester'),
			assignee_id: z.number().optional().describe('User ID of the assignee'),
			group_id: z.number().optional().describe('Group ID for the ticket'),
			type: ticketTypeSchema.optional().describe('Ticket type'),
			tags: tagsSchema.describe('Tags for the ticket')
		},
		async (client: ZendeskClient, params: {
      subject: string;
      comment: string;
      priority?: string;
      status?: string;
      requester_id?: number;
      assignee_id?: number;
      group_id?: number;
      type?: string;
      tags?: string[];
    }) => {
			const ticketData = {
				subject: params.subject,
				comment: { body: params.comment },
				priority: params.priority,
				status: params.status,
				requester_id: params.requester_id,
				assignee_id: params.assignee_id,
				group_id: params.group_id,
				type: params.type,
				tags: params.tags
			}

			return withCreateHandling(
				() => client.createTicket(ticketData),
				'Ticket'
			)()
		}
	),

	createTool(
		'search_tickets',
		'Search specifically for tickets with ticket-focused parameters',
		{
			query: z.string().describe('Search query for tickets (e.g., "urgent", "billing issue", "bug")'),
			status: ticketStatusSchema.optional().describe('Filter by ticket status'),
			priority: ticketPrioritySchema.optional().describe('Filter by ticket priority'),
			type: ticketTypeSchema.optional().describe('Filter by ticket type'),
			assignee_id: z.number().optional().describe('Filter by assignee user ID'),
			requester_id: z.number().optional().describe('Filter by requester user ID'),
			group_id: z.number().optional().describe('Filter by group ID'),
			created_after: z.string().optional().describe('Filter tickets created after date (ISO format)'),
			created_before: z.string().optional().describe('Filter tickets created before date (ISO format)'),
			...sortingSchema,
			...paginationSchema
		},
		async (client: ZendeskClient, params: {
			query: string;
			status?: string;
			priority?: string;
			type?: string;
			assignee_id?: number;
			requester_id?: number;
			group_id?: number;
			created_after?: string;
			created_before?: string;
			sort_by?: string;
			sort_order?: 'asc' | 'desc';
			page?: number;
			per_page?: number;
		}) => {
			const { query } = params
			
			// Build the search query with filters
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
				() => client.search(searchQuery, {
					sort_by: params.sort_by,
					sort_order: params.sort_order,
					page: params.page,
					per_page: params.per_page
				}),
				'ticket'
			)
		}
	),

	/* DISABLED FOR SECURITY - update_ticket tool
	createTool(
		'update_ticket',
		'Update an existing ticket',
		{
			id: idSchema.describe('Ticket ID to update'),
			subject: z.string().optional().describe('Updated ticket subject'),
			comment: z.string().optional().describe('New comment to add'),
			priority: ticketPrioritySchema.optional().describe('Updated ticket priority'),
			status: ticketStatusSchema.optional().describe('Updated ticket status'),
			assignee_id: z.number().optional().describe('User ID of the new assignee'),
			group_id: z.number().optional().describe('New group ID for the ticket'),
			type: ticketTypeSchema.optional().describe('Updated ticket type'),
			tags: tagsSchema.describe('Updated tags for the ticket')
		},
		async (client: ZendeskClient, params: {
      id: number;
      subject?: string;
      comment?: string;
      priority?: string;
      status?: string;
      assignee_id?: number;
      group_id?: number;
      type?: string;
      tags?: string[];
    }) => {
			const ticketData: any = {}

			if (params.subject !== undefined) ticketData.subject = params.subject
			if (params.comment !== undefined) ticketData.comment = { body: params.comment }
			if (params.priority !== undefined) ticketData.priority = params.priority
			if (params.status !== undefined) ticketData.status = params.status
			if (params.assignee_id !== undefined) ticketData.assignee_id = params.assignee_id
			if (params.group_id !== undefined) ticketData.group_id = params.group_id
			if (params.type !== undefined) ticketData.type = params.type
			if (params.tags !== undefined) ticketData.tags = params.tags

			return withUpdateHandling(
				() => client.updateTicket(params.id, ticketData),
				'Ticket'
			)()
		}
	),
	*/

	/* DISABLED FOR SECURITY - delete_ticket tool
	createTool(
		'delete_ticket',
		'Delete a ticket',
		{
			id: idSchema.describe('Ticket ID to delete')
		},
		async (client: ZendeskClient, { id }: { id: number }) => {
			return withDeleteHandling(
				() => client.deleteTicket(id),
				'Ticket',
				id
			)()
		}
	)
	*/
]