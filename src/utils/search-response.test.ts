/**
 * These pin the reshaping that #10 changed. Every assertion here records what the function
 * returns today, so a future edit to the narrowing has to be a deliberate one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { executeSearchWithStandardizedResponse, standardizeSearchResponse } from './search-response'

const apiUrl = (path: string) => `https://example.zendesk.com/api/v2${path}`

describe('standardizeSearchResponse', () => {
	describe('result_type', () => {
		const inferredFrom = (path: string) =>
			standardizeSearchResponse({ results: [{ url: apiUrl(path) }] }).results[0].result_type

		it('reads a ticket url', () => {
			expect(inferredFrom('/tickets/1.json')).toBe('ticket')
		})

		it('reads a user url', () => {
			expect(inferredFrom('/users/1.json')).toBe('user')
		})

		it('reads an organization url', () => {
			expect(inferredFrom('/organizations/1.json')).toBe('organization')
		})

		it('reads a Help Center article url', () => {
			expect(inferredFrom('/help_center/articles/1.json')).toBe('article')
		})

		it('reads a group url', () => {
			expect(inferredFrom('/groups/1.json')).toBe('group')
		})

		it('falls through to unknown on a url it does not recognise', () => {
			expect(inferredFrom('/satisfaction_ratings/1.json')).toBe('unknown')
		})

		it('leaves the rest of the result untouched', () => {
			const url = apiUrl('/tickets/42.json')
			const { results } = standardizeSearchResponse({
				results: [{ id: 42, subject: 'Cannot log in', tags: ['login'], url }],
			})

			expect(results[0]).toEqual({
				id: 42,
				subject: 'Cannot log in',
				tags: ['login'],
				url,
				result_type: 'ticket',
			})
		})

		it('keeps a result_type the body already carries, even against the url', () => {
			const { results } = standardizeSearchResponse({
				results: [{ url: apiUrl('/tickets/1.json'), result_type: 'ticket_field' }],
			})

			expect(results[0].result_type).toBe('ticket_field')
		})

		it('stringifies a result_type that did not arrive as a string', () => {
			const { results } = standardizeSearchResponse({ results: [{ result_type: 7 }] })

			expect(results[0].result_type).toBe('7')
		})

		it('uses defaultResultType when the url infers nothing', () => {
			const { results } = standardizeSearchResponse(
				{ results: [{ id: 1 }, { url: apiUrl('/satisfaction_ratings/1.json') }] },
				'ticket'
			)

			expect(results.map((result) => result.result_type)).toEqual(['ticket', 'ticket'])
		})

		it('collapses an entry that is not an object to a bare result_type', () => {
			const { results } = standardizeSearchResponse({ results: [null, 'nope', 7] }, 'user')

			expect(results).toEqual([
				{ result_type: 'user' },
				{ result_type: 'user' },
				{ result_type: 'user' },
			])
		})
	})

	describe('bodies it cannot read', () => {
		// The empty response is a shorter shape than the success one — no count and no page
		// links at all, rather than count: 0 and next_page: null. toStrictEqual is what holds
		// that line, since toEqual would let an undefined-valued key slip in unnoticed.
		it.each([
			['null', null],
			['undefined', undefined],
			['a string', 'not a search response'],
			['a number', 7],
		])('returns the empty response for %s', (_label, body) => {
			expect(standardizeSearchResponse(body)).toStrictEqual({ results: [], metadata: {} })
		})

		it('returns an empty result list when the body has no results array', () => {
			const { results, metadata } = standardizeSearchResponse({ count: 0 })

			expect(results).toEqual([])
			expect(metadata.total_count).toBe(0)
		})
	})

	describe('metadata and pagination', () => {
		it('passes count and both page links through', () => {
			const response = standardizeSearchResponse({
				results: [{ id: 1 }],
				count: 137,
				next_page: apiUrl('/search.json?page=3'),
				previous_page: apiUrl('/search.json?page=1'),
			})

			expect(response.count).toBe(137)
			expect(response.next_page).toBe(apiUrl('/search.json?page=3'))
			expect(response.previous_page).toBe(apiUrl('/search.json?page=1'))
			expect(response.metadata.total_count).toBe(137)
		})

		it('leaves a null next_page null', () => {
			const response = standardizeSearchResponse({ results: [], next_page: null })

			expect(response.next_page).toBeNull()
		})

		it('records a next page without a previous one', () => {
			const { metadata } = standardizeSearchResponse({
				results: [{ id: 1 }],
				next_page: apiUrl('/search.json?page=2'),
			})

			expect(metadata.page_info).toEqual({ has_next_page: true, has_previous_page: false })
		})

		it('omits page_info when neither page link is present', () => {
			const { metadata } = standardizeSearchResponse({ results: [{ id: 1 }] })

			expect(metadata).not.toHaveProperty('page_info')
		})

		it('falls back to the result count when count is absent', () => {
			const { metadata } = standardizeSearchResponse({ results: [{ id: 1 }, { id: 2 }] })

			expect(metadata.total_count).toBe(2)
		})

		// count || results.length, so a genuine zero is indistinguishable from a missing one.
		// Worth pinning precisely because it looks like a bug: it only shows up when Zendesk
		// sends count: 0 alongside results, which it does not do today.
		it('falls back to the result count when count is 0', () => {
			const { metadata } = standardizeSearchResponse({ results: [{ id: 1 }, { id: 2 }], count: 0 })

			expect(metadata.total_count).toBe(2)
		})
	})
})

describe('executeSearchWithStandardizedResponse', () => {
	beforeEach(() => {
		// The error path logs a structured record for Workers observability. Silenced so a
		// passing run stays readable; the assertions below cover what it puts in the response.
		vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('standardizes a body the operation resolved with', async () => {
		const response = await executeSearchWithStandardizedResponse(
			async () => ({ results: [{ url: apiUrl('/tickets/1.json') }], count: 1 }),
			'ticket'
		)

		expect(response.results).toEqual([{ url: apiUrl('/tickets/1.json'), result_type: 'ticket' }])
		expect(response.count).toBe(1)
	})

	it('reports a thrown error as metadata rather than letting it propagate', async () => {
		const cause = new Error('Zendesk API Error: 503 - upstream unavailable')
		const response = await executeSearchWithStandardizedResponse(async () => {
			throw new Error('Zendesk request failed: it broke', { cause })
		})

		expect(response.metadata.error).toBe('Zendesk request failed: it broke')
		expect(response.metadata.errorType).toBe('Error')
		expect(response.metadata.errorCause).toBe('Zendesk API Error: 503 - upstream unavailable')
	})

	it('answers a failure with an empty, explicitly unpaginated response', async () => {
		const response = await executeSearchWithStandardizedResponse(async () => {
			throw new Error('it broke')
		})

		expect(response.results).toEqual([])
		expect(response.count).toBe(0)
		expect(response.next_page).toBeNull()
		expect(response.previous_page).toBeNull()
	})
})
