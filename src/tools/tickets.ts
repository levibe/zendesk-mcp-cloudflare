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
import { withDeleteHandling, withCreateHandling, withUpdateHandling } from '../utils/error-handling'

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