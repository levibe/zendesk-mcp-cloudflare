/**
 * Utilities for standardizing search response formats across all search tools
 */

import type { 
	SearchResponseMetadata,
	StandardizedSearchResult,
	StandardizedSearchResponse
} from '../types/zendesk'

/**
 * Standardizes search response format by adding result_type to each result
 * and organizing metadata consistently
 */
export function standardizeSearchResponse(
	rawResponse: any,
	defaultResultType?: string
): StandardizedSearchResponse {
	if (!rawResponse || typeof rawResponse !== 'object') {
		return {
			results: [],
			metadata: {}
		}
	}

	const results = Array.isArray(rawResponse.results) ? rawResponse.results : []
	
	// Add result_type to each result if not already present
	const standardizedResults: StandardizedSearchResult[] = results.map((result: any) => {
		if (!result || typeof result !== 'object') {
			return { result_type: defaultResultType || 'unknown' }
		}

		// If result_type is already present, keep it
		if (result.result_type) {
			return result
		}

		// Try to infer result_type from the object structure
		let resultType = defaultResultType || 'unknown'
		
		if (result.url && typeof result.url === 'string') {
			if (result.url.includes('/tickets/')) {
				resultType = 'ticket'
			} else if (result.url.includes('/users/')) {
				resultType = 'user'
			} else if (result.url.includes('/organizations/')) {
				resultType = 'organization'
			} else if (result.url.includes('/help_center/articles/')) {
				resultType = 'article'
			} else if (result.url.includes('/groups/')) {
				resultType = 'group'
			}
		}

		return {
			...result,
			result_type: resultType
		}
	})

	// Standardize metadata
	const metadata: SearchResponseMetadata = {
		total_count: rawResponse.count || results.length
	}

	// Add pagination info if available
	if (rawResponse.next_page || rawResponse.previous_page) {
		metadata.page_info = {
			has_next_page: !!rawResponse.next_page,
			has_previous_page: !!rawResponse.previous_page
		}
	}

	return {
		results: standardizedResults,
		metadata,
		count: rawResponse.count,
		next_page: rawResponse.next_page || null,
		previous_page: rawResponse.previous_page || null
	}
}

/**
 * Wrapper function for search operations that automatically standardizes the response
 */
export async function executeSearchWithStandardizedResponse(
	searchOperation: () => Promise<any>,
	defaultResultType?: string
): Promise<StandardizedSearchResponse> {
	try {
		const rawResponse = await searchOperation()
		return standardizeSearchResponse(rawResponse, defaultResultType)
	} catch (error) {
		// If the search operation fails, return a standardized error response
		return {
			results: [],
			metadata: {},
			count: 0,
			next_page: null,
			previous_page: null
		}
	}
}