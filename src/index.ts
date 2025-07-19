import OAuthProvider from '@cloudflare/workers-oauth-provider'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { McpAgent } from 'agents/mcp'
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
	apiHandler: MyMCP.mount('/sse') as any,
	apiRoute: '/sse',
	authorizeEndpoint: '/authorize',
	clientRegistrationEndpoint: '/register',
	defaultHandler: GoogleHandler as any,
	tokenEndpoint: '/token',
})