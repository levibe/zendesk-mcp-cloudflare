import type {
	SearchResponseMetadata,
	StandardizedSearchResult,
	StandardizedSearchResponse,
} from '../types/zendesk'
import { isRecord } from './narrow'

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

	const standardizedResults: StandardizedSearchResult[] = results.map((result) => {
		if (!isRecord(result)) {
			return { result_type: defaultResultType || 'unknown' }
		}

		if (result.result_type) {
			return { ...result, result_type: String(result.result_type) }
		}

		// Zendesk search returns mixed entity types and does not always label them, so the
		// resource URL is the fallback signal for what a result actually is.
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

	const metadata: SearchResponseMetadata = {
		total_count: count || results.length,
	}

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

		const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred'
		const errorType = error instanceof Error ? error.constructor.name : 'UnknownError'

		const errorMetadata: SearchResponseMetadata = {
			error: errorMessage,
			errorType,
			duration,
		}

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
