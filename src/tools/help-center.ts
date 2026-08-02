/**
 * Help Center tools for managing knowledge base articles, categories, and sections
 */

import { z } from 'zod'
import type { ToolDefinition } from '../types/zendesk'
import { paginationSchema, sortingSchema, idSchema } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { executeSearchWithStandardizedResponse } from '../utils/search-response'
import { isRecord } from '../utils/narrow'

/**
 * A category, section or article as `get_help_center_hierarchy` uses it. That tool is the
 * only one here that reads into a response body rather than handing it straight to
 * JSON.stringify, so it is the only one that has to say what it expects back. All it needs
 * is the `id` to fetch the level below; everything else rides along to the caller untouched.
 */
interface HelpCenterEntity {
	id: number
	[key: string]: unknown
}

const isHelpCenterEntity = (value: unknown): value is HelpCenterEntity =>
	isRecord(value) && typeof value.id === 'number'

/**
 * Reads the entities stored under `key` out of a response body. Both shapes Zendesk uses are
 * accepted, because `getCategory` answers with a single `{ category: {...} }` where
 * `listCategories` answers with `{ categories: [...] }`. Entries without a numeric `id` are
 * dropped, since the hierarchy cannot fetch their children anyway — that keeps the `|| []`
 * this file relied on before the client started returning `unknown`.
 */
const readEntities = (response: unknown, key: string): HelpCenterEntity[] => {
	if (!isRecord(response)) return []

	const value = response[key]
	if (Array.isArray(value)) return value.filter(isHelpCenterEntity)
	return isHelpCenterEntity(value) ? [value] : []
}

/** A category with whatever sections the walk found beneath it. */
type CategoryNode = HelpCenterEntity & { sections: HelpCenterEntity[] }

/**
 * Zendesk's maximum page size, and the reason `get_help_center_hierarchy` asks for a size at
 * all. The default is 30 per page, and the walk used to send no pagination whatsoever — so on
 * any Help Center bigger than that it read page one at each level and then reported those
 * lengths as totals, with nothing in the answer to say they were not.
 */
const PAGE_SIZE = 100

/**
 * How many pages of a single list the walk will read. Five at 100 apiece is 500 categories, or
 * 500 sections under one category, which is well past the point where handing the lot to a
 * model is any use.
 */
const MAX_PAGES_PER_LIST = 5

/**
 * The ceiling on requests for one whole walk, across every level and every page.
 *
 * With `include_articles` the fan-out is 1 + C + (C x S), which on a real Help Center reaches a
 * platform limit rather than an answer: Workers allows 50 subrequests per request on the Free
 * plan, 1000 on the paid ones. Forty keeps a healthy walk inside the smaller of those with room
 * to spare. It is not a guarantee under failure, because every GET is retried up to three times
 * and one list call meeting a wall of 503s spends more than one subrequest — but that walk ends
 * as a reported error, and an error is the outcome worth protecting. The jitter on the retry
 * ladder is not the same protection and does not stand in for this one: it spreads the retries
 * of a fan-out over time, where the problem here is how many first attempts the walk makes at
 * all, which nothing had bounded.
 *
 * Reaching this ceiling is not an error either. It sets `truncated` on the response, which is
 * the same thing the two page limits above do.
 */
const MAX_REQUESTS = 40

/**
 * How many of those requests may be in flight at once. Workers holds at most six connections
 * open per request and queues whatever else is asked for, so the nested `Promise.all` this
 * replaced never really issued a hundred requests in parallel — it built a queue nothing here
 * could see or bound. Five leaves a connection spare, and it is also what makes the ceiling
 * above mean anything, since a budget can only stop a walk that has not already asked for
 * everything it wants.
 */
const MAX_IN_FLIGHT = 5

/**
 * What the walk may still ask for, and whether anything was left unread.
 *
 * One object threaded through every level rather than a limit per level, because truncation is
 * a single fact about the answer: a caller needs to know the result is short, not which of the
 * three ceilings above cut it short. Every request the walk makes is spent from here.
 */
interface Budget {
	remaining: number
	truncated: boolean
}

/** Takes one request from the budget, or records that there was none left to take. */
const spend = (budget: Budget): boolean => {
	if (budget.remaining <= 0) {
		budget.truncated = true
		return false
	}

	budget.remaining -= 1
	return true
}

/**
 * Zendesk sets `next_page` to the URL of the page after this one, and to `null` on the last.
 * That field is the only thing that can tell the walk it is holding part of a list, so it is
 * where `truncated` ultimately comes from.
 *
 * Three answers rather than two, because "there is no next page" and "I cannot tell whether
 * there is one" are different facts and only one of them earns a complete result. A field that
 * is present but not a URL we could follow — a number, an object, an empty string — is the
 * second. Zendesk does not send that today, so this is about what the walk is entitled to
 * claim rather than a shape anyone has seen: the whole point of this tool reporting truncation
 * is that it stops asserting completeness it did not establish, and reading an unusable value
 * as `null` would put one such assertion back.
 */
