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
 * connection for a server instance to belong to. `createMcpHandler` calls this factory once
 * per request by contract, which is the whole of the guarantee — nothing at runtime stops a
 * caller hoisting an `McpServer` to module scope and closing over it instead.
 *
 * Do not, and know what goes wrong if you do, because it is not what you would expect.
 * `Server.connect` overwrites `_transport` without complaint, so a shared instance answers
 * sequential requests perfectly well and looks fine in local testing. The damage shows up
 * only under concurrency: each new `connect` takes the transport away from whatever exchange
 * is still in flight, leaving it with nowhere to send its response. Every request but the
 * newest hangs, and the newest always returns normally — so the endpoint goes on looking
 * healthy while requests are quietly stranded behind it. The single-use check that does exist
 * guards the transport rather than the server, and never fires here, since a fresh transport
 * is built per request either way.
 *
 * The client is built per request for the same reason, and costs nothing to make — it holds
 * configuration read from `env` and opens no connection of its own.
 */
const createServer = (env: Env) => {
	const server = new McpServer({
		name: 'Zendesk API Server',
		version: '1.0.0',
		description: 'Remote MCP Server for interacting with the Zendesk API',
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
 *
 * Origin checking is left at its default, which is deliberate rather than overlooked. A
 * request carrying no `Origin` header always passes, so every client that reaches this
 * server today is unaffected: Anthropic's connector fetches server-side, and `mcp-remote` and
 * the Inspector proxy are both Node.
 *
 * A browser-based client is a different matter, and what the default permits depends on where
 * this is deployed. It accepts localhost, plus the endpoint's own hostname when that hostname
 * is a `workers.dev` address — so a page served by the worker itself can call it there, and a
 * custom domain is left with localhost alone. Anything else gets a 403 naming the origin and
 * saying nothing about transports. Widen it by naming hostnames in `allowedOriginHostnames`
 * rather than reaching for `'*'`, which turns the check off everywhere.
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
