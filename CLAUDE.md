# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a remote Model Context Protocol (MCP) server that integrates Zendesk API functionality with Google OAuth authentication, deployed on Cloudflare Workers. It allows MCP clients (like Claude Desktop) to securely interact with Zendesk APIs through an authenticated remote connection.

## Architecture

### Core Components

- **OAuth Authentication**: Uses Google OAuth for MCP client authentication via `@cloudflare/workers-oauth-provider`
- **Zendesk API Integration**: Comprehensive Zendesk API client with full CRUD operations for tickets, users, organizations, etc.
- **Cloudflare Workers Deployment**: Serverless, and stateless — no Durable Object, no storage of its own
- **MCP Protocol**: Implements the Model Context Protocol for tool exposure to AI clients

### The server holds nothing between requests

MCP revision 2026-07-28 removed protocol-level sessions, and this server is built the way that implies. `src/index.ts` hands `createMcpHandler` a factory, and the factory builds a fresh `McpServer` and a fresh `ZendeskClient` for every request. Nothing is cached across calls and nothing needs to be: the client holds configuration read from `env` and opens no connection, and every tool is one request to Zendesk whose result goes straight back.

This is not a style preference, and hoisting the server to module scope to save rebuilding the tools is the mistake to know about. Nothing stops you. `Server.connect` reassigns its transport without complaint, and the SDK's single-use check sits on the transport rather than the server, so it never fires. A shared instance answers sequential requests correctly, which is exactly what local testing produces.

It comes apart under concurrency, and through teardown rather than dispatch: finishing one exchange closes the server, and closing aborts every request handler still in flight on that instance, so the requests waiting on them never settle. The endpoint carries on answering while a fraction of traffic silently never returns. Which particular request survives depends on completion order and is not worth reasoning about — the point is that the failure is invisible until it is load-dependent and hard to attribute.

Anything genuinely needing to survive across calls has to become an explicit handle: the server mints it, returns it, and the model passes it back as an ordinary tool argument. There is nowhere else to put it.

Two things follow that are easy to get wrong. Work that should happen once per isolate must not sit inside the factory, or it repeats on every tool call — `announceWithheldTools` is separate from `registerAllTools` for exactly this reason, and the comment on it explains the split. And `this.env` is gone along with the class, so `env` arrives as a `fetch` argument and is threaded to whatever needs it.

`/sse` no longer exists. It served the HTTP+SSE transport, which this revision reclassifies as formally deprecated, and it was the last thing requiring the Durable Object. Older clients are not stranded by that, since `createMcpHandler` defaults to `legacy: 'stateless'` and still answers requests that arrive without the 2026-07-28 envelope; what stopped working is a client that can speak nothing but HTTP+SSE.

Origin checking arrived with the same handler and is worth knowing about separately, because it fails in a way that looks unrelated. A request with no `Origin` header always passes, which covers everything reaching this server now — the connector fetches server-side, and `mcp-remote` and the Inspector proxy are Node.

What the default permits a browser depends on the deployment, which is the part that catches people out. It accepts localhost, and additionally the endpoint's own hostname when that is a `workers.dev` address; a custom domain therefore allows localhost and nothing else. Any other origin gets a 403 naming the origin and saying nothing about transports. `allowedOriginHostnames` is where to widen it, one hostname at a time rather than `'*'`.

### Key Files

- `src/index.ts` - Main entry point integrating OAuth and Zendesk functionality
- `src/zendesk-client.ts` - Cloudflare Workers-compatible Zendesk API client (uses fetch instead of axios)
- `src/google-handler.ts` - Google OAuth handler configuration
- `wrangler.jsonc` - Cloudflare Workers deployment configuration

## Development Commands

This project uses pnpm, pinned via the `packageManager` field in `package.json`. Run scripts with `pnpm run <script>` and dependency binaries with `pnpm exec <binary>`. Avoid the bare `pnpm <name>` shorthand: `deploy` is also a built-in pnpm command, and the built-in wins, so `pnpm deploy` would not run the script at all.

`.nvmrc` deliberately names the major (`24`) rather than a full version, because both `nvm use` and `actions/setup-node` read a partial version as a range and would pin the oldest release in that line. Track the active LTS here — nothing in the Worker runs on Node, so this only decides what the local tooling and CI build on.

The `>=22.13` floor in `engines` is a different question and deliberately sits below `.nvmrc`. It mirrors pnpm's own requirement rather than what this repo develops against, so it moves when pnpm's floor moves and not when `.nvmrc` does. It is advisory in any case, since `engine-strict` is off by default, and it rarely needs enforcing: pnpm 11 exits outright below Node 22.13, with Node 20 the one exception, where it warns and carries on.

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

Everything above is a secret, including `ZENDESK_SUBDOMAIN` and `ZENDESK_EMAIL`, which are not sensitive. Set new deployment config the same way rather than as a dashboard var, because a var does not survive: Workers Builds deploys the production branch with `wrangler deploy`, which honours `keep_vars`, but builds every other branch with `wrangler versions upload`, which takes no equivalent and clears plain vars while leaving encrypted ones alone. So a var lasts until the next pull request, and then fails as missing credentials at request time, pointing nowhere near the deploy that removed it.

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

