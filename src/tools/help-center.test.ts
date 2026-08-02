/**
 * `get_help_center_hierarchy` is the one tool here that reads into a response body instead
 * of handing it to JSON.stringify, so it is the one with behaviour to lose. These cover the
 * walk and, through it, the `readEntities` narrowing that #10 put underneath it — plus the
 * three things the walk now has to be honest about: what it paged, what it could not reach,
 * and that a failure is a failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { helpCenterTools } from './help-center'
import type { ZendeskClient } from '../zendesk-client'

const hierarchyTool = helpCenterTools.find((tool) => tool.name === 'get_help_center_hierarchy')!

/** The bounds the tool is built to, restated here so a test can say which one it is exercising. */
const PAGE_SIZE = 100
const MAX_PAGES_PER_LIST = 5
const MAX_REQUESTS = 40
const MAX_IN_FLIGHT = 5

/**
 * Stub bodies, one per client method.
 *
 * A plain value is the body every call gets back. An **array** is successive pages, handed out
 * by the `page` parameter the walk sends — no real response body is ever an array, so the two
 * cannot be confused.
 */
interface StubbedResponses {
	listCategories?: unknown
	getCategory?: unknown
	sectionsByCategory?: Record<number, unknown>
	articlesBySection?: Record<number, unknown>
}

const atPage = (body: unknown, params?: Record<string, unknown>): unknown => {
	if (!Array.isArray(body)) return body

	const page = typeof params?.page === 'number' ? params.page : 1
	return body[page - 1]
}

const stubClient = (responses: StubbedResponses) => {
	/**
	 * Overlapping calls, counted across every method so the walk's concurrency bound has
	 * something to be measured against. Each call yields the microtask queue before answering,
	 * which is what makes an overlap observable — a stub answering inside its own synchronous
	 * step would never show more than one call in flight.
	 */
	const concurrency = { inFlight: 0, peak: 0 }

	const answer = async (body: unknown, params?: Record<string, unknown>) => {
		concurrency.inFlight += 1
		concurrency.peak = Math.max(concurrency.peak, concurrency.inFlight)
		try {
			await Promise.resolve()
			return atPage(body, params)
		} finally {
			concurrency.inFlight -= 1
		}
	}

	return {
		concurrency,
		listCategories: vi.fn((params?: Record<string, unknown>) =>
			answer(responses.listCategories, params)
		),
		getCategory: vi.fn(() => answer(responses.getCategory)),
		listSectionsByCategory: vi.fn((id: number, params?: Record<string, unknown>) =>
			answer(responses.sectionsByCategory?.[id], params)
		),
		listArticlesBySection: vi.fn((id: number, params?: Record<string, unknown>) =>
			answer(responses.articlesBySection?.[id], params)
		),
	}
}

type StubbedClient = ReturnType<typeof stubClient>

/**
 * A list body as Zendesk sends it. `next_page` is a URL while there is another page and `null`
 * on the last one, which is the only signal the walk has that it is holding part of a list.
 */
const listBody = (key: string, entities: unknown[], more = false) => ({
	[key]: entities,
	next_page: more ? 'https://help.example.com/api/v2/help_center/next.json' : null,
})

/**
 * What this tool answers with. `ToolDefinition` erases every handler's return type to
 * `unknown` — tools return different shapes and share one array — so the narrowing happens
 * once here rather than at each assertion. The test knows which tool it called; the registry
 * deliberately does not.
 */
interface Hierarchy {
	truncated: boolean
	truncation_note?: string
	categories_returned: number
	sections_returned: number
	articles_returned?: number
	hierarchy: Array<{ sections: Array<Record<string, unknown>>; [key: string]: unknown }>
}

const walk = async (client: StubbedClient, params: Record<string, unknown> = {}) =>
	(await hierarchyTool.handler(client as unknown as ZendeskClient, params)) as Hierarchy

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

/** A tree of `categories` categories, each holding `sections` sections and no articles. */
const wideTree = (categories: number, sections: number) =>
	stubClient({
		listCategories: {
			categories: Array.from({ length: categories }, (_unused, index) => ({ id: index + 1 })),
		},
		sectionsByCategory: Object.fromEntries(
			Array.from({ length: categories }, (_unused, category) => [
				category + 1,
				{
					sections: Array.from({ length: sections }, (_unused2, index) => ({
						id: (category + 1) * 1000 + index,
					})),
				},
			])
		),
	})

