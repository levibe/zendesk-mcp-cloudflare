import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { GoogleHandler } from './google-handler'
import { ZendeskClient } from './zendesk-client'
import { toolCategories } from './tools'
import { announceWithheldTools, registerAllTools } from './utils/tool-registry'

/**
 * Said once when the isolate starts rather than once per request. See the function itself
 * for why it does not ride along with registration any more.
 */
announceWithheldTools(toolCategories)

/**
 * Builds the server that answers one request, and only one.
 *
 * Never hoist this to module scope, and know that nothing at runtime will tell you so. A
 * shared instance answers sequential requests perfectly correctly, which is what local
 * testing produces; it comes apart only under concurrency, because closing the server at the
 * end of one exchange aborts every handler still in flight on it and those requests never
 * settle. CLAUDE.md sets the whole argument out under "The server holds nothing between
 * requests".
 *
 * The client is built per request for the same reason, and costs nothing to make — it holds
 * configuration read from `env` and opens no connection of its own.
 */
const createServer = (env: Env) => {
	const server = new McpServer(
		{
			name: 'Zendesk API Server',
			version: '1.0.0',
			description: 'Remote MCP Server for interacting with the Zendesk API',
		},
		// Five minutes. This TTL is the only bound on staleness there is, because nothing here
		// can tell a client the list has changed, so read the number as an answer to "how long
		// may a client go on offering a tool we have removed" before raising it. `private`
		// because the only benefit available is a client not re-fetching its own list. CLAUDE.md
		// has the rest, under "The tool list's TTL is the only staleness bound".
		{ cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'private' } } }
	)

	registerAllTools(server, new ZendeskClient(undefined, env), toolCategories)

	return server
}

/**
 * Streamable HTTP at /mcp, with no Durable Object behind it.
 *
 * The wrapper is not ceremony. `OAuthProvider` calls `fetch(request, env, ctx)` while the
 * handler's own `fetch` takes `(request, options)`, so passing the handler straight through
 * would land `env` in the options argument. Calling the handler itself, which does take the
 * three, is what keeps `ctx.props` reaching `getMcpAuthContext()` inside a tool.
 *
 * Origin checking is left at its default deliberately, and what that permits a browser
 * depends on where this is deployed — see CLAUDE.md, which also records why `/sse` is gone.
 */
const mcpHandler = {
	fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> =>
		createMcpHandler(() => createServer(env), { route: '/mcp' })(request, env, ctx),
}

export default new OAuthProvider({
	apiHandlers: {
		'/mcp': mcpHandler,
	},
	authorizeEndpoint: '/authorize',
	clientRegistrationEndpoint: '/register',
	defaultHandler: GoogleHandler,
	tokenEndpoint: '/token',
})