type PageCursor = 'more' | 'last' | 'unreadable'

const nextPageOf = (response: unknown): PageCursor => {
	if (!isRecord(response) || response.next_page === null || response.next_page === undefined) {
		return 'last'
	}

	if (typeof response.next_page === 'string') {
		return response.next_page.length > 0 ? 'more' : 'unreadable'
	}

	return 'unreadable'
}

/**
 * Reads a paged list under `key` until Zendesk says there is no more, the page limit is
 * reached, or the budget runs out — marking the walk truncated in either of the last two cases.
 */
const collectPages = async (
	budget: Budget,
	key: string,
	fetchPage: (page: number) => Promise<unknown>
): Promise<HelpCenterEntity[]> => {
	const entities: HelpCenterEntity[] = []

	for (let page = 1; page <= MAX_PAGES_PER_LIST; page += 1) {
		if (!spend(budget)) return entities

		const response = await fetchPage(page)
		entities.push(...readEntities(response, key))

		const cursor = nextPageOf(response)
		if (cursor === 'last') return entities
		if (cursor === 'unreadable') {
			budget.truncated = true
			return entities
		}
	}

	budget.truncated = true
	return entities
}

/**
 * Runs `task` over every item, never more than `MAX_IN_FLIGHT` at a time, and answers in input
 * order however the tasks happen to finish.
 *
 * A handful of workers pulling from one shared cursor, which is all this needs and is why it is
 * written out here rather than taken from a dependency. `next` is read and advanced in the same
 * synchronous step, so no two workers can ever claim the same item.
 */
const mapWithLimit = async <T, R>(items: T[], task: (item: T) => Promise<R>): Promise<R[]> => {
	const results = new Array<R>(items.length)
	let next = 0

	const workers = Array.from({ length: Math.min(MAX_IN_FLIGHT, items.length) }, async () => {
		while (next < items.length) {
			const index = next
			next += 1
			results[index] = await task(items[index])
		}
	})

	await Promise.all(workers)
	return results
}

/** What the response says when it is handing back part of the Help Center rather than all of it. */
const TRUNCATION_NOTE =
	'This result is incomplete. The walk stops after ' +
	`${MAX_REQUESTS} requests, or ${MAX_PAGES_PER_LIST} pages of any one list, and it reached ` +
	'one of those limits. Categories, sections or articles are missing, and every count here ' +
	'describes only what came back rather than what exists. Ask again for a smaller slice to ' +
	'get a complete answer: pass category_id to walk a single category, or leave ' +
	'include_articles unset so the walk does not spend its requests on articles.'

