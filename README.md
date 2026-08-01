# Zendesk MCP Server with Google OAuth

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that provides comprehensive Zendesk API integration with Google OAuth authentication, deployed on Cloudflare Workers.

The server allows MCP clients (like Claude Desktop) to interact securely with Zendesk APIs through authenticated remote connections, providing tools for ticket management, user administration, search, and more.

## Features

### Zendesk API Coverage

- **Tickets**: Create, read, update, delete support tickets
- **Users**: Manage users and user profiles
- **Organizations**: Handle organization data
- **Groups**: Manage agent groups
- **Macros**: Access and manage ticket macros
- **Views**: Work with ticket views
- **Triggers**: Manage automation triggers
- **Automations**: Handle automated workflows
- **Search**: Search across all Zendesk data
- **Help Center**: Manage knowledge base articles
- **Support**: General support operations
- **Talk**: Access call center data
- **Chat**: Manage chat interactions

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

If you put the worker behind a custom domain, register that hostname here too. The worker builds its callback from whichever host the request arrived on, so connecting through `https://zendesk.example.com/mcp` sends Google a redirect URI of `https://zendesk.example.com/callback`. Registering only the `workers.dev` hostname is easy to misdiagnose, because every endpoint on the worker keeps answering normally and the flow fails at the Google consent screen with `redirect_uri_mismatch`.

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

- For production: Enter `https://zendesk-mcp.<your-subdomain>.workers.dev/mcp`
- For local: Enter `http://localhost:8788/mcp`

Complete the authentication flow and you'll see all Zendesk tools available.

## Connecting a Claude Client

There are two routes in, and they behave differently enough that the choice matters. Prefer the connector unless something rules it out.

### As a custom connector

Claude holds remote MCP servers on your account rather than in a file on disk, so there is nothing to install and no Node runtime on the machine. On Pro or Max each person adds it once themselves, from **Settings → Connectors → Add custom connector** — reachable inside Claude Desktop with `Cmd+,`, or at claude.ai. It asks for a display name as well as the URL:

```
Name   Momentum Zendesk
URL    https://zendesk-mcp.<your-subdomain>.workers.dev/mcp
```

On Team or Enterprise an Owner adds it once under **Organization settings → Connectors** and everyone inherits it. Either way the connector follows the account rather than the machine, so it appears in Claude Desktop and at claude.ai both, and `claude_desktop_config.json` is not involved at all.

Use `/mcp` rather than `/sse`. `src/index.ts` mounts both, and `/sse` is the superseded transport kept for older clients — hand a current client `/sse` and it will POST there, take a 404, and fall back.

Anthropic's infrastructure makes this connection rather than the user's machine, so the worker has to be reachable over the public internet, which a deployed worker already is. That is also the property that makes this route viable for people who will never open a terminal: nothing runs locally, so there is nothing local to go wrong. `HOSTED_DOMAIN` still governs who may sign in, so a connector does not widen access.

### Through the `mcp-remote` proxy

Servers listed in `claude_desktop_config.json` are started as local programs and spoken to over stdin and stdout, so reaching an HTTP server needs a local adapter in between. Use this only for clients that cannot take a connector.

Open the file with **Settings → Developer → Edit Config**, or edit it directly:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`, which expands to `C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json`

The file usually already holds your app preferences, so add `mcpServers` alongside the keys that are there rather than replacing the whole thing. Leave the command as `npx` and not `pnpm dlx`: it runs on the user's own machine, where Node ships `npx` but pnpm may not be installed at all.

```json
{
	"mcpServers": {
		"zendesk": {
			"command": "npx",
			"args": ["mcp-remote", "https://zendesk-mcp.<your-subdomain>.workers.dev/mcp"]
		}
	}
}
```

Claude Desktop reads this file only at launch, so quit it fully and start it again — closing the window leaves it running in the background and changes nothing. On macOS press Cmd+Q, and on Windows right-click the tray icon and choose Quit. To point at a local server instead, run `pnpm run dev` and use `http://localhost:8788/mcp`.

This route asks a lot more of the machine, and the failures are worth knowing before handing it to anyone:

- **Node has to be installed.** `npx` is not present on a machine without Node, which rules this out for most non-technical users on its own.
- **Startup runs against a timer.** Claude Desktop cancels a server that has not finished initializing within 60 seconds, and first-time OAuth can exceed that while someone picks a Google account. The symptom is a browser landing on `localhost:<port>` with nothing listening, because the proxy was killed while the browser was still away. Retrying usually works, since the second attempt reuses the approval cookie and the Google session.
- **An idle stream gets dropped.** Node's fetch abandons a response body after 300 seconds of silence, so a quiet SSE connection dies with `Body Timeout Error` and the proxy reconnects underneath you. Reconnecting can re-enter the auth path and open a browser window unprompted.
- **Windows cannot find `npx`.** Claude Desktop spawns the command without a shell, so the `.cmd` shim never resolves. Use `"command": "cmd"` with `"args": ["/c", "npx", "mcp-remote", "<your-url>"]`.
- **Tokens are cached on disk.** They live in `~/.mcp-auth` on macOS and `%USERPROFILE%\.mcp-auth` on Windows. Delete that folder if authentication gets stuck after a URL change. A stale lockfile there needs no attention, since the proxy detects and clears it.

### Either way

Authenticate through the browser flow when prompted, then ask Claude to:

- "Show me the latest support tickets"
- "Create a new ticket for a customer issue"
- "Search for tickets about billing problems"
- "List all users in the Sales organization"

## Available Tools

### Ticket Management

- `list_tickets` - List tickets with filtering and pagination
- `get_ticket` - Get specific ticket details
- `create_ticket` - Create new support tickets
- `update_ticket` - Update existing tickets
- `delete_ticket` - Delete tickets

### User Management

- `list_users` - List users with role filtering
- `get_user` - Get user details
- `create_user` - Create new users

### Organization Management

- `list_organizations` - List organizations
- `get_organization` - Get organization details
- `create_organization` - Create organizations

### Search & Discovery

- `search` - Search across all Zendesk data

[See CLAUDE.md for complete tool documentation]

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
