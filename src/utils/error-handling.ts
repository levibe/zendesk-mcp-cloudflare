/**
 * Functional error handling utility for MCP tool responses
 * Eliminates repetitive try/catch blocks across all tools
 */

import type { McpToolResponse } from '../types/zendesk'

/**
 * Higher-order function that wraps API calls with consistent error handling
 * Returns properly formatted MCP responses
 */
export const withErrorHandling = <T extends any[], R>(
	fn: (...args: T) => Promise<R>,
	successMessage?: string
) => async (...args: T): Promise<McpToolResponse> => {
		try {
			const result = await fn(...args)

			// Handle different response types
			if (typeof result === 'string') {
				return {
					content: [{ type: 'text', text: result }]
				}
			}

			// For API responses, format as JSON
			const text = successMessage
				? `${successMessage}\n\n${JSON.stringify(result, null, 2)}`
				: JSON.stringify(result, null, 2)

			return {
				content: [{ type: 'text', text }]
			}
		} catch (error) {
			return {
				content: [{
					type: 'text',
					text: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`
				}],
				isError: true
			}
		}
	}

/**
 * Specialized error handler for delete operations
 * Returns success message instead of empty response
 */
export const withDeleteHandling = (
	fn: () => Promise<any>,
	itemType: string,
	itemId: string | number
) => withErrorHandling(
	async () => {
		await fn()
		return `${itemType} ${itemId} deleted successfully!`
	}
)

/**
 * Error handler for creation operations with custom success message
 */
export const withCreateHandling = <T>(
	fn: () => Promise<T>,
	itemType: string
) => withErrorHandling(
		fn,
		`${itemType} created successfully!`
	)

/**
 * Error handler for update operations with custom success message
 */
export const withUpdateHandling = <T>(
	fn: () => Promise<T>,
	itemType: string
) => withErrorHandling(
		fn,
		`${itemType} updated successfully!`
	)