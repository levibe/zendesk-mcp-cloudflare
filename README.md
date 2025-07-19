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

### 1. Zendesk Setup
1. In your Zendesk Admin Center, go to Apps and integrations > APIs > Zendesk API
2. Enable token access and generate an API token
3. Note your Zendesk subdomain (e.g., `company` from `company.zendesk.com`)

### 2. Google OAuth Setup

#### For Production
Create a [Google Cloud OAuth App](https://cloud.google.com/iam/docs/workforce-manage-oauth-app):
- Homepage URL: `https://zendesk-mcp-server.<your-subdomain>.workers.dev`
- Authorization callback URL: `https://zendesk-mcp-server.<your-subdomain>.workers.dev/callback`
- Note your Client ID and generate a Client secret

#### For Local Development  
Create a separate OAuth App for development:
- Homepage URL: `http://localhost:8788`
- Authorization callback URL: `http://localhost:8788/callback`

### 3. Environment Setup

Set production secrets via Wrangler:
```bash
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put COOKIE_ENCRYPTION_KEY # Random string, e.g. openssl rand -hex 32
wrangler secret put ZENDESK_SUBDOMAIN
wrangler secret put ZENDESK_EMAIL
wrangler secret put ZENDESK_API_TOKEN
wrangler secret put HOSTED_DOMAIN # Optional: restrict to specific Google domain
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
wrangler kv:namespace create "OAUTH_KV"
# Update wrangler.jsonc with the returned KV ID
```

### 5. Deploy & Test

#### Deploy to Production
```bash
npm install
wrangler deploy
```

#### Local Development
```bash
npm install
npm run dev
```

#### Test with MCP Inspector
```bash
npx @modelcontextprotocol/inspector@latest
```
- For production: Enter `https://zendesk-mcp-server.<your-subdomain>.workers.dev/sse`
- For local: Enter `http://localhost:8788/sse`

Complete the authentication flow and you'll see all Zendesk tools available.

## Claude Desktop Integration

Add to your Claude Desktop configuration file:

```json
{
  "mcpServers": {
    "zendesk": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://zendesk-mcp-server.<your-subdomain>.workers.dev/sse"
      ]
    }
  }
}
```

After restarting Claude Desktop, authenticate via the browser flow. You can then ask Claude to:
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
  )
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