describe('get_help_center_hierarchy', () => {
	it('counts the categories, sections and articles it brought back', async () => {
		const result = await walk(fullTree(), { include_articles: true })

		expect(result.categories_returned).toBe(2)
		expect(result.sections_returned).toBe(3)
		expect(result.articles_returned).toBe(3)
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

	it('keeps each category holding the sections that are actually its own', async () => {
		// The article pass runs flat across every section at once and is then cut back into the
		// categories the sections came from, so this is the assertion that catches a mis-cut.
		const result = await walk(fullTree(), { include_articles: true })

		expect(result.hierarchy[1]).toEqual({
			id: 2,
			name: 'Account',
			sections: [{ id: 20, name: 'Login', articles: [{ id: 200 }] }],
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

		it('does not report an articles_returned it never counted', async () => {
			const result = await walk(fullTree())

			expect(result).not.toHaveProperty('articles_returned')
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
			expect(result.categories_returned).toBe(1)
			expect(result.hierarchy[0].name).toBe('Billing')
		})

		it('walks nothing when the requested category is not in the body', async () => {
			const result = await walk(stubClient({ getCategory: {} }), { category_id: 99 })

			expect(result.hierarchy).toEqual([])
			expect(result.categories_returned).toBe(0)
			expect(result.sections_returned).toBe(0)
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
			expect(result.categories_returned).toBe(0)
		})

		it('treats a section body it cannot read as no sections', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: 'not a section list' },
			})

			const result = await walk(client)

			expect(result.hierarchy[0].sections).toEqual([])
			expect(result.sections_returned).toBe(0)
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

			expect(result.categories_returned).toBe(1)
			expect(result.hierarchy[0].name).toBe('Billing')
		})

		it('drops them at the section level', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: { sections: [{ id: 10 }, { name: 'no id' }] } },
			})

			const result = await walk(client)

			expect(result.sections_returned).toBe(1)
		})

		it('drops them at the article level', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: { sections: [{ id: 10 }] } },
				articlesBySection: { 10: { articles: [{ id: 100 }, 'not an article'] } },
			})

			const result = await walk(client, { include_articles: true })

			expect(result.articles_returned).toBe(1)
		})
	})

	describe('asking for whole pages', () => {
		// Sending no pagination at all is what made the old walk silently return the first 30 of
		// everything, so the size going out is the thing worth pinning.
		it('asks for the largest page Zendesk allows at every level', async () => {
			const client = fullTree()
			await walk(client, { include_articles: true })

			expect(client.listCategories).toHaveBeenCalledWith({ per_page: PAGE_SIZE, page: 1 })
			expect(client.listSectionsByCategory).toHaveBeenCalledWith(1, {
				per_page: PAGE_SIZE,
				page: 1,
			})
			expect(client.listArticlesBySection).toHaveBeenCalledWith(10, {
				per_page: PAGE_SIZE,
				page: 1,
			})
		})

		it('follows next_page and joins the pages together', async () => {
			const client = stubClient({
				listCategories: [
					listBody('categories', [{ id: 1 }], true),
					listBody('categories', [{ id: 2 }]),
				],
				sectionsByCategory: { 1: { sections: [] }, 2: { sections: [] } },
			})

			const result = await walk(client)

			expect(client.listCategories).toHaveBeenCalledTimes(2)
			expect(client.listCategories).toHaveBeenLastCalledWith({ per_page: PAGE_SIZE, page: 2 })
			expect(result.categories_returned).toBe(2)
			expect(result.truncated).toBe(false)
		})

		it('stops asking once next_page is null', async () => {
			const client = stubClient({
				listCategories: [listBody('categories', [{ id: 1 }])],
				sectionsByCategory: { 1: { sections: [] } },
			})

			await walk(client)

			expect(client.listCategories).toHaveBeenCalledTimes(1)
		})
	})

	describe('reporting what it could not reach', () => {
		it('says nothing about truncation when the walk was complete', async () => {
			const result = await walk(fullTree(), { include_articles: true })

			expect(result.truncated).toBe(false)
			expect(result).not.toHaveProperty('truncation_note')
		})

		it('stops a single list at the page limit and says so', async () => {
			// Six pages offered, five read. The sixth still advertises another after it, which is
			// exactly the case where reporting the count as a total would be a lie.
			const client = stubClient({
				listCategories: Array.from({ length: 6 }, (_unused, index) =>
					listBody('categories', [{ id: index + 1 }], true)
				),
				sectionsByCategory: Object.fromEntries(
					Array.from({ length: 6 }, (_unused, index) => [index + 1, { sections: [] }])
				),
			})

			const result = await walk(client)

			expect(client.listCategories).toHaveBeenCalledTimes(MAX_PAGES_PER_LIST)
			expect(result.categories_returned).toBe(MAX_PAGES_PER_LIST)
			expect(result.truncated).toBe(true)
		})

		it('stops the whole walk at the request ceiling', async () => {
			// One call lists the categories, so the ceiling leaves MAX_REQUESTS - 1 for sections.
			const client = wideTree(MAX_REQUESTS + 10, 1)

			const result = await walk(client)

			expect(client.listSectionsByCategory).toHaveBeenCalledTimes(MAX_REQUESTS - 1)
			expect(result.truncated).toBe(true)
		})

		it('still returns the part of the tree it did reach', async () => {
			const client = wideTree(MAX_REQUESTS + 10, 1)

			const result = await walk(client)

			expect(result.categories_returned).toBe(MAX_REQUESTS + 10)
			expect(result.sections_returned).toBe(MAX_REQUESTS - 1)
		})

		it('explains what was cut and how to narrow the request', async () => {
			const result = await walk(wideTree(MAX_REQUESTS + 10, 1))

			expect(result.truncation_note).toContain('incomplete')
			expect(result.truncation_note).toContain('category_id')
			expect(result.truncation_note).toContain('include_articles')
		})

		it('reads truncated before the hierarchy it applies to', async () => {
			// A model reads the response as text, and a flag underneath thousands of lines of
			// hierarchy is a flag nobody sees. Key order is what puts it on top.
			const result = await walk(wideTree(MAX_REQUESTS + 10, 1))

			expect(Object.keys(result)[0]).toBe('truncated')
			expect(Object.keys(result).at(-1)).toBe('hierarchy')
		})
	})

	describe('how many requests are in flight', () => {
		it('holds the category level to the bound', async () => {
			const client = wideTree(20, 0)

			await walk(client)

			expect(client.listSectionsByCategory).toHaveBeenCalledTimes(20)
			expect(client.concurrency.peak).toBe(MAX_IN_FLIGHT)
		})

		it('holds the article level to the same bound rather than squaring it', async () => {
			// Four categories of four sections is sixteen article calls. The nested Promise.all this
			// replaced issued all sixteen at once, and a bounded map nested inside another bounded
			// map would issue twenty-five — which is the bound quietly not holding.
			const client = wideTree(4, 4)

			await walk(client, { include_articles: true })

			expect(client.listArticlesBySection).toHaveBeenCalledTimes(16)
			expect(client.concurrency.peak).toBe(MAX_IN_FLIGHT)
		})
	})

	describe('when a request fails', () => {
		// The walk must not catch. `registerTools` wraps every handler in `withErrorHandling`, and
		// that wrapper is the only thing that can set `isError` — a handler resolving with an
		// error-shaped object reports a failed read as a successful call, which is the failure #28
		// removed from the write tools. Resolving also lost the detail it was trying to pass along,
		// since `JSON.stringify(new Error('boom'))` is `{}`.
		it('lets a failure at the category level reach the caller', async () => {
			const client = stubClient({})
			const failure = new Error('Zendesk request failed: Zendesk API Error: 503 - unavailable')
			client.listCategories.mockRejectedValue(failure)

			await expect(walk(client)).rejects.toThrow(failure)
		})

		it('lets a failure at the section level reach the caller', async () => {
			const client = fullTree()
			const failure = new Error('Zendesk request failed: Zendesk API Error: 429 - slow down')
			client.listSectionsByCategory.mockRejectedValue(failure)

			await expect(walk(client)).rejects.toThrow(failure)
		})

		it('does not answer with a hierarchy that reports the error as content', async () => {
			const client = fullTree()
			client.listArticlesBySection.mockRejectedValue(new Error('boom'))

			await expect(walk(client, { include_articles: true })).rejects.toThrow('boom')
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
