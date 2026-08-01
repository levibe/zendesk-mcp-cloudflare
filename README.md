# Zendesk MCP Server with Google OAuth

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that provides comprehensive Zendesk API integration with Google OAuth authentication, deployed on Cloudflare Workers.

The server allows MCP clients (like Claude Desktop) to interact securely with Zendesk APIs through authenticated remote connections. It reads across tickets, users, organizations, the Help Center and more, and writes only macros.

## Features

### Zendesk API Coverage

The server reads widely and writes only macros. Reading covers:

- **Tickets**: List, fetch and search support tickets
- **Users**: List, fetch and search users
- **Organizations**: List, fetch and search organizations
- **Groups**: List and fetch agent groups
- **Macros**: List and fetch ticket macros
- **Views**: List and fetch ticket views
- **Triggers**: List and fetch triggers
- **Automations**: List and fetch automations
- **Search**: Search across all Zendesk data
- **Help Center**: Browse and search the knowledge base — articles, sections and categories
- **Support**: General configuration information
- **Talk**: Access call center statistics
- **Chat**: Read chat conversations

Writing is limited to creating and updating macros. [Available Tools](#available-tools) explains why, and what happens if you ask for anything else.

### Technical Features

- **Google OAuth Authentication**: Secure user authentication flow
- **Remote MCP Protocol**: Server-Sent Events (SSE) connection for real-time communication
- **Cloudflare Workers**: Serverless deployment with global edge distribution
- **Type Safety**: Full TypeScript implementation with Zod validation
- **Error Handling**: Comprehensive error handling with user-friendly messages
- **Modular Architecture**: Easy to extend with additional tools

## Getting Started

### Prerequisites

- Zendesk instance with API access
- Google Cloud Platform account for OAuth
- Cloudflare account for deployment
- [pnpm](https://pnpm.io/installation), which this project uses as its package manager. The exact version is pinned in `package.json`, and recent versions of pnpm will switch to it for you.

### 1. Zendesk Setup

1. In your Zendesk Admin Center, go to Apps and integrations > APIs > Zendesk API
2. Enable token access and generate an API token
3. Note your Zendesk subdomain (e.g., `company` from `company.zendesk.com`)

### 2. Google OAuth Setup

#### For Production

Create a [Google Cloud OAuth App](https://cloud.google.com/iam/docs/workforce-manage-oauth-app):

- Homepage URL: `https://zendesk-mcp.<your-subdomain>.workers.dev`
- Authorization callback URL: `https://zendesk-mcp.<your-subdomain>.workers.dev/callback`
- Note your Client ID and generate a Client secret

#### For Local Development

Create a separate OAuth App for development:

- Homepage URL: `http://localhost:8788`
- Authorization callback URL: `http://localhost:8788/callback`

### 3. Environment Setup

Set production secrets via Wrangler:

```bash
pnpm exec wrangler secret put GOOGLE_CLIENT_ID
pnpm exec wrangler secret put GOOGLE_CLIENT_SECRET
pnpm exec wrangler secret put COOKIE_ENCRYPTION_KEY # Random string, e.g. openssl rand -hex 32
pnpm exec wrangler secret put ZENDESK_SUBDOMAIN
pnpm exec wrangler secret put ZENDESK_EMAIL
pnpm exec wrangler secret put ZENDESK_API_TOKEN
pnpm exec wrangler secret put HOSTED_DOMAIN # Optional: restrict to specific Google domain
```

For local development, create `.dev.vars`:

```
GOOGLE_CLIENT_ID=your_dev_client_id
GOOGLE_CLIENT_SECRET=your_dev_client_secret
ZENDESK_SUBDOMAIN=your_subdomain
ZENDESK_EMAIL=your_email@company.com
ZENDESK_API_TOKEN=your_api_token
```

### 4. KV Namespace Setup

```bash
pnpm exec wrangler kv namespace create "OAUTH_KV"
# Update wrangler.jsonc with the returned KV ID
```

### 5. Deploy & Test

#### Deploy to Production

```bash
pnpm install
pnpm run deploy
```

#### Local Development

```bash
pnpm install
pnpm run dev
```

#### Test with MCP Inspector

```bash
pnpm dlx @modelcontextprotocol/inspector
```

The cooldown in `pnpm-workspace.yaml` applies here too, so this resolves to the newest inspector released more than a week ago rather than the absolute newest.

- For production: Enter `https://zendesk-mcp.<your-subdomain>.workers.dev/sse`
- For local: Enter `http://localhost:8788/sse`

Complete the authentication flow and you'll see the tools the server publishes.

## Claude Desktop Integration

Add to your Claude Desktop configuration file. Leave the command below as `npx`, not `pnpm dlx`: it runs on your own machine when Claude Desktop starts the server, where Node ships `npx` but pnpm may not be installed at all.

```json
{
	"mcpServers": {
		"zendesk": {
			"command": "npx",
			"args": ["mcp-remote", "https://zendesk-mcp.<your-subdomain>.workers.dev/sse"]
		}
	}
}
```

After restarting Claude Desktop, authenticate via the browser flow. You can then ask Claude to:

- "Show me the latest support tickets"
- "Search for tickets about billing problems"
- "List all users in the Sales organization"
- "Draft a macro that solves a ticket and thanks the customer"

## Available Tools

The server reads widely and writes almost nothing.

**Reading** covers tickets, users, organizations, groups, macros, views, triggers, automations, Talk statistics, Chat conversations and the whole Help Center — listing them, fetching one by ID, and searching. Anything named `list_*`, `get_*` or `search_*` is available, along with `search` and `support_info`.

**Writing** is limited to `create_macro` and `update_macro`. A macro is a shortcut an agent applies to a ticket by hand, so creating one changes nothing on its own — which is why these two are permitted where nothing else is.

**Everything else is refused.** Creating, updating and deleting a ticket, and creating a user, an organization or a group, are all written and working in the code but never offered to a client, so asking for them will not work. Nothing else writes at all — deleting a macro, for instance, was never built as a tool. The server logs what it withheld each time it starts.

The permitted set is decided in `src/utils/tool-registry.ts`, and the tools themselves are defined under `src/tools/`. See CLAUDE.md for how a tool gets permitted.

## Development

### Adding New Tools

To extend with additional Zendesk tools:

1. Add API methods to `ZendeskClient` in `src/zendesk-client.ts`
2. Create tool definitions in appropriate `src/tools/` file
3. Export tools from `src/tools/index.ts`

Example:

```typescript
// In src/tools/custom.ts
export const customTools: ToolDefinition[] = [
	createTool(
		'my_custom_tool',
		'Description of what this tool does',
		{ param: z.string().describe('Parameter description') },
		async (client: ZendeskClient, { param }) => {
			return client.myCustomMethod(param)
		}
	),
]
```

### Project Structure

```
src/
├── index.ts              # Main entry point
├── google-handler.ts     # OAuth handler
├── zendesk-client.ts     # Zendesk API client
├── tools/                # MCP tool definitions
├── types/                # TypeScript types
└── utils/                # Utilities and helpers
```

## Architecture

This server demonstrates a clean architecture for remote MCP servers:

- **OAuth Provider**: Handles secure authentication with Google
- **API Client**: Cloudflare Workers-compatible HTTP client
- **Tool Registry**: Modular tool organization and registration
- **Error Handling**: Functional approach with consistent error responses
- **Type Safety**: Full TypeScript with runtime validation

This pattern can be adapted for other APIs by:

1. Replacing `ZendeskClient` with your API client
2. Creating new tool definitions in `src/tools/`
3. Updating environment variables and configuration

## Support

For issues and questions:

- Check the [MCP documentation](https://modelcontextprotocol.io/)
- Review [Cloudflare Workers docs](https://developers.cloudflare.com/workers/)
- Consult [Zendesk API documentation](https://developer.zendesk.com/api-reference/)
