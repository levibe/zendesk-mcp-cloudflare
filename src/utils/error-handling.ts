/**
 * Functional error handling utility for MCP tool responses
 * Eliminates repetitive try/catch blocks across all tools
 */

import type { McpToolResponse } from '../types/zendesk'

/**
 * Higher-order function that wraps API calls with consistent error handling
 * Returns properly formatted MCP responses
 *
 * `registerTools` is the only caller, and applies this to every handler exactly once. Do not
 * call it from inside a handler as well: a response wrapped twice is JSON-encoded as the text
 * of the outer one, and `isError` goes with it, so a failed call reports as a successful one.
 * A write's worded confirmation reaches this as `successMessage` on the tool definition, which
 * is where the deleted create, update and delete wrappers were each wording one from the wrong
 * side of the seam.
 */
export const withErrorHandling =
	<T extends unknown[], R>(fn: (...args: T) => Promise<R>, successMessage?: string) =>
	async (...args: T): Promise<McpToolResponse> => {
		try {
			const result = await fn(...args)

			// Handle different response types
			if (typeof result === 'string') {
				return {
					content: [{ type: 'text', text: result }],
				}
			}

			// For API responses, format as JSON
			const text = successMessage
				? `${successMessage}\n\n${JSON.stringify(result, null, 2)}`
				: JSON.stringify(result, null, 2)

			return {
				content: [{ type: 'text', text }],
			}
		} catch (error) {
			return {
				content: [
					{
						type: 'text',
						text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
					},
				],
				isError: true,
			}
		}
	}
