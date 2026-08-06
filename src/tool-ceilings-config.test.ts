/**
 * The shipped configuration, held to the code it configures. These tests are deliberately
 * coupled to this repo's wrangler.jsonc and its real tool manifest — they are what makes a
 * bad TOOL_CEILINGS or a drifted published surface fail `validate` before it can deploy —
 * so they live here rather than with the registry's own tests, and they stay in this repo
 * whatever else the registry machinery does.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { parse } from 'jsonc-parser'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ZendeskClient } from './zendesk-client'
import { toolCategories } from './tools'
import {
	announceWithheldTools,
	registerAllTools,
	resolveCeilings,
} from '@levibe/mcp-worker/registry'
import wranglerJsonc from '../wrangler.jsonc?raw'

const stubServer = () => ({ registerTool: vi.fn() })

type StubbedServer = ReturnType<typeof stubServer>

const publishedBy = (server: StubbedServer): string[] =>
	server.registerTool.mock.calls.map(([name]) => name as string)

/**
 * The ceilings the production worker actually ships, read from wrangler.jsonc itself rather
 * than restated here — restating them would let the file and the test drift apart, and the
 * drift is exactly what the pinned inventory below exists to catch.
 */
const shippedCeilings = () => {
	const config = parse(wranglerJsonc) as { vars: { TOOL_CEILINGS: unknown } }

	return resolveCeilings(config.vars.TOOL_CEILINGS, Object.keys(toolCategories))
}

/**
 * Fail-closed is silent in production — a malformed var deploys fine and every write quietly
 * vanishes — so this is what makes a bad TOOL_CEILINGS fail `validate` before it can deploy,
 * and it parses wrangler.jsonc itself rather than a copy of it.
 */
describe('the TOOL_CEILINGS wrangler.jsonc ships', () => {
	it('resolves against the real tool groups without falling closed', () => {
		expect(shippedCeilings().error).toBeUndefined()
	})

	// Deliberately pinned: macros at stage and nothing else above read is the shipped policy,
	// so raising any ceiling has to arrive as an edit to this test that somebody justifies.
	it('permits staging macros and nothing else beyond reads', () => {
		const { ceilings } = shippedCeilings()

		expect(ceilings.macros).toBe('stage')

		const raised = Object.entries(ceilings).filter(([, ceiling]) => ceiling !== 'read')
		expect(raised).toEqual([['macros', 'stage']])
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
})

describe('announceWithheldTools, over the manifest this repo ships', () => {
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

	// The refusal itself is logged per affected request by createMcpWorker, not here — this
	// runs once per isolate, so erroring from it would understate a config that is broken
	// right now. The announcement's job is naming the fallback the refusal caused.
	it('announces the read-only fallback of a refused config without logging the refusal', () => {
		const refused = resolveCeilings(undefined, Object.keys(toolCategories))

		announceWithheldTools(toolCategories, refused)

		expect(log).toHaveBeenCalledWith(expect.stringContaining('macros=read'))
		expect(error).not.toHaveBeenCalled()
	})
})
