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
pnpm run validate        # type-check, lint, format:check, test and build together
```

`no-explicit-any` is set to warn rather than error, so `pnpm run lint` currently reports 37 warnings and still exits clean.

The Zendesk client no longer contributes to that count on the read side. `request` and `requestWithRetry` return `Promise<unknown>`, and every list method takes `Record<string, unknown>` for its query parameters, so a caller that wants to reach into a response body has to narrow it first. Two places do: `src/tools/help-center.ts`, which walks the category and section hierarchy, and `src/utils/search-response.ts`, which reshapes search bodies. Both start from `isRecord` in `src/utils/narrow.ts`, which proves a value is a non-null object and nothing more, leaving every property still `unknown` and still to be checked. Everything else hands the response straight to `JSON.stringify`.

What is left is deliberate rather than overlooked. Twenty of the warnings are the `data` argument on the client's create and update methods, which stays `any` until somebody decides whether hand-maintained Zendesk request payloads are worth the drift (see #8). Five more are in `src/workers-oauth-utils.ts`, which is vendored and is being reworked in #3 and #4.

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

### Unit Tests

Vitest, with no runtime of its own. Everything under test is either pure or reachable through a stubbed `fetch`, so nothing here needs `workerd` or the network. If something eventually does, `@cloudflare/vitest-pool-workers` runs the same suite inside the real runtime — but reach for it when a test actually requires it, not before.

```bash
pnpm run test            # Run the suite once (what validate uses)
pnpm run test:watch      # Re-run on change while working
pnpm run test:coverage   # Run once and report coverage (text plus coverage/index.html)
```

Coverage measures all of `src/`, not only the files a test imported, so a module nobody covers sits in the table at 0% instead of being absent from it. The report is there to show where the holes are, which means the untested tools and the vendored OAuth code belong in the denominator.

Read `coverage/index.html` rather than the terminal table when you want the full picture. The text reporter omits files that are at 100% on all four metrics, and `coverage.skipFull` does not change that, so a directory can print a middling percentage with its finished files nowhere in sight.

CI runs `test:coverage` and posts the result as a comment on the pull request, so the report is something a reviewer reads rather than something someone has to go and generate. `validate` stays on the bare `test`, which keeps the local loop to the question you usually have — did anything break.

That comment is a map of what is untested, and nothing gates on the overall number. A single figure over all of `src/` is diluted by design here, since the untested tools and the vendored OAuth code are deliberately in the denominator, so a floor under it would mostly reward covering passthrough code. Per-file thresholds on the modules that branch are the useful form of that idea, and are being worked out in #26.

The `json-summary` and `json` reporters exist for that comment rather than for people; `text` and `html` are the ones to read locally. `reportOnFailure` is on so a failing run still explains itself.

Tests sit next to the code they cover as `*.test.ts`, which is why `pnpm run lint` and `tsc --noEmit` already reach them without a second path to configure. `wrangler deploy --dry-run` bundles from `src/index.ts` and follows imports, so nothing imports a test file and none of this ships.

Test what branches. Most tools hand a response straight to `JSON.stringify` and have nothing to get wrong; the sanitizers, the retry policy, the response reshaping and the hierarchy walk all make decisions, and those are what earn a test.

Cover a private method through the public one that calls it, rather than casting past `private`. The sanitizers are the reason: asserting on the URL that actually goes out survives a refactor of how the sanitizing is arranged, and asserting on `sanitizeSubdomain` directly does not.

Teardown of spies and stubbed globals belongs in `vitest.config.ts` (`restoreMocks`, `unstubGlobals`), not in a per-file `afterEach`. Both run _before_ each test, so a mock created at module scope would be torn down before the first test ran — create them inside a test or a `beforeEach`. Fake timers have no equivalent switch and still need `vi.useRealTimers()` in an `afterEach`.

Some tests deliberately pin behaviour that looks unintended, so that changing it has to be a decision rather than an accident. Each says so in a comment and names the issue holding the argument. If you fix one of those behaviours, expect to invert its test — that is the pin doing its job, not a regression.

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
