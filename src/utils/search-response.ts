/**
 * Utilities for standardizing search response formats across all search tools
 */

import type {
	SearchResponseMetadata,
	StandardizedSearchResult,
	StandardizedSearchResponse,
} from '../types/zendesk'
import { isRecord } from './narrow'

/**
 * Standardizes search response format by adding result_type to each result
 * and organizing metadata consistently
 */
export function standardizeSearchResponse(
	rawResponse: unknown,
	defaultResultType?: string
): StandardizedSearchResponse {
	if (!isRecord(rawResponse)) {
		return {
			results: [],
			metadata: {},
		}
	}

	const results: unknown[] = Array.isArray(rawResponse.results) ? rawResponse.results : []

	// Add result_type to each result if not already present
	const standardizedResults: StandardizedSearchResult[] = results.map((result) => {
		if (!isRecord(result)) {
			return { result_type: defaultResultType || 'unknown' }
		}

		// If result_type is already present, keep it
		if (result.result_type) {
			return { ...result, result_type: String(result.result_type) }
		}

		// Try to infer result_type from the object structure
		let resultType = defaultResultType || 'unknown'

		if (typeof result.url === 'string') {
			const { url } = result
			if (url.includes('/tickets/')) {
				resultType = 'ticket'
			} else if (url.includes('/users/')) {
				resultType = 'user'
			} else if (url.includes('/organizations/')) {
				resultType = 'organization'
			} else if (url.includes('/help_center/articles/')) {
				resultType = 'article'
			} else if (url.includes('/groups/')) {
				resultType = 'group'
			}
		}

		return {
			...result,
			result_type: resultType,
		}
	})

	// Zendesk sends these three back at the top level; anything else is not usable as a count
	// or a page link, so it is treated as absent rather than passed along unexamined.
	const count = typeof rawResponse.count === 'number' ? rawResponse.count : undefined
	const nextPage = typeof rawResponse.next_page === 'string' ? rawResponse.next_page : null
	const previousPage =
		typeof rawResponse.previous_page === 'string' ? rawResponse.previous_page : null

	// Standardize metadata
	const metadata: SearchResponseMetadata = {
		total_count: count || results.length,
	}

	// Add pagination info if available
	if (nextPage || previousPage) {
		metadata.page_info = {
			has_next_page: !!nextPage,
			has_previous_page: !!previousPage,
		}
	}

	return {
		results: standardizedResults,
		metadata,
		count,
		next_page: nextPage,
		previous_page: previousPage,
	}
}

/**
 * Wrapper function for search operations that automatically standardizes the response
 */
export async function executeSearchWithStandardizedResponse(
	searchOperation: () => Promise<unknown>,
	defaultResultType?: string
): Promise<StandardizedSearchResponse> {
	const startTime = Date.now()

	try {
		const rawResponse = await searchOperation()
		return standardizeSearchResponse(rawResponse, defaultResultType)
	} catch (error) {
		const duration = Date.now() - startTime

		// Structured logging for Cloudflare Workers observability
		console.error('Search operation failed', {
			error:
				error instanceof Error
					? {
							message: error.message,
							stack: error.stack,
							cause: error.cause,
						}
					: String(error),
			defaultResultType,
			duration,
			timestamp: new Date().toISOString(),
		})

		// Enhanced error response with detailed metadata for MCP clients
		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
		const errorType = error instanceof Error ? error.constructor.name : 'UnknownError'

		const errorMetadata: SearchResponseMetadata = {
			error: errorMessage,
			errorType,
			duration,
		}

		// Include error cause chain if available
		if (error instanceof Error && error.cause) {
			errorMetadata.errorCause =
				error.cause instanceof Error ? error.cause.message : String(error.cause)
		}

		return {
			results: [],
			metadata: errorMetadata,
			count: 0,
			next_page: null,
			previous_page: null,
		}
	}
}
