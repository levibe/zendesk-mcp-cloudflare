/**
 * Registration is the only thing standing between a write tool and a client, so what it
 * publishes is a security boundary rather than a detail of how tools are wired together.
 * A tool that is defined but never registered cannot be called; one that slips through can.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { parse } from 'jsonc-parser'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ZendeskClient } from '../zendesk-client'
import type { McpToolResponse, ToolDefinition } from '../types/zendesk'
import { toolCategories } from '../tools'
import { resolveCeilings, type DeclarableLevel } from './tool-ceilings'
import { announceWithheldTools, createTool, registerAllTools, registerTools } from './tool-registry'
import wranglerJsonc from '../../wrangler.jsonc?raw'

const stubServer = () => ({ registerTool: vi.fn() })

type StubbedServer = ReturnType<typeof stubServer>

/** A `delete` ceiling publishes everything, for the tests where publication is not the subject. */
const register = (
	server: StubbedServer,
	tools: ToolDefinition[],
	ceiling: DeclarableLevel = 'delete'
) => registerTools(server as unknown as McpServer, {} as ZendeskClient, tools, ceiling)

const publishedBy = (server: StubbedServer): string[] =>
	server.registerTool.mock.calls.map(([name]) => name as string)

/** The wrapped handler the server was given, which is what a client's call actually runs. */
const handlerRegisteredBy = (server: StubbedServer): (() => Promise<McpToolResponse>) => {
	const [, , handler] = server.registerTool.mock.calls[0] as unknown as [
		string,
		unknown,
		() => Promise<McpToolResponse>,
	]

	return handler
}

const textOf = (response: McpToolResponse) => response.content[0].text

/** A tool of the given level that does nothing, since only its level decides its fate here. */
const levelledTool = (name: string, level: DeclarableLevel = 'read') =>
	createTool(name, level, `The ${name} tool`, {}, async () => ({}))

/**
 * The ceilings the production worker actually ships, read from wrangler.jsonc itself rather
 * than restated here — restating them would let the file and the test drift apart, and the
 * drift is exactly what the pinned inventory below exists to catch.
 */
const shippedCeilings = () => {
	const config = parse(wranglerJsonc) as { vars: { TOOL_CEILINGS: unknown } }

	return resolveCeilings(config.vars.TOOL_CEILINGS, Object.keys(toolCategories))
}

