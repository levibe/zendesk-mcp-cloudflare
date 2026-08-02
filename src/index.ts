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
 * Do not, and know that nothing will tell you so. `Server.connect` reassigns its transport
 * without complaint, and the SDK's one single-use check guards the transport rather than the
 * server, so it never fires when a fresh transport is built per request anyway. A shared
 * instance then answers sequential requests perfectly correctly, which is what local testing
 * and a quiet staging environment both produce.
 *
 * It comes apart under concurrency, through the teardown rather than the dispatch. Finishing
 * an exchange closes the server, and a close runs `abort` over every request handler still in
 * flight on that instance; those handlers drop their results, and the HTTP requests waiting on
 * them never settle. So the endpoint keeps answering while some fraction of traffic silently
 * fails to come back — which is a far worse thing to debug than an exception would be. Do not
 * reason from which request "wins": the one that survives tracks completion order rather than
 * arrival order, and guessing at it is how this comment has been wrong before.
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
		// Five minutes, rather than the `ttlMs: 0` the SDK fills in for a server it knows nothing
		// about. This list earns a cache because it does not vary: `toolCategories` is a fixed
		// literal, both allowlists are compile-time constants, and registration never consults the
		// authenticated user, so every caller gets the same bytes until there is a deploy.
		//
		// Five rather than sixty because this TTL is the only staleness bound there is — nothing
		// here can tell a client the list has changed, for the reasons CLAUDE.md sets out. So the
		// number is really an answer to "how long may a client go on offering a tool we removed",
		// and it should be read that way before anyone raises it.
		//
		// `private` keeps the whole of the benefit, which is a client not re-fetching its own
		// list. `public` would add only sharing through an intermediary, and there is none here.
		{ cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'private' } } }
	)

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
