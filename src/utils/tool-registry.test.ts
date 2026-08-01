/**
 * Registration is the only thing standing between a write tool and a client, so what it
 * publishes is a security boundary rather than a detail of how tools are wired together.
 * A tool that is defined but never registered cannot be called; one that slips through can.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ZendeskClient } from '../zendesk-client'
import type { McpToolResponse, ToolDefinition } from '../types/zendesk'
import { toolCategories } from '../tools'
import {
	createTool,
	isReadOnlyTool,
	isToolPublished,
	registerAllTools,
	registerTools,
} from './tool-registry'

const stubServer = () => ({ tool: vi.fn() })

type StubbedServer = ReturnType<typeof stubServer>

const register = (server: StubbedServer, tools: ToolDefinition[]) =>
	registerTools(server as unknown as McpServer, {} as ZendeskClient, tools)

const publishedBy = (server: StubbedServer): string[] =>
	server.tool.mock.calls.map(([name]) => name as string)

/** A tool of the given name that does nothing, since only its name decides its fate here. */
const namedTool = (name: string) => createTool(name, `The ${name} tool`, {}, async () => ({}))

describe('isReadOnlyTool', () => {
	it.each(['list_macros', 'get_macro', 'search_tickets', 'search', 'support_info'])(
		'recognises %s as a read',
		(name) => {
			expect(isReadOnlyTool(name)).toBe(true)
		}
	)

	it.each(['create_macro', 'update_macro', 'delete_macro', 'add_tags'])(
		'does not recognise %s as a read',
		(name) => {
			expect(isReadOnlyTool(name)).toBe(false)
		}
	)
})

describe('isToolPublished', () => {
	it('publishes the two macro writes by name', () => {
		expect(isToolPublished('create_macro')).toBe(true)
		expect(isToolPublished('update_macro')).toBe(true)
	})

	// The whole point of naming tools one at a time rather than permitting a `create_` prefix:
	// permitting macro creation must not carry the next create tool anybody writes along with it.
	it('does not publish another write that merely looks like a permitted one', () => {
		expect(isToolPublished('create_trigger')).toBe(false)
		expect(isToolPublished('update_ticket')).toBe(false)
	})

	it('withholds macro deletion, which the set deliberately leaves out', () => {
		expect(isToolPublished('delete_macro')).toBe(false)
	})
})

describe('registerTools', () => {
	it('hands each published tool to the server under its own name', () => {
		const server = stubServer()

		register(server, [namedTool('list_macros'), namedTool('create_macro')])

		expect(publishedBy(server)).toEqual(['list_macros', 'create_macro'])
	})

	it('never offers a withheld tool to the server at all', () => {
		const server = stubServer()

		register(server, [namedTool('delete_macro'), namedTool('create_ticket')])

		expect(server.tool).not.toHaveBeenCalled()
	})

	it('reports the withheld names back to the caller', () => {
		const withheld = register(stubServer(), [
			namedTool('get_macro'),
			namedTool('delete_macro'),
			namedTool('create_ticket'),
		])

		expect(withheld).toEqual(['delete_macro', 'create_ticket'])
	})

	it('wraps the handler so a failed call reaches the client as an error response', async () => {
		const server = stubServer()
		const tool = createTool('list_macros', 'List macros', {}, async () => {
			throw new Error('Zendesk API Error: 503 - unavailable')
		})

		register(server, [tool])
		const [, , handler] = server.tool.mock.calls[0] as unknown as [
			string,
			unknown,
			() => Promise<McpToolResponse>,
		]

		await expect(handler()).resolves.toEqual({
			content: [{ type: 'text', text: 'Error: Zendesk API Error: 503 - unavailable' }],
			isError: true,
		})
	})
})

describe('registerAllTools, over every tool the server defines', () => {
	// Every call here announces what it withheld, which is noise in the other tests and the
	// subject of the last one. Created in a beforeEach because restoreMocks undoes it between
	// tests, and one made at module scope would be gone before the first test ran.
	let log: MockInstance<typeof console.log>

	beforeEach(() => {
		log = vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	const publishEverything = () => {
		const server = stubServer()
		registerAllTools(server as unknown as McpServer, {} as ZendeskClient, toolCategories)
		return publishedBy(server)
	}

	it('publishes the macro writes', () => {
		expect(publishEverything()).toEqual(expect.arrayContaining(['create_macro', 'update_macro']))
	})

	// The assertion that matters, and the reason it is written as a set difference rather than
	// as a list of the tools withheld today: a write added anywhere under src/tools fails this
	// the moment it is published, without anyone having to remember to name it here.
	it('publishes nothing else that is not a read', () => {
		const writes = publishEverything().filter((name) => !isReadOnlyTool(name))

		expect(writes.sort()).toEqual(['create_macro', 'update_macro'])
	})

	it('says on startup what it withheld and what it let through', () => {
		publishEverything()

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('Permitted writes: create_macro, update_macro')
		)
		expect(log).toHaveBeenCalledWith(expect.stringContaining('delete_ticket'))
	})
})
