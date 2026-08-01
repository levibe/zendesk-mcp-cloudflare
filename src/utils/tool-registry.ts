/**
 * Tool registry utility for systematic registration of MCP tools
 * Provides a clean functional approach to tool registration
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { withErrorHandling } from './error-handling'

/**
 * MCP clients get read-only access to Zendesk for now, so anything that creates,
 * updates or deletes is withheld at registration and never reaches a client's tool list.
 *
 * This is an allowlist of query verbs rather than a denylist of mutating ones, so a
 * newly added tool stays unexposed until someone classifies it on purpose. Getting that
 * backwards would silently publish the next write tool somebody adds.
 */
const READ_ONLY_TOOL_PREFIXES = ['list_', 'get_', 'search_']
const READ_ONLY_TOOL_NAMES = new Set(['search', 'support_info'])

export const isReadOnlyTool = (name: string): boolean =>
	READ_ONLY_TOOL_NAMES.has(name) ||
	READ_ONLY_TOOL_PREFIXES.some(prefix => name.startsWith(prefix))

/**
 * Registers a collection of tools with the MCP server
 * Automatically applies error handling to each tool
 * Returns the names of any tools withheld by the read-only policy
 */
export const registerTools = (
	server: McpServer,
	client: ZendeskClient,
	tools: ToolDefinition[]
): string[] => {
	const withheld: string[] = []

	tools.forEach(tool => {
		if (!isReadOnlyTool(tool.name)) {
			withheld.push(tool.name)
			return
		}

		server.tool(
			tool.name,
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
	const withheld = Object.values(toolCategories).flatMap(tools =>
		registerTools(server, client, tools)
	)

	if (withheld.length > 0) {
		console.log(`Read-only mode: withholding ${withheld.length} write tools (${withheld.join(', ')})`)
	}
}

/**
 * Helper to create a tool definition with proper typing
 */
export const createTool = <T = any>(
	name: string,
	description: string,
	schema: Record<string, any>,
	handler: (client: ZendeskClient, params: T) => Promise<any>
): ToolDefinition => ({
		name,
		description,
		schema,
		handler
	})