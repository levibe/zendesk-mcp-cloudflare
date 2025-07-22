/**
 * Shared TypeScript types for Zendesk MCP Server
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'

// MCP Response Types
export interface McpToolResponse {
  [x: string]: unknown;
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
}

// Tool Definition Interface
export interface ToolDefinition {
  name: string;
  description: string;
  schema: Record<string, z.ZodTypeAny>;
  handler: (client: ZendeskClient, params: any) => Promise<any>;
}

// Common Pagination Parameters
export const paginationSchema = {
	page: z.number().optional().describe('Page number for pagination'),
	per_page: z.number().optional().describe('Number of items per page (max 100)')
}

// Common Sorting Parameters
export const sortingSchema = {
	sort_by: z.string().optional().describe('Field to sort by'),
	sort_order: z.enum(['asc', 'desc']).optional().describe('Sort order (asc or desc)')
}

// Zendesk Entity Types
export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low';
export type TicketStatus = 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed';
export type TicketType = 'problem' | 'incident' | 'question' | 'task';
export type UserRole = 'end-user' | 'agent' | 'admin';

// Schema Definitions for reuse
export const ticketPrioritySchema = z.enum(['urgent', 'high', 'normal', 'low'])
export const ticketStatusSchema = z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed'])
export const ticketTypeSchema = z.enum(['problem', 'incident', 'question', 'task'])
export const userRoleSchema = z.enum(['end-user', 'agent', 'admin'])

// Common field schemas
export const idSchema = z.number().describe('ID')
export const tagsSchema = z.array(z.string()).optional().describe('Tags')
export const nameSchema = z.string().describe('Name')
export const emailSchema = z.string().describe('Email address')
export const descriptionSchema = z.string().optional().describe('Description')

// Macro action schema
export const macroActionSchema = z.object({
	field: z.string().describe('Field to modify'),
	value: z.any().describe('Value to set')
})

// Tool Handler Type
export type ToolHandler<T = any> = (client: ZendeskClient, params: T) => Promise<any>;

// Search Response Types
export interface SearchResponseMetadata {
	total_count?: number
	page_info?: {
		current_page?: number
		per_page?: number
		has_next_page?: boolean
		has_previous_page?: boolean
	}
}

export interface StandardizedSearchResult {
	result_type: string
	id?: number
	[key: string]: any
}

export interface StandardizedSearchResponse {
	results: StandardizedSearchResult[]
	metadata: SearchResponseMetadata
	count?: number
	next_page?: string | null
	previous_page?: string | null
}