Read `coverage/index.html` rather than the terminal table when you want the full picture. Running through a coding agent, Vitest turns `skipFull` on for the text reporter, so files at 100% on all four metrics drop out of it and a directory can print a middling percentage with its finished files nowhere in sight. Setting `coverage.skipFull` back to false does not undo it — the override goes onto the reporter's own options, which win. From a plain terminal, and on CI, every file is listed. The html report always has all of them.

CI runs `test:coverage` and posts the result as a comment on the pull request, so the report is something a reviewer reads rather than something someone has to go and generate. `validate` stays on the bare `test`, which keeps the local loop to the question you usually have — did anything break.

That comment is a map of what is untested, and nothing gates on the overall number. A single figure over all of `src/` is diluted by the denominator described above, so a floor under it would mostly reward covering passthrough code, and would let a real test be deleted from the client as long as one more thin module got covered.

What does gate is a per-file threshold on each module that decides something. The numbers live in `vitest.thresholds.ts`, together with the reasoning for which metrics each one pins, and they need to stay in a file of their own. The coverage-reporting action on CI does not parse the config — it runs a regex per metric over the raw text of `vitest.config.ts` and treats the first number it finds as a target for the whole project, which is wrong here, because nothing gates on the overall figure. They are a ratchet against erosion rather than a target to climb, so set them from the measured value rounded down, with enough slack that unrelated work does not trip them. Raise one when real coverage lands, and say so in the commit when you lower one, because that is coverage being given up.

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
# Connect to: http://localhost:8788/mcp
```

The `minimumReleaseAge` cooldown applies to `pnpm dlx` as well, so this resolves to the newest inspector published more than a week ago. Pinning `@latest` would not change that, only make it misleading.

### Claude Desktop Integration

Add to Claude Desktop config. Leave the command below as `npx`, not `pnpm dlx`: it runs on the end user's machine, where Node is a safe assumption but pnpm is not. The pnpm commands elsewhere in this file are for working on the server itself.

```json
{
	"mcpServers": {
		"zendesk": {
			"command": "npx",
			"args": ["mcp-remote", "https://zendesk-mcp-server.<your-subdomain>.workers.dev/mcp"]
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

Do not call `server.registerTool` directly. Everything goes through `createTool` and `registerAllTools`, for two reasons:

**The handler's parameters are inferred from the schema, so never annotate them.** `createTool` derives the `params` type from the object literal you pass as the third argument, mirroring the helper the MCP SDK applies to that schema. Writing the type out by hand creates a second source of truth that nothing reconciles — which is how `create_macro` came to declare a required `value` on an action the schema had always made optional. Spread a shared schema like `paginationSchema` and the handler sees its fields immediately; name a field the schema does not declare and it is a compile error rather than a parameter the server will never populate.

Keep passing `createTool` a bare shape. The registry wraps it in `z.object` before handing it on, because SDK v2 deprecates the overload taking a raw `{ field: z.string() }` record even though it still accepts one. Wrapping in one place is what lets every tool definition go on spreading shared shapes.

**Registration is where the publication policy is enforced.** `registerTools` withholds anything that is neither a read nor a named write, as described above. A tool registered directly against the server would skip that check and reach clients whatever it does.

A write tool also has to keep its hands off the response. Handlers return the client's result and let the single `withErrorHandling` in `registerTools` shape it, the way every read tool does. Calling `withCreateHandling` or its siblings inside a handler builds a second, finished response that the outer wrapper then JSON-encodes — burying `isError` where no client can see it, so a rejected write reads as a successful call. Several withheld write tools still do this, which is #28.

## Development Notes

- `request` throws `ZendeskRequestError`, carrying the HTTP status when the server answered and leaving it undefined when the request never completed. Classify a failure on that status, or on an error's `name` or `code` down the `cause` chain — never by matching the message, which is built out of the Zendesk response body and so cannot tell a status from the same digits quoted inside a body
- Uses `fetch` API instead of `axios` for Cloudflare Workers compatibility
- Redirects are not followed. `request` sets `redirect: 'manual'` and turns a 3xx into a failure that names where it pointed, because the platform strips `Authorization` on a hop to another host and the follow-up request comes back 401 reading exactly like a revoked token. Do not set this back to `follow`. Do not re-attach the credential and follow the redirect by hand either — doing so decides the new host is trustworthy, which is precisely the judgement the platform default exists to stop `fetch` making unprompted
- Environment variables arrive as the `env` argument to `fetch` and are threaded from there. There is no `this.env`, because there is no longer a class to hang it on
- Error handling returns `isError: true` for failed operations
- TypeScript is used throughout for type safety
- Authentication is handled at the OAuth level, not per-API-call level

## Deployment Endpoints

- **MCP Endpoint**: `https://your-worker.workers.dev/mcp` (Streamable HTTP, for MCP clients)
- **OAuth Authorization**: `https://your-worker.workers.dev/authorize`
- **Token Endpoint**: `https://your-worker.workers.dev/token`
