import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
import type { Hono } from 'hono'
import { GoogleHandler } from './google-handler'
import { ZendeskClient } from './zendesk-client'
import { toolCategories } from './tools'
import { registerAllTools } from './utils/tool-registry'

// Context from the auth process, encrypted & stored in the auth token
// and provided to the MyMCP as this.props
type Props = {
	name: string;
	email: string;
	accessToken: string;
};

// Type for Cloudflare Workers fetch handler
type FetchHandler = (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> | Response;

// Type for Hono app that can be used as a handler
type HonoHandler = Hono<any> | { fetch: FetchHandler };

export class MyMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({
		name: 'Zendesk API Server',
		version: '1.0.0',
		description: 'Remote MCP Server for interacting with the Zendesk API'
	})

	private zendeskClient!: ZendeskClient

	async init () {
		// Initialize Zendesk client with environment variables
		this.zendeskClient = new ZendeskClient(undefined, this.env)

		// Register all tools using the new modular architecture
		registerAllTools(this.server, this.zendeskClient, toolCategories)
	}
}

export default new OAuthProvider({
	// Type assertion needed: OAuthProvider expects a generic handler interface
	// McpAgent.mount returns a compatible Durable Object handler
	apiHandler: MyMCP.mount('/sse') as FetchHandler,
	apiRoute: '/sse',
	authorizeEndpoint: '/authorize',
	clientRegistrationEndpoint: '/register',
	// GoogleHandler is a Hono app which implements the fetch handler interface
	defaultHandler: GoogleHandler as HonoHandler,
	tokenEndpoint: '/token',
})