/**
 * Two things in this file have behaviour to lose, and the rest hand a response straight to
 * JSON.stringify.
 *
 * `get_help_center_hierarchy` is the one tool that reads into a response body, so most of what
 * follows covers the walk and, through it, the `readEntities` narrowing that #10 put underneath
 * it — plus the three things the walk has to be honest about: what it paged, what it could not
 * reach, and that a failure is a failure.
 *
 * The article writes at the end are the other. An article is the only thing these tools build
 * that a customer reads directly, so what those tests hold is the draft flag and the fact that
 * nothing here can publish or change who is allowed to look.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { helpCenterTools } from './help-center'
import { createArticleSchema, updateArticleSchema } from '../types/zendesk'
import type {
	ArticleCreatePayload,
	ArticleTranslationUpdatePayload,
	ArticleUpdatePayload,
} from '../types/zendesk'
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
			answer(responses.listCategories, params),
		),
		getCategory: vi.fn(() => answer(responses.getCategory)),
		listSectionsByCategory: vi.fn((id: number, params?: Record<string, unknown>) =>
			answer(responses.sectionsByCategory?.[id], params),
		),
		listArticlesBySection: vi.fn((id: number, params?: Record<string, unknown>) =>
			answer(responses.articlesBySection?.[id], params),
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
			]),
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

		// The old walk chose between getCategory and listCategories on the truthiness of
		// category_id, so a caller asking for category 0 was silently handed the entire Help
		// Center instead. It now asks whether the parameter was given at all, so 0 is treated as
		// the request it was — and the real client refuses it, because validateId rejects
		// anything that is not a positive integer. That throw belongs to ZendeskClient and is
		// tested there; what this pins is the routing decision, which is the part that lives here
		// and the part that silently did the wrong thing.
		it('asks for category 0 rather than walking every category', async () => {
			const client = stubClient({
				getCategory: {},
				sectionsByCategory: {},
			})

			await walk(client, { category_id: 0 })

			expect(client.getCategory).toHaveBeenCalledWith(0)
			expect(client.listCategories).not.toHaveBeenCalled()
		})
	})

	describe('bodies it cannot read', () => {
		// Each of these walks nothing, and — the part worth asserting — none of them calls that
		// nothing a complete answer. A body with no readable list in it is the strongest case of
		// "I cannot tell", so reporting truncated: false here would be the tool claiming the Help
		// Center is empty on the strength of a response it could not read one field of.
		it.each([
			['null', null],
			['undefined', undefined],
			['a string', 'not a category list'],
			// What `request` substitutes for any 200 whose content type is not JSON. A record, so
			// it clears isRecord, but it carries neither the key nor a cursor.
			['the non-JSON placeholder', { success: true }],
			['a record missing the categories key', { next_page: null }],
		])('walks nothing and reports truncation when the category body is %s', async (_l, body) => {
			const result = await walk(stubClient({ listCategories: body }))

			expect(result.hierarchy).toEqual([])
			expect(result.categories_returned).toBe(0)
			expect(result.truncated).toBe(true)
			// "could not read" rather than "could not follow": none of these bodies had a marker
			// worth following, and the row below with a readable next_page: null is the one that
			// makes the difference concrete. The note has to diagnose the body, not the cursor.
			expect(result.truncation_note).toContain('could not read')
		})

		it('treats a section body it cannot read as no sections, and says the walk is partial', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }], next_page: null },
				sectionsByCategory: { 1: 'not a section list' },
			})

			const result = await walk(client)

			expect(result.hierarchy[0].sections).toEqual([])
			expect(result.sections_returned).toBe(0)
			expect(result.truncated).toBe(true)
		})

		// An empty list is a readable answer and has to stay one — it carries the key and a null
		// cursor. If this ever goes red alongside the block above, the unreadable check has been
		// widened until it swallows the ordinary empty case.
		it('reports a genuinely empty list as complete', async () => {
			const result = await walk(stubClient({ listCategories: { categories: [], next_page: null } }))

			expect(result.categories_returned).toBe(0)
			expect(result.truncated).toBe(false)
			expect(result).not.toHaveProperty('truncation_note')
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
					listBody('categories', [{ id: index + 1 }], true),
				),
				sectionsByCategory: Object.fromEntries(
					Array.from({ length: 6 }, (_unused, index) => [index + 1, { sections: [] }]),
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

		// A next_page that is present but not a URL we could follow leaves the walk unable to say
		// whether it holds the whole list. Reading that as "last page" is the one way left for
		// this tool to claim a completeness it never established, which is the thing the whole
		// change exists to stop — so it reports truncation instead. Zendesk sends a URL or null
		// and nothing else, so these shapes are about what the walk is entitled to claim rather
		// than a body anyone has had back.
		it.each([
			['an empty string', ''],
			['a number', 2],
			['a boolean', true],
			['an object', { page: 2 }],
		])('reports truncation when next_page is %s', async (_label, nextPage) => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }], next_page: nextPage },
				sectionsByCategory: { 1: { sections: [] } },
			})

			const result = await walk(client)

			// One page read, and no attempt to follow something it could not parse.
			expect(client.listCategories).toHaveBeenCalledTimes(1)
			expect(result.categories_returned).toBe(1)
			expect(result.truncated).toBe(true)
		})

		it('treats an absent next_page as the last page rather than as unreadable', async () => {
			const client = stubClient({
				listCategories: { categories: [{ id: 1 }] },
				sectionsByCategory: { 1: { sections: [] } },
			})

			const result = await walk(client)

			expect(result.truncated).toBe(false)
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

const createArticle = helpCenterTools.find((tool) => tool.name === 'create_article')!
const updateArticle = helpCenterTools.find((tool) => tool.name === 'update_article')!

/** What MCP validates against before either handler is called. */
const createArticlePayload = z.object({ section_id: z.number(), ...createArticleSchema })
const updateArticlePayload = z.object(updateArticleSchema)

