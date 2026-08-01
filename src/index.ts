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
 * MCP revision 2026-07-28 removed protocol-level sessions, so there is no longer a
 * connection for a server instance to belong to. SDK v2 enforces that directly: a `Server`
 * that has already been connected to a transport refuses a second transport, which turns a
 * module-scope singleton from something that happened to work into an error on the second
 * request. Constructing here is what the factory is for.
 *
 * The client is built per request for the same reason, and costs nothing to make — it holds
 * configuration read from `env` and opens no connection of its own.
 */
const createServer = (env: Env) => {
	const server = new McpServer({
		name: 'Zendesk API Server',
		version: '1.0.0',
	})

	registerAllTools(server, new ZendeskClient(undefined, env), toolCategories)

	return server
}

/**
 * Streamable HTTP at /mcp, with no Durable Object behind it.
 *
 * `/sse` is gone. The HTTP+SSE transport it served was superseded in 2025-03-26 and this
 * revision reclassifies it as formally deprecated, but the reason to drop it now rather than
 * run it out its deprecation window is that it was the only thing still requiring the
 * Durable Object — keeping the route meant keeping McpAgent, the migration and the session
 * storage underneath it, which is the whole of what this change removes.
 *
 * Older clients are not stranded by that. `createMcpHandler` defaults to `legacy:
 * 'stateless'`, so a request that arrives without the 2026-07-28 envelope is still answered
 * from this same factory over streamable HTTP. What no longer works is a client that can
 * speak nothing but HTTP+SSE.
 *
 * The wrapper is not ceremony. `OAuthProvider` calls `fetch(request, env, ctx)`, while the
 * handler's own `fetch` takes `(request, options)` — passing the handler straight through
 * would land `env` in the options argument. Calling the handler itself, which does take the
 * three, is what keeps `ctx.props` reaching `getMcpAuthContext()` inside a tool.
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
