import { createMcpWorker } from './create-mcp-worker'
import { ZendeskClient } from './zendesk-client'
import { toolCategories } from './tools'

/**
 * Everything mechanical lives in `createMcpWorker` — the per-request server build, the
 * once-per-isolate ceilings announcement, the OAuth wiring. What is stated here is exactly
 * what is this deployment's to state: its identity, its client, its tool manifest, and its
 * risk posture. CLAUDE.md sets out the architecture under "The server holds nothing between
 * requests".
 */
export default createMcpWorker<Env, ZendeskClient>({
	server: {
		name: 'Zendesk API Server',
		version: '1.0.0',
		description: 'Remote MCP Server for interacting with the Zendesk API',
	},
	toolCategories,
	createClient: (env) => new ZendeskClient(undefined, env),
	ceilingsFrom: (env) => env.TOOL_CEILINGS,
	approvalDialog: {
		name: 'Momentum Zendesk MCP',
		description: 'Secure access to Zendesk APIs through Model Context Protocol.',
	},
	// A year, stated rather than defaulted, and it has to expire at all — `undefined` reads
	// like the obvious simplification and is not. This is the only revocation there is. Every
	// Zendesk call goes out under one shared service account, so a grant is a bearer credential
	// for the whole published tool surface rather than for one person's own access, and nothing
	// re-checks Google once it has been issued — no `tokenExchangeCallback` is configured, so
	// disabling somebody's Google account does not reach a grant they already hold. A year is
	// therefore also the window a departed colleague keeps full access for, which is the cost
	// this number buys and the thing #91 is what actually fixes.
	refreshTokenTTL: 31_536_000,
})