/** Stands in for the client methods the article tools reach, under their declared signatures. */
const stubArticleClient = (article: unknown = { article: { id: 1, source_locale: 'en-us' } }) => ({
	getArticle: vi.fn(async (_id: number) => article),
	createArticle: vi.fn(async (_data: ArticleCreatePayload, _sectionId: number) => article),
	updateArticle: vi.fn(async (_id: number, _data: ArticleUpdatePayload) => article),
	updateArticleTranslation: vi.fn(
		async (_id: number, _locale: string, _data: ArticleTranslationUpdatePayload) => article,
	),
})

type StubbedArticleClient = ReturnType<typeof stubArticleClient>

const callArticleTool = (
	tool: typeof createArticle,
	client: StubbedArticleClient,
	params: Record<string, unknown>,
) => tool.handler(client as unknown as ZendeskClient, params)

/** The smallest article the schema accepts, so a test can vary one thing about it. */
const validArticle = {
	section_id: 7,
	title: 'Resetting your password',
	locale: 'en-us',
	permission_group_id: 3,
	user_segment_id: null,
}

describe('the article create schema', () => {
	it.each(['title', 'locale', 'permission_group_id', 'user_segment_id'])(
		'refuses an article that omits %s',
		(field) => {
			const { [field]: _omitted, ...withoutField } = validArticle as Record<string, unknown>

			expect(createArticlePayload.safeParse(withoutField).success).toBe(false)
		},
	)

	// Required and nullable rather than optional, which is the point. Null means everyone can
	// read it, and a caller has to have said so — an omitted visibility field is how an article
	// ends up more visible than anyone intended.
	it('takes a null user segment, meaning everybody, but only when it is stated', () => {
		expect(createArticlePayload.parse(validArticle).user_segment_id).toBeNull()
	})

	// The guardrail. No shape accepts `draft`, so a caller cannot ask for a published article,
	// and Zod strips what it does not declare — hence absence rather than a refusal.
	it('does not accept draft, so a caller cannot ask to publish', () => {
		expect(createArticlePayload.parse({ ...validArticle, draft: false })).not.toHaveProperty(
			'draft',
		)
	})

	// Pinned because it looks like an oversight and is not. Nothing inspects the body, because a
	// check written here would be a second sanitizer — worse than Zendesk's own and trusted more
	// for sitting closer to the model. What protects the reader is that the article is a draft
	// nobody sees until a human has read it. Inverting this test is how that decision changes.
	it('passes the body through unexamined, HTML and all', () => {
		const body = '<p>Hello</p><script>alert(1)</script>'

		expect(createArticlePayload.parse({ ...validArticle, body }).body).toBe(body)
	})
})

describe('the article update schema', () => {
	it('requires nothing, since Zendesk changes only the fields it is given', () => {
		expect(updateArticlePayload.parse({})).toEqual({})
	})

	// Editing what an article says is one thing; changing who may read it is another, and it is
	// the change nobody notices until a customer has read something internal. Both stay set at
	// creation. `locale` goes with them because it names which translation is being edited
	// rather than being a property of the article to revise.
	it.each(['permission_group_id', 'user_segment_id', 'locale', 'draft'])(
		'does not accept %s, so an update cannot change who sees the article',
		(field) => {
			expect(updateArticlePayload.parse({ [field]: 1 })).not.toHaveProperty(field)
		},
	)

	// Zendesk does not document whether sending label_names replaces the set or merges into it,
	// so the wording is chosen to be right either way: send them all. A caller sending only the
	// new label is correct in just one of the two cases.
	it('tells a caller to send the complete label list', () => {
		const wording = updateArticleSchema.label_names.unwrap().description ?? ''

		expect(wording).toMatch(/complete/i)
		expect(wording).not.toBe(createArticleSchema.label_names.unwrap().description)
	})
})

