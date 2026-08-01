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

This project uses pnpm, pinned via the `packageManager` field in `package.json`. Run scripts with `pnpm run <script>` and dependency binaries with `pnpm exec <binary>`. Avoid the bare `pnpm <name>` shorthand: `deploy` is also a built-in pnpm command, and the built-in wins, so `pnpm deploy` would not run the script at all.

`.nvmrc` deliberately names the major (`22`) rather than a full version, because both `nvm use` and `actions/setup-node` read a partial version as a range and would pin the old `22.13.x` line. The `>=22.13` floor in `engines` matches pnpm's own requirement and is advisory, since `engine-strict` is off by default. It rarely needs enforcing: pnpm 11 exits outright below Node 22.13, with Node 20 the one exception, where it warns and carries on.

### Local Development

```bash
pnpm install             # Install dependencies
pnpm run dev             # Start local development server (localhost:8788)
pnpm run type-check      # Run TypeScript type checking
```

### Code Quality

Prettier owns formatting and ESLint owns everything else. ESLint's formatting rules are switched off through `eslint-config-prettier`, so the two never disagree — don't add stylistic rules back to `eslint.config.mjs`.

```bash
pnpm run format          # Format the repository with Prettier
pnpm run format:check    # Check formatting without writing (used by validate)
pnpm run lint            # Lint src/ with ESLint
pnpm run lint:fix        # Lint and auto-fix
pnpm run validate        # type-check, lint, format:check and build together
```

`no-explicit-any` is set to warn rather than error, so `pnpm run lint` currently reports 23 warnings and still exits clean.

The Zendesk client no longer contributes to that count on the read side. `request` and `requestWithRetry` return `Promise<unknown>`, and every list method takes `Record<string, unknown>` for its query parameters, so a caller that wants to reach into a response body has to narrow it first. Two places do: `src/tools/help-center.ts`, which walks the category and section hierarchy, and `src/utils/search-response.ts`, which reshapes search bodies. Both start from `isRecord` in `src/utils/narrow.ts`, which proves a value is a non-null object and nothing more, leaving every property still `unknown` and still to be checked. Everything else hands the response straight to `JSON.stringify`.

What is left is deliberate rather than overlooked, and each group has an issue behind it. Eighteen of the warnings are the `data` argument on the client's create and update methods, which stays `any` until somebody decides whether hand-maintained Zendesk request payloads are worth the drift (see #12). The other five are in `src/workers-oauth-utils.ts`, which is vendored and is being reworked in #3 and #4.

Note that `unknown` is not a free substitute in every position. It works for a value the code only passes along — a query parameter that gets stringified, a request body handed to `JSON.stringify` — because the constraint lands on the function body. It buys nothing in a **parameter** position where the body just forwards the value, since `unknown` accepts exactly what `any` accepts from a caller. That is why the create and update payloads above are still open rather than quietly swapped.

### Deployment

```bash
pnpm run deploy      # Deploy to Cloudflare Workers
```

### Environment Setup

#### Required Secrets (for production)

Set these via `pnpm exec wrangler secret put <SECRET_NAME>`:

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
pnpm exec wrangler kv namespace create "OAUTH_KV"
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
pnpm dlx @modelcontextprotocol/inspector
# Connect to: http://localhost:8788/sse
```

The `minimumReleaseAge` cooldown applies to `pnpm dlx` as well, so this resolves to the newest inspector published more than a week ago. Pinning `@latest` would not change that, only make it misleading.

### Claude Desktop Integration

Add to Claude Desktop config. Leave the command below as `npx`, not `pnpm dlx`: it runs on the end user's machine, where Node is a safe assumption but pnpm is not. The pnpm commands elsewhere in this file are for working on the server itself.

```json
{
	"mcpServers": {
		"zendesk": {
			"command": "npx",
			"args": ["mcp-remote", "https://zendesk-mcp-server.<your-subdomain>.workers.dev/sse"]
		}
	}
}
```

## Adding New Tools

To add new Zendesk tools:

1. Add the API method to the `ZendeskClient` class in `src/zendesk-client.ts`
2. Add a `createTool(...)` entry to the relevant `ToolDefinition[]` in `src/tools/`. A brand new file also has to be added to `toolCategories` in `src/tools/index.ts` — exporting it alone does not register it.
   ```typescript
   createTool(
   	'list_widgets',
   	'List widgets in Zendesk',
   	{ ...paginationSchema },
   	async (client, params) => {
   		return client.listWidgets(params)
   	}
   )
   ```

Do not call `server.tool` directly. Everything goes through `createTool` and `registerAllTools`, for two reasons:

**The handler's parameters are inferred from the schema, so never annotate them.** `createTool` derives the `params` type from the object literal you pass as the third argument, using the same helper the MCP SDK applies to that schema. Writing the type out by hand creates a second source of truth that nothing reconciles — which is how `create_macro` came to declare a required `value` on an action the schema had always made optional. Spread a shared schema like `paginationSchema` and the handler sees its fields immediately; name a field the schema does not declare and it is a compile error rather than a parameter the server will never populate.

**Registration is where the read-only policy is enforced.** `registerTools` withholds anything that is not a read, via an allowlist of query verbs in `src/utils/tool-registry.ts`. A tool registered directly against the server would skip that check and be exposed to clients.

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
