/**
 * `get_help_center_hierarchy` is the one tool here that reads into a response body instead
 * of handing it to JSON.stringify, so it is the one with behaviour to lose. These cover the
 * walk and, through it, the `readEntities` narrowing that #10 put underneath it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { helpCenterTools } from './help-center'
import type { ZendeskClient } from '../zendesk-client'

const hierarchyTool = helpCenterTools.find((tool) => tool.name === 'get_help_center_hierarchy')!

interface StubbedResponses {
	listCategories?: unknown
	getCategory?: unknown
	sectionsByCategory?: Record<number, unknown>
	articlesBySection?: Record<number, unknown>
}

const stubClient = (responses: StubbedResponses) => ({
	listCategories: vi.fn(async () => responses.listCategories),
	getCategory: vi.fn(async () => responses.getCategory),
	listSectionsByCategory: vi.fn(async (id: number) => responses.sectionsByCategory?.[id]),
	listArticlesBySection: vi.fn(async (id: number) => responses.articlesBySection?.[id]),
})

type StubbedClient = ReturnType<typeof stubClient>

const walk = (client: StubbedClient, params: Record<string, unknown> = {}) =>
	hierarchyTool.handler(client as unknown as ZendeskClient, params)

/** Two categories, three sections between them, three articles between those. */
const fullTree = () =>
	stubClient({
		listCategories: {
			categories: [
				{ id: 1, name: 'Billing' },
				{ id: 2, name: 'Account' },
			],
		},
		sectionsByCategory: {
			1: {
				sections: [
					{ id: 10, name: 'Invoices' },
					{ id: 11, name: 'Refunds' },
				],
			},
			2: { sections: [{ id: 20, name: 'Login' }] },
		},
		articlesBySection: {
			10: { articles: [{ id: 100 }, { id: 101 }] },
			11: { articles: [] },
			20: { articles: [{ id: 200 }] },
		},
	})

describe('get_help_center_hierarchy', () => {
	it('counts categories, sections and articles at every level', async () => {
		const result = await walk(fullTree(), { include_articles: true })

		expect(result.total_categories).toBe(2)
		expect(result.total_sections).toBe(3)
		expect(result.total_articles).toBe(3)
	})

	it('nests each level under the one above it', async () => {
		const result = await walk(fullTree(), { include_articles: true })

		expect(result.hierarchy[0]).toEqual({
			id: 1,
			name: 'Billing',
			sections: [
				{ id: 10, name: 'Invoices', articles: [{ id: 100 }, { id: 101 }] },
				{ id: 11, name: 'Refunds', articles: [] },
			],
		})
	})

	describe('when include_articles is unset', () => {
		it('leaves each section exactly as it arrived', async () => {
			const result = await walk(fullTree())

			expect(result.hierarchy[0].sections).toEqual([
				{ id: 10, name: 'Invoices' },
				{ id: 11, name: 'Refunds' },
			])
		})

		it('does not add an empty articles key', async () => {
			const result = await walk(fullTree())

			expect(result.hierarchy[0].sections[0]).not.toHaveProperty('articles')
		})

		it('does not report a total_articles it never counted', async () => {
			const result = await walk(fullTree())

			expect(result).not.toHaveProperty('total_articles')
		})

		it('does not fetch any articles', async () => {
			const client = fullTree()
			await walk(client)

			expect(client.listArticlesBySection).not.toHaveBeenCalled()
		})
	})

	describe('choosing which categories to walk', () => {
		it('lists every category and reads the categories key', async () => {
			const client = fullTree()
			await walk(client)

			expect(client.listCategories).toHaveBeenCalled()
			expect(client.getCategory).not.toHaveBeenCalled()
		})

		it('fetches one category and reads the singular category key', async () => {
			const client = stubClient({
				getCategory: { category: { id: 1, name: 'Billing' } },
				sectionsByCategory: { 1: { sections: [{ id: 10 }] } },
			})

			const result = await walk(client, { category_id: 1 })

			expect(client.getCategory).toHaveBeenCalledWith(1)
			expect(client.listCategories).not.toHaveBeenCalled()
			expect(result.total_categories).toBe(1)
			expect(result.hierarchy[0].name).toBe('Billing')
		})

		it('walks nothing when the requested category is not in the body', async () => {
			const result = await walk(stubClient({ getCategory: {} }), { category_id: 99 })

			expect(result.hierarchy).toEqual([])
			expect(result.total_categories).toBe(0)
			expect(result.total_sections).toBe(0)
		})
	})

	describe('bodies it cannot read', () => {
		it.each([
			['null', null],
			['undefined', undefined],
			['a string', 'not a category list'],
		])('walks nothing when the category body is %s', async (_label, body) => {
			const result = await walk(stubClient({ listCategories: body }))

			expect(result.hierarchy).toEqual([])
			expect(result.total_categories).toBe(0)
		})

		it('treats a section body it cannot read as no sections', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: 'not a section list' },
			})

			const result = await walk(client)

			expect(result.hierarchy[0].sections).toEqual([])
			expect(result.total_sections).toBe(0)
		})
	})

	describe('entries without a numeric id', () => {
		// The walk needs an id to fetch the level below, so anything without one is dropped
		// rather than carried along as a childless branch.
		it('drops them at the category level', async () => {
			const client = stubClient({
				listCategories: {
					categories: [{ id: 1, name: 'Billing' }, { name: 'no id' }, { id: '2' }, null],
				},
				sectionsByCategory: { 1: { sections: [] } },
			})

			const result = await walk(client)

			expect(result.total_categories).toBe(1)
			expect(result.hierarchy[0].name).toBe('Billing')
		})

		it('drops them at the section level', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: { sections: [{ id: 10 }, { name: 'no id' }] } },
			})

			const result = await walk(client)

			expect(result.total_sections).toBe(1)
		})

		it('drops them at the article level', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: { sections: [{ id: 10 }] } },
				articlesBySection: { 10: { articles: [{ id: 100 }, 'not an article'] } },
			})

			const result = await walk(client, { include_articles: true })

			expect(result.total_articles).toBe(1)
		})
	})

	it('reports a failed fetch instead of throwing', async () => {
		const client = stubClient({})
		const failure = new Error('Zendesk request failed: Zendesk API Error: 503 - unavailable')
		client.listCategories.mockRejectedValue(failure)

		const result = await walk(client)

		expect(result).toEqual({
			error: 'Failed to fetch Help Center hierarchy',
			details: failure,
		})
	})
})

describe('readEntities, through the tools that share it', () => {
	let client: StubbedClient

	beforeEach(() => {
		client = stubClient({
			listCategories: { categories: [{ id: 1 }] },
			sectionsByCategory: { 1: { sections: { id: 10, name: 'Invoices' } } },
		})
	})

	// getCategory answers with a single object where listCategories answers with an array,
	// so both shapes are accepted under the same key.
	it('accepts a lone object where a list was expected', async () => {
		const result = await walk(client)

		expect(result.hierarchy[0].sections).toEqual([{ id: 10, name: 'Invoices' }])
	})
})