describe('create_article', () => {
	// The forced flag, which is what makes a schema that never accepts `draft` add up to an
	// article no customer can see.
	it('forces the article to a draft rather than leaving Zendesk to default it', async () => {
		const client = stubArticleClient()

		await callArticleTool(createArticle, client, validArticle)

		expect(client.createArticle.mock.calls[0][0].draft).toBe(true)
	})

	it('overrides a draft flag that reaches it anyway', async () => {
		const client = stubArticleClient()

		await callArticleTool(createArticle, client, { ...validArticle, draft: false })

		expect(client.createArticle.mock.calls[0][0].draft).toBe(true)
	})

	// An article is created inside a section, so Zendesk takes that id in the URL rather than in
	// the body. This is the one place an article write differs mechanically from every other.
	it('sends the section id as its own argument, not inside the payload', async () => {
		const client = stubArticleClient()

		await callArticleTool(createArticle, client, validArticle)

		const [payload, sectionId] = client.createArticle.mock.calls[0]
		expect(sectionId).toBe(7)
		expect(payload).not.toHaveProperty('section_id')
	})

	// Returning the response rather than a finished McpToolResponse is what keeps `isError`
	// reaching the client, since registerTools wraps every handler once already. #28.
	it('answers with what Zendesk sent back, not with a wrapped response', async () => {
		const created = { article: { id: 42 } }

		expect(await callArticleTool(createArticle, stubArticleClient(created), validArticle)).toBe(
			created,
		)
	})

	// A bare "created successfully" is what would leave a model believing the article is live.
	it('says in its confirmation that the article is only a draft', () => {
		expect(createArticle.successMessage).toMatch(/draft/i)
	})
})

describe('update_article', () => {
	// The article endpoint applies metadata only and silently ignores `title` and `body` — it
	// answers 200 with the article unchanged — so content routed there would read back as a
	// success and change nothing. The routing is the whole point of these three tests.
	it('sends a content change to the translation endpoint, aimed at the source locale', async () => {
		const client = stubArticleClient()

		await callArticleTool(updateArticle, client, { id: 42, title: 'Renamed' })

		expect(client.updateArticleTranslation).toHaveBeenCalledWith(42, 'en-us', {
			title: 'Renamed',
		})
		expect(client.updateArticle).not.toHaveBeenCalled()
	})

	it('sends a metadata change to the article endpoint without looking up the locale', async () => {
		const client = stubArticleClient()

		await callArticleTool(updateArticle, client, { id: 42, promoted: true })

		expect(client.updateArticle).toHaveBeenCalledWith(42, { promoted: true })
		expect(client.getArticle).not.toHaveBeenCalled()
		expect(client.updateArticleTranslation).not.toHaveBeenCalled()
	})

	it('splits a mixed update across both endpoints, content first', async () => {
		const client = stubArticleClient()

		await callArticleTool(updateArticle, client, { id: 42, title: 'Renamed', promoted: true })

		expect(client.updateArticleTranslation).toHaveBeenCalledWith(42, 'en-us', {
			title: 'Renamed',
		})
		expect(client.updateArticle).toHaveBeenCalledWith(42, { promoted: true })
		expect(client.updateArticleTranslation.mock.invocationCallOrder[0]).toBeLessThan(
			client.updateArticle.mock.invocationCallOrder[0],
		)
	})

	// The locale lookup is the one step of a content change that can fail before anything is
	// written, which is why content goes first: a refusal here leaves the article as it was.
	it('refuses a content change when the source locale cannot be read, before writing anything', async () => {
		const client = stubArticleClient({ article: { id: 42 } })

		await expect(
			callArticleTool(updateArticle, client, { id: 42, title: 'Renamed' }),
		).rejects.toThrow('source locale')
		expect(client.updateArticleTranslation).not.toHaveBeenCalled()
		expect(client.updateArticle).not.toHaveBeenCalled()
	})

	// Zendesk accepts an update with nothing in it and changes nothing, which reads back as a
	// success. A model that sent no fields meant to send some, so say that instead.
	it('refuses an update that changes nothing rather than calling Zendesk', async () => {
		const client = stubArticleClient()

		await expect(callArticleTool(updateArticle, client, { id: 42 })).rejects.toThrow(
			'update_article needs at least one field to change',
		)
		expect(client.updateArticle).not.toHaveBeenCalled()
		expect(client.updateArticleTranslation).not.toHaveBeenCalled()
	})

	it('carries the confirmation registration heads the article with', () => {
		expect(updateArticle.successMessage).toBe('Article updated successfully!')
	})
})
