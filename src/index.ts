import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { GoogleHandler } from './google-handler'
import { ZendeskClient } from './zendesk-client'
import { toolCategories } from './tools'
import { announceWithheldTools, registerAllTools } from './utils/tool-registry'
import { resolveCeilings, type ResolvedCeilings } from './utils/tool-ceilings'

/**
 * Whether this isolate has announced its ceilings yet. The announcement wants saying once,
 * but the ceilings come from `env`, which module scope never sees — so the guard lives here
 * and the announcement happens on the first request instead of at startup. Two first
 * requests racing can double-log; that is benign and not worth a lock.
 */
let announced = false

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
const createServer = (env: Env, ceilings: ResolvedCeilings['ceilings']) => {
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

	registerAllTools(server, new ZendeskClient(undefined, env), toolCategories, ceilings)

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
	fetch: (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
		// Resolved once per request, like the server itself — it is a small parse of a small
		// object, and per-request is what keeps a config-only deploy taking effect without a
		// special path. Malformed or missing config fails closed to read on every group.
		const resolved = resolveCeilings(env.TOOL_CEILINGS, Object.keys(toolCategories))

		// The refusal is logged on every request it affects, not once behind the flag below:
		// failing closed is otherwise invisible, and one line per affected request is the
		// representative loudness for a config that is broken right now.
		if (resolved.error) {
			console.error(`TOOL_CEILINGS refused (${resolved.error}); every group falls closed to read`)
		}

		if (!announced) {
			announced = true
			announceWithheldTools(toolCategories, resolved)
		}

		return createMcpHandler(() => createServer(env, resolved.ceilings), { route: '/mcp' })(
			request,
			env,
			ctx
		)
	},
}

export default new OAuthProvider({
	apiHandlers: {
		'/mcp': mcpHandler,
	},
	authorizeEndpoint: '/authorize',
	clientRegistrationEndpoint: '/register',
	defaultHandler: GoogleHandler,
	// Four hundred days, and it exists only to stay out of the way of the grant below. A grant is
	// swept once the client it was issued against is gone, and this TTL is stamped at
	// registration and never rolls forward on use, so whichever of the two is shorter is what
	// actually bounds a session. Left at its ninety-day default it would end every session at
	// ninety days no matter what the grant said — the same outage, arriving from the side nobody
	// was looking at.
	//
	// The thirty-five days of headroom over the grant is sized to how clients are actually
	// minted rather than to anything in the spec: a connector registers a fresh client each time
	// it connects, so a client and the grant issued against it are minutes apart in practice.
	// The cushion covers that gap. It would not cover a client reused for a new grant a year
	// later, which is worth re-deriving rather than assuming if a client ever starts being
	// long-lived.
	clientRegistrationTTL: 34_560_000,
	// A year. Thirty days was a library default nobody chose, and this is the deliberate number.
	//
	// It has to expire at all, which is the part worth defending, because `undefined` reads like
	// the obvious simplification. This is the only revocation there is. Every Zendesk call goes
	// out under one shared service account, so a grant is a bearer credential for the whole
	// published tool surface rather than for one person's own access, and nothing re-checks
	// Google once it has been issued — no `tokenExchangeCallback` is configured, so disabling
	// somebody's Google account does not reach a grant they already hold. A year is therefore
	// also the window a departed colleague keeps full access for, which is the cost this number
	// buys and the thing #91 is what actually fixes.
	refreshTokenTTL: 31_536_000,
	tokenEndpoint: '/token',
})
