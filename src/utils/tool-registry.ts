import type { McpServer } from '@modelcontextprotocol/server'
import { z, type ZodRawShape } from 'zod'
import type { ZendeskClient } from '../zendesk-client'
import type { InferParams, ToolDefinition } from '../types/zendesk'
import { withErrorHandling } from './error-handling'

/**
 * Reads are published. Anything that creates, updates or deletes is withheld at registration
 * and never reaches a client's tool list, unless it is named in WRITE_TOOLS_ENABLED below.
 *
 * This is an allowlist of query verbs rather than a denylist of mutating ones, so a
 * newly added tool stays unexposed until someone classifies it on purpose. Getting that
 * backwards would silently publish the next write tool somebody adds.
 */
const READ_ONLY_TOOL_PREFIXES = ['list_', 'get_', 'search_']
const READ_ONLY_TOOL_NAMES = new Set(['search', 'support_info'])

export const isReadOnlyTool = (name: string): boolean =>
	READ_ONLY_TOOL_NAMES.has(name) ||
	READ_ONLY_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))

/**
 * The writes that are permitted anyway, named one at a time.
 *
 * Macros are the whole list because of what a macro is: it changes nothing when it is
 * created and sits in a menu until an agent deliberately applies it to a ticket. A trigger
 * fires on every matching create or update and an automation runs on a schedule, so a
 * malformed one reaches customers before anyone reviews it. That is the difference this set
 * is drawing, and it is why #22 files triggers and automations separately.
 *
 * Naming the tools individually is the point, rather than permitting a `create_` prefix
 * alongside the read verbs above. A prefix would auto-publish every create tool anyone adds
 * from now on, which inverts exactly the property the read rule is protecting. `delete_macro`
 * is simply absent, so deletion stays withheld without needing a tier system to say so.
 *
 * Generalising this — per-group ceilings, levels declared on the tool, config in `this.env`
 * — is #20, which waits until #22 and #23 have said what the general case actually needs.
 */
const WRITE_TOOLS_ENABLED = new Set(['create_macro', 'update_macro'])

export const isToolPublished = (name: string): boolean =>
	isReadOnlyTool(name) || WRITE_TOOLS_ENABLED.has(name)

/** Registers the tools this policy publishes, returning the names of those it withheld. */
export const registerTools = (
	server: McpServer,
	client: ZendeskClient,
	tools: ToolDefinition[]
): string[] => {
	const withheld: string[] = []

	tools.forEach((tool) => {
		if (!isToolPublished(tool.name)) {
			withheld.push(tool.name)
			return
		}

		// `z.object` around the shape is what keeps this off a deprecated path. SDK v2 still
		// accepts a bare `{ field: z.string() }` record and wraps it internally, but that
		// overload is marked deprecated, so the wrapping happens here instead. Tool definitions
		// are unaffected and still spread shared shapes like `paginationSchema` directly.
		//
		// This is the only place a handler's result becomes a response, which is why the worded
		// confirmation has to arrive here as data. See `withErrorHandling` for what wrapping one
		// a second time costs.
		server.registerTool(
			tool.name,
			{ description: tool.description, inputSchema: z.object(tool.schema) },
			withErrorHandling(tool.handler.bind(null, client), tool.successMessage)
		)
	})

	return withheld
}

/**
 * Registers multiple tool categories at once, returning every name it withheld
 */
export const registerAllTools = (
	server: McpServer,
	client: ZendeskClient,
	toolCategories: Record<string, ToolDefinition[]>
): string[] =>
	Object.values(toolCategories).flatMap((tools) => registerTools(server, client, tools))

/**
 * Says once what registration will withhold, and what it lets through anyway.
 *
 * Deliberately separate from `registerAllTools`, and deliberately derived from the tool
 * definitions rather than from a registration that has just run. Since #40 the server is
 * built per request, so a message logged as a side effect of registering would repeat on
 * every tool call instead of appearing once. What gets withheld is fixed at build time and
 * depends on nothing per-request, which is why this can be called at module scope and read
 * as the startup announcement it is meant to be.
 */
export const announceWithheldTools = (toolCategories: Record<string, ToolDefinition[]>): void => {
	const withheld = Object.values(toolCategories)
		.flat()
		.map((tool) => tool.name)
		.filter((name) => !isToolPublished(name))

	if (withheld.length > 0) {
		console.log(
			`Withholding ${withheld.length} write tools (${withheld.join(', ')}). ` +
				`Permitted writes: ${[...WRITE_TOOLS_ENABLED].join(', ')}`
		)
	}
}

/**
 * Creates a tool definition, deriving the handler's parameters from the schema.
 *
 * The handler never restates its parameter type — it is inferred from `schema`, so the two
 * cannot drift apart. Adding a field to a shared schema immediately makes that field visible
 * to every handler spreading it, and naming a field the schema does not declare is now an
 * error rather than a parameter the MCP server will never populate.
 *
 * The cast is the one place the specific parameter type is given up, and it is safe precisely
 * here: the compiler has just checked `handler` against `schema` for this call, and the MCP
 * server validates incoming arguments against that same schema before the handler ever runs.
 *
 * `successMessage` heads the record a write hands back — `'Ticket created successfully!'` above
 * the created ticket — and is applied on the success path only, so it cannot dress a failure up
 * as a success. A handler wording its whole answer, as `delete_ticket` does with an empty body
 * to report, returns the sentence as a string and leaves this unset: `withErrorHandling` passes
 * a string through untouched and never consults the message.
 */
export const createTool = <S extends ZodRawShape>(
	name: string,
	description: string,
	schema: S,
	handler: (client: ZendeskClient, params: InferParams<S>) => Promise<unknown>,
	successMessage?: string
): ToolDefinition => ({
	name,
	description,
	schema,
	handler: handler as ToolDefinition['handler'],
	successMessage,
})
