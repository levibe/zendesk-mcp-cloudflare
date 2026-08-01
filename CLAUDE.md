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

`no-explicit-any` warns rather than errors, so `pnpm run lint` exits clean with warnings outstanding. Every remaining `any` is deliberate — run `lint` for the current set. A new one needs a stated reason, in the commit or an issue, so that an `any` nobody has examined stands out from the ones that were argued for.

The client's read path is fully narrowed and should stay that way. `request` and `requestWithRetry` return `Promise<unknown>`, and every list method takes `Record<string, unknown>` for its query parameters, so reaching into a response body means narrowing it first. Two places do: `src/tools/help-center.ts`, which walks the category and section hierarchy, and `src/utils/search-response.ts`, which reshapes search bodies. Both start from `isRecord` in `src/utils/narrow.ts`, which proves a value is a non-null object and nothing more, leaving every property still `unknown` and still to be checked. Everything else hands the response straight to `JSON.stringify`.

What remains is the `data` argument on the client's create and update methods, plus the vendored `src/workers-oauth-utils.ts`. The payloads are an open decision rather than an oversight, and #12 carries the argument.

The reason they were not simply swapped to `unknown` generalises, so it is worth knowing. `unknown` works for a value the code only passes along — a query parameter that gets stringified, a request body handed to `JSON.stringify` — because the constraint lands on the function body. It buys nothing in a **parameter** position where the body just forwards the value, since `unknown` accepts from a caller exactly what `any` accepts. Swapping those would silence the warning and constrain nobody.

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

## Which tools a client can actually use

Tools live in `src/tools/`, one file per Zendesk resource, gathered into `toolCategories` in `src/tools/index.ts`. Defining one there does not publish it, so the list a client sees is shorter than the list in the tree. There is no inventory of either here: read the definitions, or start the server and read the line it logs naming everything it withheld.

Two allowlists in `src/utils/tool-registry.ts` decide, and a tool has to satisfy one of them:

- `isReadOnlyTool` covers the query verbs — the `list_`, `get_` and `search_` prefixes, plus `search` and `support_info` by name.
- `WRITE_TOOLS_ENABLED` names the individual writes permitted anyway. That set is the authority on which ones; today it holds the two macro writes.

Anything satisfying neither is withheld at registration and cannot be reached by any client. `create_ticket` and `delete_ticket` are defined, compiled and covered by the type checker, and no client is ever offered them.

Both rules are allowlists rather than denylists on purpose, so a newly added tool stays unexposed until somebody classifies it deliberately. That is why permitting a write means adding its name to the set, and why adding `create_` to the prefixes above would be the wrong shortcut — a prefix publishes every future create tool on the day it is written, which inverts the property the rule exists to hold.

Macro writes are permitted because of what a macro is: it changes nothing when it is created and sits in a menu until an agent applies it to a ticket by hand. A trigger fires on every matching ticket create or update, and an automation runs against every matching ticket on a schedule, so a malformed one reaches customers before anyone reviews it. #20 is where that judgement gets generalised into a permission model, once #22 and #23 have said what the general case needs.

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

That comment is a map of what is untested, and nothing gates on the overall number. A single figure over all of `src/` is diluted by the denominator described above, so a floor under it would mostly reward covering passthrough code. Per-file thresholds on the modules that branch are the useful form of that idea, and are being worked out in #26.

Posting that comment needs a token that can write to pull requests, so it happens in a second CI job that only checks out and reads the coverage json. Keep it that way. The job running `pnpm install` executes the dependency build scripts `pnpm-workspace.yaml` allows, and a writable token has no business sitting on the same runner while that happens.

The `json-summary` and `json` reporters exist for that comment rather than for people; `text` and `html` are the ones to read locally. `reportOnFailure` is on so a failing run still explains itself.

Tests sit next to the code they cover as `*.test.ts`, which is why `pnpm run lint` and `tsc --noEmit` already reach them without a second path to configure. `wrangler deploy --dry-run` bundles from `src/index.ts` and follows imports, so nothing imports a test file and none of this ships.

Test what branches. Most tools hand a response straight to `JSON.stringify` and have nothing to get wrong; the sanitizers, the retry policy, the response reshaping and the hierarchy walk all make decisions, and those are what earn a test.

Cover a private method through the public one that calls it, rather than casting past `private`. The sanitizers are the reason: asserting on the URL that actually goes out survives a refactor of how the sanitizing is arranged, and asserting on `sanitizeSubdomain` directly does not.

Teardown of spies and stubbed globals belongs in `vitest.config.ts` (`restoreMocks`, `unstubGlobals`), not in a per-file `afterEach`. Both run _before_ each test, so a mock created at module scope would be torn down before the first test ran — create them inside a test or a `beforeEach`. Fake timers have no equivalent switch and still need `vi.useRealTimers()` in an `afterEach`.

Some tests deliberately pin behaviour that looks unintended, so that changing it has to be a decision rather than an accident. Each says so in a comment, and names the issue holding the argument where one has been filed. If you fix one of those behaviours, expect to invert its test — that is the pin doing its job, not a regression.

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

**Registration is where the publication policy is enforced.** `registerTools` withholds anything that is neither a read nor a named write, as described above. A tool registered directly against the server would skip that check and reach clients whatever it does.

A write tool also has to keep its hands off the response. Handlers return the client's result and let the single `withErrorHandling` in `registerTools` shape it, the way every read tool does. Calling `withCreateHandling` or its siblings inside a handler builds a second, finished response that the outer wrapper then JSON-encodes — burying `isError` where no client can see it, so a rejected write reads as a successful call. Several withheld write tools still do this, which is #28.

## Development Notes

- `request` throws `ZendeskRequestError`, carrying the HTTP status when the server answered and leaving it undefined when the request never completed. Classify a failure on that status, or on an error's `name` or `code` down the `cause` chain — never by matching the message, which is built out of the Zendesk response body and so cannot tell a status from the same digits quoted inside a body
- Uses `fetch` API instead of `axios` for Cloudflare Workers compatibility
- All environment variables are accessed via `this.env` in the Workers context
- Error handling returns `isError: true` for failed operations
- TypeScript is used throughout for type safety
- Authentication is handled at the OAuth level, not per-API-call level

## Deployment Endpoints

- **SSE Endpoint**: `https://your-worker.workers.dev/sse` (for MCP clients)
- **OAuth Authorization**: `https://your-worker.workers.dev/authorize`
- **Token Endpoint**: `https://your-worker.workers.dev/token`
