/**
 * Tool registry utility for systematic registration of MCP tools
 * Provides a clean functional approach to tool registration
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { withErrorHandling } from './error-handling'

/**
 * Registers a collection of tools with the MCP server
 * Automatically applies error handling to each tool
 */
export const registerTools = (
	server: McpServer,
	client: ZendeskClient,
	tools: ToolDefinition[]
): void => {
	tools.forEach(tool => {
		server.tool(
			tool.name,
			tool.schema,
			withErrorHandling(tool.handler.bind(null, client))
		)
	})
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
	Object.values(toolCategories).forEach(tools => {
		registerTools(server, client, tools)
	})
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