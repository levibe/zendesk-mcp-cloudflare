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

### The tool list's TTL is the only staleness bound

`tools/list` is cached, through `cacheHints` on the `McpServer` constructor in `src/index.ts`, where the TTL and the reasoning for it sit together. Revision 2026-07-28 requires `ttlMs` and `cacheScope` on every cacheable result, and the SDK fills them with `ttlMs: 0` when nobody says otherwise — the fields present and the feature off, which is the right default for a server it knows nothing about. This list earns better, because it does not vary: `toolCategories` is a fixed literal, both allowlists are compile-time constants, and registration never consults the authenticated user, so two clients signed in as different people get identical bytes. Deterministic ordering, which the revision asks for in the same breath, falls out of registration walking the categories in declaration order — worth knowing before someone adds a sort to "fix" it.

The number is the part to be careful with, because a TTL here is not a hint that a client may re-check sooner. It is the only bound on staleness there is, since this server cannot tell a client the list changed. `tools/list_changed` reaches a client over `subscriptions/listen`, which needs a long-lived handler holding an event bus, and the handler is built inside `fetch`, so every request gets a fresh bus with no subscribers. Hoisting it would not fix that either: the bus is in-memory and per-isolate, so it would reach only the clients that happened to land on the isolate where something changed. Notification across a Workers deployment is a harder problem than it looks, and not one worth solving for a list that changes a few times a year. So read the TTL as an answer to "how long may a client go on offering a tool we have removed", and raise it only with that question in view.

Only clients on 2026-07-28 are affected either way. The fields are filled at the modern codec's encode seam, so a request arriving without the envelope — the ones `legacy: 'stateless'` still answers — carries no cache fields at all and re-lists every time. Nothing to fix there; it is just not the whole of the traffic that the TTL governs.

A stale list is a staleness problem rather than a security one, which is the reassuring half. Registration re-runs per request, so a tool dropped from `WRITE_TOOLS_ENABLED` stops existing the moment the new code is live. A client holding the old list can still see it, and gets `Tool not found` when it calls, because the publication policy is enforced at call time and not by what the list happens to say.

`cacheScope` is `private` deliberately. The body is identical for every caller, which is the test `public` actually applies, but `public` would add only sharing through an intermediary and there is none here — the connector fetches server-side and `mcp-remote` runs per user. Per-deployment configuration would keep that true, since a deployment is one URL with one list; a per-user permission model would not, which is the thing to re-check if #20 lands.

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

Builds for non-production branches are switched off in the Workers Builds settings, which stops that at the source. That decision lives in a dashboard rather than in this repo, so it is recorded here — otherwise the only trace of it is an absence, and turning it back on looks free. Keep the secrets rule above whether or not those builds are on: it is what makes re-enabling them safe, and it is the half of this that a pull request can actually protect.

They were worth switching off for a second reason too. Every branch push uploaded a version newer than the deployed one, and `wrangler secret put` refuses to run in that state — editing a secret derives a new version from the latest, so applying one would have deployed an unreviewed branch as a side effect of changing a credential. Cloudflare is right to refuse, but it means an unmerged pull request could block a production credential change until `main` was deployed again.

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
- `WRITE_TOOLS_ENABLED` names the individual writes permitted anyway, and is the authority on which ones. The comment on that set carries the test a write has to pass to get in, and is the place to argue about adding one.

Anything satisfying neither is withheld at registration and cannot be reached by any client. `create_ticket` and `delete_ticket` are defined, compiled and covered by the type checker, and no client is ever offered them.

Both rules are allowlists rather than denylists on purpose, so a newly added tool stays unexposed until somebody classifies it deliberately. That is why permitting a write means adding its name to the set, and why adding `create_` to the prefixes above would be the wrong shortcut — a prefix publishes every future create tool on the day it is written, which inverts the property the rule exists to hold.

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

A write tool also has to keep its hands off the response. Handlers return the client's result and let the single `withErrorHandling` in `registerTools` shape it, the way every read tool does. A handler that builds a finished response of its own gets wrapped a second time, so the inner response is JSON-encoded as the text of the outer one — which buries `isError` where no client can see it, and a write Zendesk rejected reads back as a successful call. That is why `registerTools` is the only place that calls `withErrorHandling`, and why a `no-restricted-imports` rule in `eslint.config.mjs` stops a handler importing it — every write handler in the tree had eroded off this rule at once, because nothing about a double-wrapped response looks wrong until a write fails. The wrappers that used to do this per verb are gone.

A worded confirmation travels as the fifth argument to `createTool` instead, so registration can apply it from inside that one wrapper:

```typescript
createTool('create_widget', 'Create a widget', schema, handler, 'Widget created successfully!')
```

It heads the record on the success path only, so carrying one cannot dress a failure up as a success. A handler with nothing to head returns its whole answer as a string, which `withErrorHandling` passes through untouched — `delete_ticket` is the one doing that, since a successful delete comes back empty and the sentence has to name the id.

## Development Notes

- `request` throws `ZendeskRequestError`, carrying the HTTP status when Zendesk answered and leaving it undefined when the request never completed. Classify on that and on nothing else. A status means an answer came back; no status means none did, whatever the underlying cause was. Two tempting alternatives are both wrong here. Matching the message cannot work, because the message is built out of the response body and so cannot tell a status from the same digits quoted inside one. Matching an error's `name` or `code` reads as more principled and is no better: `code` is a Node convention, true of undici under Vitest and absent on the runtime that serves traffic. Probed against workerd, a dropped connection is a plain `Error` reading `Network connection lost.` and an unresolvable host is `internal error; reference = <opaque id>`, so there is nothing there to key on
- Every API method on the client goes through `send`, which reads the HTTP verb and picks the retry policy from it. A method says what request it wants and never how many times to send it, so there is no per-method judgement to get wrong — which is the whole of #54, where five methods had chosen to retry and fifty-odd had not for no reason they shared. Do not call `request` or `requestWithRetry` from an API method; `which methods retry` in `src/zendesk-client.test.ts` walks the prototype and catches one that does. Its denylist of non-API methods is a denylist on purpose, so a new API method is covered the day it is written and can only escape by being named
- Every `GET` is retried and nothing else is. A read changes nothing and the deadline already bounds what a retry costs, so retrying one is close to free; a write has no idempotency key on these endpoints, so a 503 on a create that had actually succeeded is indistinguishable from one on a create that had not, and asking again makes the second ticket. That is blunter than the facts support — a 429 or a 408 refuses a request before acting on it, so a write could safely be sent again on either, and #58 is where that gets decided
- The backoff ladder is jittered and `Retry-After` deliberately is not. Jitter spreads a number this client chose; jittering one Zendesk gave us would have half the callers asking earlier than it agreed to. How wide the window is and what not to size it against are decisions about the expression itself, so they sit on it in `requestWithRetry` rather than here
- A whole `requestWithRetry` call is bounded by one deadline covering every attempt and every backoff, rather than by a timeout each attempt restarts — `request` takes an explicit timeout and the loop hands it whatever remains. Do not give `Retry-After` a cap of its own. The deadline already is one, and it is the honest one: a wait that will not fit ends the call and says so, where a clamp would retry early against a quota Zendesk has already said is spent. `maxRetries` survives as a backstop for failures that arrive instantly and decides nothing once attempts take real time
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
