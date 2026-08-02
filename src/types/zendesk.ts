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
 * stops at a hundred records a page. So a caller asking for a thousand was never going to be
 * sent a thousand; it only left the model reading a page of a size it had not chosen and
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
 * The actions a trigger or an automation may not carry, because they reach outside Zendesk.
 *
 * A macro action changes the ticket an agent applied it to. A trigger fires on every matching
 * create and update and an automation runs on a schedule against the whole matching set, so
 * the same action list here can email a group, hit a webhook or send a satisfaction survey
 * before anyone reviews the rule. Those are refused at the boundary rather than left for a
 * human to notice, which is what makes the rest of the rule safe to build unattended.
 *
 * This is a denylist, which is the opposite shape from the tool allowlists in
 * utils/tool-registry, and the difference is worth understanding rather than tidying away.
 * An allowlist works there because tool names are ours and finite. Action fields are
 * Zendesk's and are not: a custom field action is `custom_fields_12345`, so any allowlist
 * broad enough to accept one is broad enough to accept anything. The prefix carries the
 * weight here — Zendesk has named every notification action `notification_*` — and the two
 * names beside it are the ones that reach outward without following the convention.
 *
 * A notification action Zendesk adds under some other name would get through. That is the
 * cost of the shape, and it is why the rule is deliberately not the only control: the tools
 * create every rule inactive, so a human still reads it before it can fire.
 */
const NOTIFICATION_ACTION_PREFIX = 'notification_'
const NOTIFICATION_ACTION_NAMES = new Set(['tweet_requester', 'satisfaction_score'])

const isNotificationAction = (field: string): boolean =>
	field.startsWith(NOTIFICATION_ACTION_PREFIX) || NOTIFICATION_ACTION_NAMES.has(field)

/**
 * One test a trigger or automation applies before it acts.
 *
 * `operator` and `value` are both optional because Zendesk documents conditions carrying
 * neither: a field whose presence is the whole test omits the operator, and one whose
 * operator implies its own value omits the value. Requiring either would refuse rules
 * Zendesk accepts.
 *
 * `value` excludes numbers for the reason `macroActionSchema` excludes them. Zendesk writes
 * them as strings, including the hour counts a time-based condition compares against, so
 * `{ field: 'NEW', value: 24 }` is a caller having reached for the wrong shape rather than a
 * convenience worth accepting.
 */
export const businessRuleConditionSchema = z.object({
	field: z
		.string()
		.min(1)
		.describe('Field the condition tests, e.g. status, priority, assignee_id, NEW'),
	operator: z
		.string()
		.optional()
		.describe('How the field is compared, e.g. is, is_not, less_than, greater_than'),
	value: z
		.union([z.string(), z.boolean()])
		.optional()
		.describe('Value compared against, written as a string even when it is a number or an id'),
})

/**
 * The two condition groups a rule is built from: every condition in `all` must match, and one
 * condition in `any` is enough.
 *
 * At least one condition somewhere is required, which is stricter than Zendesk. It documents
 * `conditions` as optional on a trigger, and a trigger with no conditions matches every ticket
 * create and every update there is. That is the single worst thing one of these tools could
 * build, and it is buildable by omission rather than by asking for it — so the shape refuses
 * it and makes the caller say what the rule matches.
 *
 * Zendesk permits time-based conditions only in `all`, never in `any`. Said here because the
 * failure is a rejection from Zendesk naming neither the field nor the group it objected to.
 */
export const businessRuleConditionsSchema = z
	.object({
		all: z
			.array(businessRuleConditionSchema)
			.optional()
			.describe('Conditions that must all match. Time-based conditions have to go here'),
		any: z
			.array(businessRuleConditionSchema)
			.optional()
			.describe('Conditions where one match is enough. Zendesk refuses time-based ones here'),
	})
	.refine((conditions) => (conditions.all?.length ?? 0) + (conditions.any?.length ?? 0) > 0, {
		message:
			'A rule with no conditions matches every ticket. Give at least one condition, in all or in any.',
	})

/**
 * One thing a trigger or an automation does when its conditions match.
 *
 * The same three value shapes as a macro action, for the same reasons — see
 * `macroActionSchema`. What differs is the refusal on `field`, which is where the notification
 * rule above is applied. It sits on the field rather than on the object so that the error
 * names `actions[0].field` and a model can see which action it has to drop.
 */
export const businessRuleActionSchema = z.object({
	field: z
		.string()
		.min(1)
		.refine((field) => !isNotificationAction(field), {
			message:
				'Notification actions are not available here, because a rule can send them to everyone it matches before anyone reviews it. Set fields, tags or a comment instead, and add the notification in the Zendesk UI.',
		})
		.describe('Field the action changes, e.g. status, priority, group_id, comment_value'),
	value: z
		.union([z.string(), z.boolean(), z.array(z.string())])
		.describe(
			'Value to set: usually a string, an array of strings for actions taking several parts, or a boolean for comment_mode_is_public'
		),
})