describe('registerTools', () => {
	it('publishes a tool whose level sits at or under the ceiling', () => {
		const server = stubServer()

		register(
			server,
			[levelledTool('list_macros', 'read'), levelledTool('create_macro', 'stage')],
			'stage'
		)

		expect(publishedBy(server)).toEqual(['list_macros', 'create_macro'])
	})

	it('withholds a tool whose level sits above the ceiling', () => {
		const server = stubServer()

		register(
			server,
			[levelledTool('create_ticket', 'write'), levelledTool('delete_ticket', 'delete')],
			'stage'
		)

		expect(server.registerTool).not.toHaveBeenCalled()
	})

	// The order is the vocabulary's one load-bearing fact — read < stage < write < delete —
	// so it is pinned pair by pair rather than trusted to the rank table staying sorted.
	it.each([
		['read', ['read']],
		['stage', ['read', 'stage']],
		['write', ['read', 'stage', 'write']],
		['delete', ['read', 'stage', 'write', 'delete']],
	] as const)('a %s ceiling publishes exactly the levels under it', (ceiling, published) => {
		const server = stubServer()
		const tools = (['read', 'stage', 'write', 'delete'] as const).map((level) =>
			levelledTool(`${level}_tool`, level)
		)

		register(server, tools, ceiling)

		expect(publishedBy(server)).toEqual(published.map((level) => `${level}_tool`))
	})

	it('reports the withheld names back to the caller', () => {
		const withheld = register(
			stubServer(),
			[
				levelledTool('get_macro', 'read'),
				levelledTool('delete_macro', 'delete'),
				levelledTool('create_ticket', 'write'),
			],
			'stage'
		)

		expect(withheld).toEqual(['delete_macro', 'create_ticket'])
	})

	// A description reaching the server used to depend on argument position: SDK v1 chose an
	// overload by shape, so passing the schema one place early silently selected the one taking
	// no description, and every client had to choose between 36 tools by name alone. v2 names
	// the field instead, so that particular slip cannot recur — this stays because the property
	// it was protecting is what matters, not the mechanism that once broke it.
	it('passes the description along, not just the name and the schema', () => {
		const server = stubServer()
		const tool = levelledTool('list_macros')

		register(server, [tool])

		expect(server.registerTool).toHaveBeenCalledWith(
			'list_macros',
			expect.objectContaining({ description: tool.description }),
			expect.any(Function)
		)
	})

	// v2 deprecates handing `registerTool` a bare `{ field: z.string() }` record, so the registry
	// wraps every shape before passing it on. Asserting the schema parses rather than asserting
	// on its internals keeps this from pinning how Zod represents an object.
	it('wraps the shape into a schema the server can validate against', () => {
		const server = stubServer()
		const tool = createTool(
			'list_macros',
			'read',
			'List macros',
			{ page: z.number().optional() },
			async () => ({})
		)

		register(server, [tool])

		const [, config] = server.registerTool.mock.calls[0] as unknown as [
			string,
			{ inputSchema: z.ZodType },
		]

		expect(config.inputSchema.parse({ page: 2 })).toEqual({ page: 2 })
	})

	it('wraps the handler so a failed call reaches the client as an error response', async () => {
		const server = stubServer()
		const tool = createTool('list_macros', 'read', 'List macros', {}, async () => {
			throw new Error('Zendesk API Error: 503 - unavailable')
		})

		register(server, [tool])

		await expect(handlerRegisteredBy(server)()).resolves.toEqual({
			content: [{ type: 'text', text: 'Error: Zendesk API Error: 503 - unavailable' }],
			isError: true,
		})
	})

	// A write's confirmation travels on the definition so that registration can apply it, since
	// registration owns the only wrapper that turns a result into a response. A handler wording
	// its own would be wrapped again on the way out — #28.
	it('heads the result with the success message the definition carries', async () => {
		const server = stubServer()
		const created = { macro: { id: 42 } }
		const tool = createTool(
			'create_macro',
			'stage',
			'Create a macro',
			{},
			async () => created,
			'Macro created successfully!'
		)

		register(server, [tool])

		expect(textOf(await handlerRegisteredBy(server)())).toBe(
			`Macro created successfully!\n\n${JSON.stringify(created)}`
		)
	})

	// The half of #28 that mattered: a rejected write has to arrive as a failure. The message is
	// applied on the success path only, so carrying one cannot dress an error up as a success.
	it('reports a failed write as an error rather than heading it as a success', async () => {
		const server = stubServer()
		const tool = createTool(
			'create_macro',
			'stage',
			'Create a macro',
			{},
			async () => {
				throw new Error('Zendesk API Error: 422 - RecordInvalid')
			},
			'Macro created successfully!'
		)

		register(server, [tool])
		const response = await handlerRegisteredBy(server)()

		expect(response.isError).toBe(true)
		expect(textOf(response)).toBe('Error: Zendesk API Error: 422 - RecordInvalid')
	})
})