export const helpCenterTools: ToolDefinition[] = [
	createTool(
		'list_articles',
		'List Help Center articles',
		{
			...paginationSchema,
			...sortingSchema,
		},
		async (client, params) => {
			return client.listArticles(params)
		}
	),

	createTool(
		'get_article',
		'Get a specific Help Center article by ID',
		{ id: idSchema.describe('Article ID') },
		async (client, { id }) => {
			return client.getArticle(id)
		}
	),

	createTool(
		'search_articles',
		'Search knowledge base articles and help content',
		{
			query: z.string().describe('Search query for articles (e.g., "password reset", "billing")'),
			...paginationSchema,
		},
		async (client, params) => {
			const { query, ...searchParams } = params
			return executeSearchWithStandardizedResponse(
				() => client.searchArticles({ query, ...searchParams }),
				'article'
			)
		}
	),

	// === CATEGORY TOOLS ===
	createTool(
		'list_categories',
		'List Help Center categories to understand content hierarchy',
		{
			...paginationSchema,
			...sortingSchema,
		},
		async (client, params) => {
			return client.listCategories(params)
		}
	),

	createTool(
		'get_category',
		'Get a specific Help Center category by ID',
		{ id: idSchema.describe('Category ID') },
		async (client, { id }) => {
			return client.getCategory(id)
		}
	),

	createTool(
		'search_categories',
		'Search Help Center categories to explore content organization',
		{
			query: z.string().describe('Search query for categories (e.g., "billing", "technical")'),
			...paginationSchema,
		},
		async (client, params) => {
			// Use general search with type filter for categories
			return executeSearchWithStandardizedResponse(
				() =>
					client.search(`type:topic ${params.query}`, {
						page: params.page,
						per_page: params.per_page,
					}),
				'category'
			)
		}
	),

	// === SECTION TOOLS ===
	createTool(
		'list_sections',
		'List Help Center sections (optionally filtered by category)',
		{
			category_id: z.number().optional().describe('Filter sections by category ID'),
			...paginationSchema,
			...sortingSchema,
		},
		async (client, params) => {
			if (params.category_id) {
				const { category_id, ...otherParams } = params
				return client.listSectionsByCategory(category_id, otherParams)
			}
			return client.listSections(params)
		}
	),

	createTool(
		'get_section',
		'Get a specific Help Center section by ID',
		{ id: idSchema.describe('Section ID') },
		async (client, { id }) => {
			return client.getSection(id)
		}
	),

	createTool(
		'search_sections',
		'Search Help Center sections to find specific content areas',
		{
			query: z
				.string()
				.describe('Search query for sections (e.g., "getting started", "troubleshooting")'),
			category_id: z.number().optional().describe('Limit search to specific category'),
			...paginationSchema,
		},
		async (client, params) => {
			// Build search query
			let searchQuery = `type:topic ${params.query}`
			if (params.category_id) {
				searchQuery += ` category:${params.category_id}`
			}

			return executeSearchWithStandardizedResponse(
				() =>
					client.search(searchQuery, {
						page: params.page,
						per_page: params.per_page,
					}),
				'section'
			)
		}
	),

	// === HIERARCHY NAVIGATION TOOLS ===
	createTool(
		'get_help_center_hierarchy',
		'Get the Help Center content hierarchy (categories > sections > articles). The walk is ' +
			'bounded, so a large Help Center comes back partial with truncated set to true — pass ' +
			'category_id to narrow it.',
		{
			include_articles: z
				.boolean()
				.optional()
				.describe('Include articles in the hierarchy (default: false)'),
			category_id: z.number().optional().describe('Limit to specific category'),
		},
		// There is no try/catch in here, and that is the point. `registerTools` wraps every handler
		// in `withErrorHandling`, which is the only thing that can put `isError` on a response — so
		// a handler that catches and resolves reports a failed walk to the model as a successful
		// call, which is the failure #28 took out of every write tool. The catch that used to sit
		// here made that worse by returning the caught value as `details`, and
		// `JSON.stringify(new Error('boom'))` is `{}`, so the detail it existed to surface was
		// empty every single time. Let it throw.
		async (client, params) => {
			const budget: Budget = { remaining: MAX_REQUESTS, truncated: false }

			let categories: HelpCenterEntity[]
			if (params.category_id === undefined) {
				categories = await collectPages(budget, 'categories', (page) =>
					client.listCategories({ per_page: PAGE_SIZE, page })
				)
			} else {
				// One named category. A single fetch has no pages beneath it, so this is the one
				// request spent outside `collectPages`. The budget is untouched at this point, so it
				// cannot come back empty.
				spend(budget)
				categories = readEntities(await client.getCategory(params.category_id), 'category')
			}

			const walked = await mapWithLimit(categories, async (category) => ({
				category,
				sections: await collectPages(budget, 'sections', (page) =>
					client.listSectionsByCategory(category.id, { per_page: PAGE_SIZE, page })
				),
			}))

			let hierarchy: CategoryNode[]
			let articlesReturned: number | undefined

			if (params.include_articles) {
				// Every section from every category as one flat pass. Nesting a bounded map inside
				// another would put MAX_IN_FLIGHT squared requests in flight, which is the bound
				// quietly not holding.
				const sections = walked.flatMap((entry) => entry.sections)
				const sectionsWithArticles = await mapWithLimit(sections, async (section) => ({
					...section,
					articles: await collectPages(budget, 'articles', (page) =>
						client.listArticlesBySection(section.id, { per_page: PAGE_SIZE, page })
					),
				}))

				articlesReturned = sectionsWithArticles.reduce(
					(sum, section) => sum + section.articles.length,
					0
				)

				// `mapWithLimit` answers in input order, and that is what lets one flat result be cut
				// back into the categories its sections came from.
				let cursor = 0
				hierarchy = walked.map(({ category, sections: own }) => {
					const slice = sectionsWithArticles.slice(cursor, cursor + own.length)
					cursor += own.length
					return { ...category, sections: slice }
				})
			} else {
				hierarchy = walked.map(({ category, sections }) => ({ ...category, sections }))
			}

			return {
				// `truncated` heads the record rather than trailing it. The hierarchy below can run to
				// thousands of lines, and a flag underneath that is a flag nobody reads. It is present
				// on a complete walk too, so `false` is something the caller sees rather than infers
				// from an absence.
				truncated: budget.truncated,
				...(budget.truncated && { truncation_note: TRUNCATION_NOTE }),
				// Named for what they are. These count what the walk brought back, which is the same
				// as the totals only when `truncated` is false — calling them totals is how the old
				// walk turned reading page one into a confident claim about the whole Help Center.
				categories_returned: hierarchy.length,
				sections_returned: hierarchy.reduce((sum, category) => sum + category.sections.length, 0),
				...(articlesReturned !== undefined && { articles_returned: articlesReturned }),
				hierarchy,
			}
		}
	),

	createTool(
		'list_articles_by_section',
		'List articles within a specific Help Center section',
		{
			section_id: idSchema.describe('Section ID'),
			...paginationSchema,
			...sortingSchema,
		},
		async (client, params) => {
			const { section_id, ...otherParams } = params
			return client.listArticlesBySection(section_id, otherParams)
		}
	),
]
