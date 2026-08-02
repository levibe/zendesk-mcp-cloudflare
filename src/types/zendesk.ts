import { z } from 'zod'
import type { ZendeskClient } from '../zendesk-client'

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
 * Wrapping the shape and inferring through it is what the SDK itself does for a raw shape, so
 * the type a handler declares is exactly what the server will hand it at runtime — optional
 * fields included, since inference marks a key optional when its schema accepts `undefined`.
 */
export type InferParams<S extends z.ZodRawShape> = z.infer<z.ZodObject<S>>

/**
 * A registered tool, with its parameter type deliberately erased.
 *
 * Tools have differing parameter shapes but have to share one array, so the shape cannot
 * survive into this interface. `createTool` is what keeps the guarantee: it checks each
 * handler against its own schema before widening it to fit here.
 *
 * `successMessage` is how a write tool gets its worded confirmation without building a response
 * of its own — see `withErrorHandling` for why that matters.
 */
export interface ToolDefinition {
	name: string
	description: string
	schema: z.ZodRawShape
	handler: (client: ZendeskClient, params: Record<string, unknown>) => Promise<unknown>
	successMessage?: string
}

/**
 * The pagination arguments every list and search tool spreads.
 *
 * The ceiling on `per_page` is Zendesk's rather than a preference of ours. Everything reached
 * through this shape — the Support list endpoints, the Search API and the Help Center ones —
 * stops at a hundred records a page, and `list_chats` reaches an API that pages by a different
 * parameter and ignores this one either way. So a caller asking for a thousand was never going
 * to be sent a thousand; it only left the model reading a page of a size it had not chosen and
 * drawing conclusions from it. The bound is checked here so that the refusal names the argument
 * and the model can correct itself, which is more than it can do with whatever Zendesk decides
 * to make of a number it does not honour.
 *
 * Both bounds are `.int()` because these are record counts. A fractional `per_page` is a caller
 * having computed something rather than having decided something, and it reaches Zendesk as a
 * query string that gets parsed however that endpoint happens to parse it.
 *
 * Do not raise the hundred to serve an incremental export tool. Those endpoints take up to a
 * thousand, but they are a different pagination scheme with its own cursor parameters, so one
 * needs a shape of its own rather than a loosening of the bound every other tool sits behind.
 */
export const paginationSchema = {
	page: z.number().int().min(1).optional().describe('Page number for pagination, starting at 1'),
	per_page: z
		.number()
		.int()
		.min(1)
		.max(100)
		.optional()
		.describe('Number of items per page (1-100)'),
}

export const sortingSchema = {
	sort_by: z.string().optional().describe('Field to sort by'),
	sort_order: z.enum(['asc', 'desc']).optional().describe('Sort order (asc or desc)'),
}

export type TicketPriority = 'urgent' | 'high' | 'normal' | 'low'
export type TicketStatus = 'new' | 'open' | 'pending' | 'hold' | 'solved' | 'closed'
export type TicketType = 'problem' | 'incident' | 'question' | 'task'
export type UserRole = 'end-user' | 'agent' | 'admin'

export const ticketPrioritySchema = z.enum(['urgent', 'high', 'normal', 'low'])
export const ticketStatusSchema = z.enum(['new', 'open', 'pending', 'hold', 'solved', 'closed'])
export const ticketTypeSchema = z.enum(['problem', 'incident', 'question', 'task'])
export const userRoleSchema = z.enum(['end-user', 'agent', 'admin'])

export const idSchema = z.number().describe('ID')
export const tagsSchema = z.array(z.string()).optional().describe('Tags')
export const nameSchema = z.string().describe('Name')
export const emailSchema = z.string().describe('Email address')
export const descriptionSchema = z.string().optional().describe('Description')

/**
 * A single thing a macro does when an agent applies it.
 *
 * Zendesk writes an action's value one of three ways, and the union is exactly those three.
 * Almost always a string, including for numeric ids — `{ field: 'group_id', value: '12345' }`.
 * An array of strings for the actions carrying more than one part, where `comment_value` can
 * lead with a channel and a notification is a recipient, a subject and a body. And a bare
 * boolean for `comment_mode_is_public`, the one action documented as taking `true` or
 * `false` rather than a string, which is how a macro decides whether its reply is public.
 *
 * A number is left out deliberately, since no documented action takes one, and it is the
 * shape a caller reaches for when it should have sent an id as a string.
 *
 * `z.any()` was survivable here while no client could reach a macro write. This is now the
 * validation boundary between a model-generated payload and a live Zendesk instance, and
 * `z.any()` validates nothing. It also made `value` optional in the inferred type, since
 * `any` admits `undefined` — an action with no value is not something Zendesk can carry
 * out, so it is required rather than optional by accident.
 */
export const macroActionSchema = z.object({
	field: z
		.string()
		.min(1)
		.describe('Field the action changes, e.g. status, priority, comment_value'),
	value: z
		.union([z.string(), z.boolean(), z.array(z.string())])
		.describe(
			'Value to set: usually a string, an array of strings for actions taking several parts, or a boolean for comment_mode_is_public'
		),
})

/**
 * The fields a macro write may set, declared once for every layer that needs them.
 *
 * `create_macro` registers this shape as its schema, `update_macro` registers the same
 * fields with nothing required, and the client's payload types are inferred from both. So
 * the arguments MCP validates and the payload the client accepts cannot describe different
 * things, and neither is written a second time against Zendesk's documentation. This is the
 * schema-derived option #12 weighs, getting its first real test on macros.
 *
 * `id` is deliberately absent. It addresses the macro in the URL rather than travelling in
 * the body, so `update_macro` adds it to its own schema and the payload type stays exactly
 * the set of fields that can be written.
 */
export const createMacroSchema = {
	title: z.string().min(1).describe('Macro title'),
	description: descriptionSchema.describe('Macro description'),
	actions: z
		.array(macroActionSchema)
		.min(1)
		.describe('Actions to perform when the macro is applied'),
	active: z.boolean().optional().describe('Whether agents can see and apply the macro'),
}

/**
 * The same fields with nothing required, because Zendesk updates what it is given and leaves
 * the rest of the macro alone. Deriving this with `.partial()` rather than restating the
 * fields means a field added above cannot be forgotten here.
 *
 * `actions` is the exception, and it is the one field whose meaning genuinely differs at
 * update time. Zendesk's own documentation: "Updating an action updates the containing array,
 * clearing the other actions. Include all your actions when updating any action." Inheriting
 * create's wording would leave it reading as the actions to add, and a caller acting on that
 * would silently strip every action the macro already had. Only the sentence is replaced —
 * the array and its `min(1)` still come from the shape above.
 */
export const updateMacroSchema = {
	...z.object(createMacroSchema).partial().shape,
	actions: createMacroSchema.actions
		.describe(
			"The macro's complete action list, which replaces the existing one. Zendesk drops any action left out, so read the macro with get_macro first and send all of its actions rather than only the new ones"
		)
		.optional(),
}

export type MacroCreatePayload = InferParams<typeof createMacroSchema>
export type MacroUpdatePayload = InferParams<typeof updateMacroSchema>

/**
 * What `support_info` answers with.
 *
 * Every field is nullable because the whole point of the tool is to be called when something
 * is wrong, and a response that came back malformed should still say what it could read
 * rather than throwing on the way to reporting a problem.
 */
export interface SupportInfo {
	/** The host Zendesk actually answered from, which is what proves the subdomain is right. */
	account: string | null
	user: {
		id: number | null
		name: string | null
		email: string | null
		role: string | null
		active: boolean | null
		suspended: boolean | null
	}
}

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