describe('registerAllTools, under the ceilings wrangler.jsonc actually ships', () => {
	const publishShipped = () => {
		const server = stubServer()
		registerAllTools(
			server as unknown as McpServer,
			{} as ZendeskClient,
			toolCategories,
			shippedCeilings().ceilings
		)
		return publishedBy(server)
	}

	// The pinned inventory, and the review choke point the old central allowlist used to be.
	// Under ceilings, a level annotation in a tool file can publish itself into any group whose
	// ceiling already covers it, and that diff reads as routine plumbing — so the published
	// surface is asserted here exactly, in order, and any change to it has to arrive as an
	// explicit edit to this list that somebody justifies. The order matters too: it is the
	// deterministic tool list the tools/list cache reasoning leans on.
	it('publishes exactly the shipped surface, in registration order', () => {
		expect(publishShipped()).toEqual([
			'list_tickets',
			'get_ticket',
			'search_tickets',
			'list_users',
			'get_user',
			'search_users',
			'list_organizations',
			'get_organization',
			'search_organizations',
			'list_groups',
			'get_group',
			'list_macros',
			'get_macro',
			'create_macro',
			'update_macro',
			'list_views',
			'get_view',
			'list_triggers',
			'get_trigger',
			'list_automations',
			'get_automation',
			'search',
			'list_articles',
			'get_article',
			'search_articles',
			'list_categories',
			'get_category',
			'search_categories',
			'list_sections',
			'get_section',
			'search_sections',
			'get_help_center_hierarchy',
			'list_articles_by_section',
			'support_info',
			'get_talk_stats',
			'list_chats',
		])
	})

	it('reports every withheld name back to the caller', () => {
		const withheld = registerAllTools(
			stubServer() as unknown as McpServer,
			{} as ZendeskClient,
			toolCategories,
			shippedCeilings().ceilings
		)

		expect(withheld).toContain('delete_ticket')
		expect(withheld).not.toContain('create_macro')
	})

	// The runtime backstop for a category that lands in toolCategories before the shipped
	// TOOL_CEILINGS names it. The config test fails validate on that drift; this is what the
	// deployed worker does in the meantime, and it has to fail closed rather than open.
	it('treats a group the ceilings never named as read-only', () => {
		const server = stubServer()

		registerAllTools(
			server as unknown as McpServer,
			{} as ZendeskClient,
			{ widgets: [levelledTool('list_widgets', 'read'), levelledTool('create_widget', 'stage')] },
			{}
		)

		expect(publishedBy(server)).toEqual(['list_widgets'])
	})
})

describe('announceWithheldTools', () => {
	// Created in a beforeEach because restoreMocks undoes it between tests, and one made at
	// module scope would be gone before the first test ran.
	let log: MockInstance<typeof console.log>
	let error: MockInstance<typeof console.error>

	beforeEach(() => {
		log = vi.spyOn(console, 'log').mockImplementation(() => {})
		error = vi.spyOn(console, 'error').mockImplementation(() => {})
	})

	it('names every ceiling and what those ceilings withheld', () => {
		announceWithheldTools(toolCategories, shippedCeilings())

		expect(log).toHaveBeenCalledWith(expect.stringContaining('macros=stage'))
		expect(log).toHaveBeenCalledWith(expect.stringContaining('tickets=read'))
		expect(log).toHaveBeenCalledWith(expect.stringContaining('delete_ticket'))
	})

	it('says so when the ceilings withhold nothing', () => {
		announceWithheldTools(
			{ reads: [levelledTool('list_macros', 'read')] },
			{ ceilings: { reads: 'read' } }
		)

		expect(log).toHaveBeenCalledWith(expect.stringContaining('Withholding nothing'))
		expect(error).not.toHaveBeenCalled()
	})

	// Fail-closed is silent in production — the deploy succeeds and the write tools just
	// vanish — so the refused config surfacing here, loudly, is the only symptom there is.
	it('reports a refused config through console.error and announces the read-only fallback', () => {
		const refused = resolveCeilings(undefined, Object.keys(toolCategories))

		announceWithheldTools(toolCategories, refused)

		expect(error).toHaveBeenCalledWith(expect.stringContaining('TOOL_CEILINGS refused'))
		expect(log).toHaveBeenCalledWith(expect.stringContaining('macros=read'))
	})

	// The same read-only backstop registerAllTools applies, so the announcement never claims
	// more is published than registration would actually publish.
	it('counts a group the ceilings never named as withheld above read', () => {
		announceWithheldTools(
			{ widgets: [levelledTool('list_widgets', 'read'), levelledTool('create_widget', 'stage')] },
			{ ceilings: {} }
		)

		expect(log).toHaveBeenCalledWith(expect.stringContaining('create_widget'))
	})
})