/**
 * The fields a trigger write may set.
 *
 * `active` is deliberately absent, and absent from the update shape below as well. Zendesk
 * defaults a new trigger to active, so leaving the field out would create a live rule rather
 * than a dormant one — `create_trigger` therefore sends `active: false` itself, which is why
 * `TriggerCreatePayload` states that in its type. Keeping it off the update shape is what
 * makes that mean anything: a rule that could be created dormant and enabled by the next call
 * was never really dormant. Enabling one is a human action in the Zendesk UI, and this server
 * offers no way to do it.
 *
 * `category_id` is a string rather than a number, which is Zendesk's own choice and reads as a
 * mistake next to every other id here.
 */
export const createTriggerSchema = {
	title: z.string().min(1).describe('Trigger title'),
	description: descriptionSchema.describe('Trigger description'),
	category_id: z
		.string()
		.optional()
		.describe('ID of the trigger category this belongs to, as a string'),
	conditions: businessRuleConditionsSchema.describe(
		'When the trigger fires. It runs on every ticket create and update that matches'
	),
	actions: z.array(businessRuleActionSchema).min(1).describe('What the trigger does when it fires'),
	position: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Order this trigger runs in relative to the others'),
}

/**
 * The same fields with nothing required, since Zendesk updates what it is given.
 *
 * `conditions` and `actions` are the two that mean something different at update time: Zendesk
 * replaces each wholesale rather than merging, so a caller restating one condition drops every
 * other condition the trigger had. That is the same trap `updateMacroSchema` describes for
 * actions, and it is worse here, because a trigger left with fewer conditions matches more
 * tickets rather than fewer.
 */
export const updateTriggerSchema = {
	...z.object(createTriggerSchema).partial().shape,
	conditions: createTriggerSchema.conditions
		.describe(
			"The trigger's complete condition set, which replaces the existing one. Zendesk drops any condition left out, and a trigger left with fewer conditions matches more tickets — so read the trigger with get_trigger first and send all of its conditions rather than only the changed ones"
		)
		.optional(),
	actions: createTriggerSchema.actions
		.describe(
			"The trigger's complete action list, which replaces the existing one. Zendesk drops any action left out, so read the trigger with get_trigger first and send all of its actions rather than only the new ones"
		)
		.optional(),
}

/**
 * The fields an automation write may set. `active` is absent for the reason it is absent from
 * the trigger shape, and automations have no description field of their own.
 *
 * Zendesk requires an automation to carry at least one time-based condition, and to carry an
 * action that undoes one of its conditions so it does not run again on the same ticket every
 * cycle. Neither is checked here, and that is a decision rather than an omission. Both would
 * mean keeping a list of Zendesk's time fields in this file and refusing anything not on it,
 * so a field Zendesk added would read as our rejection rather than theirs — a wrong refusal
 * we would have to notice, in place of a right one Zendesk states plainly. The rules are named
 * in the description below instead, where they reach the model that has to satisfy them.
 */
export const createAutomationSchema = {
	title: z.string().min(1).describe('Automation title'),
	conditions: businessRuleConditionsSchema.describe(
		'When the automation runs. Zendesk requires at least one time-based condition — NEW, OPEN, PENDING, SOLVED, CLOSED, assigned_at, updated_at, requester_updated_at, assignee_updated_at, due_date or until_due_date — and it has to go in all rather than any'
	),
	actions: z
		.array(businessRuleActionSchema)
		.min(1)
		.describe(
			'What the automation does. One action should undo one of the conditions above, or the automation runs again on the same ticket every cycle'
		),
	position: z
		.number()
		.int()
		.min(1)
		.optional()
		.describe('Order this automation runs in relative to the others'),
}

/** The same fields with nothing required, replacing wholesale for the reasons above. */
export const updateAutomationSchema = {
	...z.object(createAutomationSchema).partial().shape,
	conditions: createAutomationSchema.conditions
		.describe(
			"The automation's complete condition set, which replaces the existing one. Zendesk drops any condition left out, and an automation left with fewer conditions matches more tickets — so read it with get_automation first and send all of its conditions rather than only the changed ones"
		)
		.optional(),
	actions: createAutomationSchema.actions
		.describe(
			"The automation's complete action list, which replaces the existing one. Zendesk drops any action left out, so read the automation with get_automation first and send all of its actions rather than only the new ones"
		)
		.optional(),
}

/**
 * The create payloads carry `active: false` in the type, not merely by convention.
 *
 * The schemas above do not accept `active` at all, so the flag can only come from the handler.
 * Stating it here is what stops that being forgotten: a handler passing the validated params
 * straight through no longer type-checks, and the guarantee is enforced by the compiler rather
 * than by whoever reviews the tool file next.
 */
export type TriggerCreatePayload = InferParams<typeof createTriggerSchema> & { active: false }
export type TriggerUpdatePayload = InferParams<typeof updateTriggerSchema>
export type AutomationCreatePayload = InferParams<typeof createAutomationSchema> & {
	active: false
}
export type AutomationUpdatePayload = InferParams<typeof updateAutomationSchema>

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
