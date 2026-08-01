/**
 * Shared TypeScript types for Zendesk MCP Server
 */

import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'

// MCP Response Types
export interface McpToolResponse {
	[x: string]: unknown
	content: Array<{
		type: 'text'
		text: string
	}>
	isError?: boolean
}

/**
 * The parameters a handler receives, derived from its own Zod schema.
 *
 * This is the same helper the MCP SDK applies to a tool's schema, so the type a handler
 * declares is exactly what the server will hand it at runtime — optional fields included,
 * since `objectOutputType` marks a key optional when its schema accepts `undefined`.
 */
export type InferParams<S extends z.ZodRawShape> = z.objectOutputType<S, z.ZodTypeAny>

/**
 * A registered tool, with its parameter type deliberately erased.
 *
 * Tools have differing parameter shapes but have to share one array, so the shape cannot
 * survive into this interface. `createTool` is what keeps the guarantee: it checks each
 * handler against its own schema before widening it to fit here.
 */
export interface ToolDefinition {
	name: string
	description: string
	schema: z.ZodRawShape
	handler: (client: ZendeskClient, params: Record<string, unknown>) => Promise<unknown>
}

// Common Pagination Parameters
export const paginationSchema = {
	page: z.number().optional().describe('Page number for pagination'),
	per_page: z.number().optional().describe('Number of items per page (max 100)'),
}

// Common Sorting Parameters
export const sortingSchema = {
	sort_by: z.string().optional().describe('Field to sort by'),
	sort_order: z.enum(['asc', 'desc']).optional().describe('Sort order (asc or desc)'),
}

// Zendesk Entity Types
export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low'
export type TicketStatus = 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed'
export type TicketType = 'problem' | 'incident' | 'question' | 'task'
export type UserRole = 'end-user' | 'agent' | 'admin'

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
	value: z.any().describe('Value to set'),
})

// Search Response Types
export interface SearchResponseMetadata {
	total_count?: number
	page_info?: {
		current_page?: number
		per_page?: number
		has_next_page?: boolean
		has_previous_page?: boolean
	}
	error?: string
	errorType?: string
	errorCause?: string
	duration?: number
}

export interface StandardizedSearchResult {
	result_type: string
	id?: number
	[key: string]: unknown
}

export interface StandardizedSearchResponse {
	results: StandardizedSearchResult[]
	metadata: SearchResponseMetadata
	count?: number
	next_page?: string | null
	previous_page?: string | null
}
