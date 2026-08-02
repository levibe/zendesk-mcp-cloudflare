/**
 * Registration is the only thing standing between a write tool and a client, so what it
 * publishes is a security boundary rather than a detail of how tools are wired together.
 * A tool that is defined but never registered cannot be called; one that slips through can.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MockInstance } from 'vitest'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ZendeskClient } from '../zendesk-client'
import type { McpToolResponse, ToolDefinition } from '../types/zendesk'
import { toolCategories } from '../tools'
import {
	announceWithheldTools,
	createTool,
	isReadOnlyTool,
	isToolPublished,
	registerAllTools,
	registerTools,
} from './tool-registry'

const stubServer = () => ({ registerTool: vi.fn() })

type StubbedServer = ReturnType<typeof stubServer>

const register = (server: StubbedServer, tools: ToolDefinition[]) =>
	registerTools(server as unknown as McpServer, {} as ZendeskClient, tools)

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

	// A description reaching the server used to depend on argument position: SDK v1 chose an
	// overload by shape, so passing the schema one place early silently selected the one taking
	// no description, and every client had to choose between 36 tools by name alone. v2 names
	// the field instead, so that particular slip cannot recur — this stays because the property
	// it was protecting is what matters, not the mechanism that once broke it.
	it('passes the description along, not just the name and the schema', () => {
		const server = stubServer()
		const tool = namedTool('list_macros')

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

	it('never offers a withheld tool to the server at all', () => {
		const server = stubServer()

		register(server, [namedTool('delete_macro'), namedTool('create_ticket')])

		expect(server.registerTool).not.toHaveBeenCalled()
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

describe('registerAllTools, over every tool the server defines', () => {
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

	it('reports every withheld name back to the caller', () => {
		const withheld = registerAllTools(
			stubServer() as unknown as McpServer,
			{} as ZendeskClient,
			toolCategories
		)

		expect(withheld).toContain('delete_ticket')
		expect(withheld).not.toContain('create_macro')
	})
})

describe('announceWithheldTools', () => {
	// Created in a beforeEach because restoreMocks undoes it between tests, and one made at
	// module scope would be gone before the first test ran.
	let log: MockInstance<typeof console.log>

	beforeEach(() => {
		log = vi.spyOn(console, 'log').mockImplementation(() => {})
	})

	it('says what it withheld and what it let through', () => {
		announceWithheldTools(toolCategories)

		expect(log).toHaveBeenCalledWith(
			expect.stringContaining('Permitted writes: create_macro, update_macro')
		)
		expect(log).toHaveBeenCalledWith(expect.stringContaining('delete_ticket'))
	})

	// The reason this is a function of the definitions rather than a side effect of registering:
	// since #40 the server is rebuilt per request, so announcing from inside registration would
	// repeat the whole list on every tool call.
	it('needs no server, so it can be said once at startup', () => {
		announceWithheldTools(toolCategories)

		expect(log).toHaveBeenCalledTimes(1)
	})

	it('stays quiet when nothing is withheld', () => {
		announceWithheldTools({ reads: [namedTool('list_macros')] })

		expect(log).not.toHaveBeenCalled()
	})
})
