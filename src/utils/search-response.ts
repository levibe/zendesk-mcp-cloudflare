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
		// Structured logging for Cloudflare Workers observability. This is the only reason the
		// catch exists — the log is a side effect on the way past, not a decision about what the
		// caller gets back.
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
			duration: Date.now() - startTime,
			timestamp: new Date().toISOString(),
		})

		// Then rethrow, because the single `withErrorHandling` in `registerTools` is what sets
		// `isError` on the response, and it can only see a rejection. This used to resolve with
		// the failure described in `metadata.error` instead, which meant a revoked token, a 503
		// and a dropped connection all reached the model looking exactly like a search that
		// legitimately matched nothing — the difference sitting in a metadata field nothing
		// obliges a model to read. That is #28's argument arriving on the read side: there the
		// mistake was a handler wrapping its own response and burying `isError` inside JSON,
		// here it was never raising the flag at all. Do not reinstate the catch-and-resolve. An
		// empty result list is an answer, and a search that failed does not have one.
		//
		// The original error goes back out untouched rather than rewrapped. Nothing between here
		// and the client reads more than its message today — `withErrorHandling` takes
		// `error.message` and nothing else, and `isRetryableError` has already run and finished,
		// upstream inside `requestWithRetry`, long before the failure reaches this catch. So the
		// reason is not that a consumer needs the `status` and the `cause`; it is that rewrapping
		// would destroy them for no gain. `new Error(error.message)` costs a link in the chain
		// and buys nothing, and the message it would build is one this function is in no position
		// to improve on. Keeping the object whole is also what lets a test assert identity rather
		// than wording, which is the assertion that survives someone editing the sentence.
		throw error
	}
}
