/**
 * Tool registry utility for systematic registration of MCP tools
 * Provides a clean functional approach to tool registration
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZodRawShape } from 'zod'
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

/**
 * Registers a collection of tools with the MCP server
 * Automatically applies error handling to each tool
 * Returns the names of any tools the registration policy withheld
 */
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

		// The four-argument overload. Passing the schema as the second argument selects the
		// one without a description, so every tool's description was collected here and then
		// dropped, and a client saw a bare name and a parameter list. Field descriptions were
		// unaffected — those ride inside the JSON schema — which is why nothing looked wrong.
		server.tool(
			tool.name,
			tool.description,
			tool.schema,
			withErrorHandling(tool.handler.bind(null, client))
		)
	})

	return withheld
}

/**
 * Registers multiple tool categories at once
 * Useful for bulk registration in the main init function
 */
export const registerAllTools = (
	server: McpServer,
	client: ZendeskClient,
	toolCategories: Record<string, ToolDefinition[]>
): void => {
	const withheld = Object.values(toolCategories).flatMap((tools) =>
		registerTools(server, client, tools)
	)

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
 */
export const createTool = <S extends ZodRawShape>(
	name: string,
	description: string,
	schema: S,
	handler: (client: ZendeskClient, params: InferParams<S>) => Promise<unknown>
): ToolDefinition => ({
	name,
	description,
	schema,
	handler: handler as ToolDefinition['handler'],
})
