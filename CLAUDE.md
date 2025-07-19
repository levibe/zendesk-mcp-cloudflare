# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a remote Model Context Protocol (MCP) server that integrates Zendesk API functionality with Google OAuth authentication, deployed on Cloudflare Workers. It allows MCP clients (like Claude Desktop) to securely interact with Zendesk APIs through an authenticated remote connection.

## Architecture

### Core Components

- **OAuth Authentication**: Uses Google OAuth for MCP client authentication via `@cloudflare/workers-oauth-provider`
- **Zendesk API Integration**: Comprehensive Zendesk API client with full CRUD operations for tickets, users, organizations, etc.
- **Cloudflare Workers Deployment**: Serverless deployment with Durable Objects for state management
- **MCP Protocol**: Implements the Model Context Protocol for tool exposure to AI clients

### Key Files

- `src/index.ts` - Main entry point integrating OAuth and Zendesk functionality
- `src/zendesk-client.ts` - Cloudflare Workers-compatible Zendesk API client (uses fetch instead of axios)
- `src/google-handler.ts` - Google OAuth handler configuration
- `wrangler.jsonc` - Cloudflare Workers deployment configuration

## Development Commands

### Local Development
```bash
npm run dev          # Start local development server (localhost:8788)
npm run type-check   # Run TypeScript type checking
```

### Deployment
```bash
npm run deploy       # Deploy to Cloudflare Workers
```

### Environment Setup

#### Required Secrets (for production)
Set these via `wrangler secret put <SECRET_NAME>`:
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `COOKIE_ENCRYPTION_KEY` - Random string for cookie encryption
- `ZENDESK_SUBDOMAIN` - Your Zendesk subdomain
- `ZENDESK_EMAIL` - Zendesk API user email
- `ZENDESK_API_TOKEN` - Zendesk API token
- `HOSTED_DOMAIN` - (Optional) Restrict to specific Google domain

#### Local Development Setup
Create `.dev.vars` file:
```
GOOGLE_CLIENT_ID=your_dev_client_id
GOOGLE_CLIENT_SECRET=your_dev_client_secret
ZENDESK_SUBDOMAIN=your_subdomain
ZENDESK_EMAIL=your_email
ZENDESK_API_TOKEN=your_token
```

#### KV Namespace Setup
```bash
wrangler kv:namespace create "OAUTH_KV"
# Update wrangler.jsonc with the returned KV ID
```

## Available Tools

The MCP server currently provides these Zendesk tools:

### Ticket Management
- `list_tickets` - List tickets with pagination and filtering
- `get_ticket` - Get specific ticket by ID
- `create_ticket` - Create new support tickets
- `update_ticket` - Update existing tickets
- `delete_ticket` - Delete tickets

### User Management
- `list_users` - List users with pagination and role filtering
- `get_user` - Get specific user by ID
- `create_user` - Create new users

### Search
- `search` - Search across all Zendesk data

## Testing

### Local Testing with MCP Inspector
```bash
npx @modelcontextprotocol/inspector@latest
# Connect to: http://localhost:8788/sse
```

### Claude Desktop Integration
Add to Claude Desktop config:
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

## Adding New Tools

To add new Zendesk tools:

1. Add the API method to `ZendeskClient` class in `src/zendesk-client.ts`
2. Create a new registration method in `src/index.ts` following the pattern:
   ```typescript
   private async registerNewTools() {
     this.server.tool("tool_name", {
       // Zod schema for parameters
     }, async ({ param1, param2 }) => {
       // Implementation using this.zendeskClient
     });
   }
   ```
3. Call the registration method in the `init()` method

## Development Notes

- Uses `fetch` API instead of `axios` for Cloudflare Workers compatibility
- All environment variables are accessed via `this.env` in the Workers context
- Error handling returns `isError: true` for failed operations
- TypeScript is used throughout for type safety
- Authentication is handled at the OAuth level, not per-API-call level

## Deployment Endpoints

- **SSE Endpoint**: `https://your-worker.workers.dev/sse` (for MCP clients)
- **OAuth Authorization**: `https://your-worker.workers.dev/authorize`
- **Token Endpoint**: `https://your-worker.workers.dev/token`