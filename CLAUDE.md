# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a remote Model Context Protocol (MCP) server that integrates Zendesk API functionality with Google OAuth authentication, deployed on Cloudflare Workers. It allows MCP clients (like Claude Desktop) to securely interact with Zendesk APIs through an authenticated remote connection.

## Architecture

### Core Components

- **Shared MCP scaffolding**: `@levibe/mcp-worker` supplies the tool registry with its reach-level ceilings, the retrying HTTP transport, the Google OAuth handler over `@cloudflare/workers-oauth-provider`, and the `createMcpWorker` factory composing them into the Worker
- **Zendesk API Integration**: Comprehensive Zendesk API client with full CRUD operations for tickets, users, organizations, etc.
- **Cloudflare Workers Deployment**: Serverless, and stateless — no Durable Object, no storage of its own
- **MCP Protocol**: Implements the Model Context Protocol for tool exposure to AI clients

### The mechanism lives in @levibe/mcp-worker

The MCP scaffolding is the private package [`@levibe/mcp-worker`](https://github.com/levibe/mcp-worker), and the design arguments that used to sit in this file travel with the code: the package README and the doc comments on each surface carry them. In particular, that is where to re-read before touching anything near:

- **Statelessness.** The `McpServer` and the client are rebuilt for every request, and hoisting either to module scope is the mistake that answers sequential requests correctly and silently drops a fraction of concurrent traffic. `createMcpWorker` owns that invariant, along with the once-per-isolate withheld-tools announcement — do not reconstruct the wiring by hand. Anything genuinely needing to survive across calls has to become an explicit handle the model passes back as an ordinary tool argument; there is nowhere else to put it.
- **The `tools/list` cache.** The TTL is the only staleness bound there is — this server cannot tell a client the list changed — and the package defaults it to five minutes with `cacheScope: private`, overridable through `cacheHints` on `McpWorkerOptions`, where the reasoning now sits. The list is identical bytes for every caller because registration never consults the authenticated user; #91's per-identity permission model is what would break that, so re-check the cache scope if it lands.
- **The OAuth state cookie.** A cookie is what binds the flow against authorization-code injection, a signature would not, and `/callback` refusing a missing cookie is deliberate. The argument lives with the handler in the package's oauth surface.
- **Origins and legacy clients.** A request with no `Origin` header always passes, which covers everything reaching this server now — the connector fetches server-side, and `mcp-remote` and the Inspector proxy are Node. Browsers get localhost plus the endpoint's own hostname when that is a `workers.dev` address, and `allowedOriginHostnames` widens that one hostname at a time, never with `'*'`. Requests arriving without the 2026-07-28 envelope are still answered; `/sse` is gone, so a client that can speak nothing but HTTP+SSE is the one thing stranded.

What stays this repo's to know: `src/index.ts` is one `createMcpWorker` call, and everything stated there — identity, client, tool manifest, ceilings source, refresh-token TTL — is deployment policy, with the reasoning in a comment beside each value. And every Zendesk request goes out under one shared service account, so a signed-in identity grants no differential access. #91 is what changes that.

### Key Files

- `src/index.ts` - The one `createMcpWorker` call: this deployment's identity, client, tool manifest and risk posture
- `src/zendesk-client.ts` - Zendesk API client, composed over the package's `HttpClient` transport
- `src/tools/` - Tool definitions, one file per Zendesk resource
- `wrangler.jsonc` - Cloudflare Workers deployment configuration, including `TOOL_CEILINGS`

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

`no-explicit-any` is held at `error`, so a new `any` cannot land silently — while it merely warned, `validate` passed with any number of them in the tree, which is how 66 accumulated unnoticed before #8. A new `any` needs its own argued-for exemption, which is the point of the severity.

The client's read path is fully narrowed and should stay that way. Every API method returns `Promise<unknown>`, and every list method takes `Record<string, unknown>` for its query parameters, so reaching into a response body means narrowing it first. Two places do: `src/tools/help-center.ts`, which walks the category and section hierarchy, and `src/utils/search-response.ts`, which reshapes search bodies. Both start from `isRecord` in `src/utils/narrow.ts`, which proves a value is a non-null object and nothing more, leaving every property still `unknown` and still to be checked. Everything else hands the response straight to `JSON.stringify`.

The write path is typed from the other end: every create and update payload on the client derives from the tool's own Zod schema in `src/types/zendesk.ts`, so what a method accepts is exactly what MCP already validated, and no shape is written a second time against Zendesk's documentation. Where a handler reshapes before sending — the ticket comment wrapped into `{ body }`, the view conditions flattened into top-level `all`/`any` — the payload type carries the wire shape, with `Omit` making the reshaping visible rather than a promise the wire never keeps.

One lesson from getting here generalises. `unknown` works for a value the code only passes along — a query parameter that gets stringified, a request body handed to `JSON.stringify` — because the constraint lands on the function body. It buys nothing in a **parameter** position where the body just forwards the value, since `unknown` accepts from a caller exactly what `any` accepts. That is why the payloads were schema-typed rather than swapped to `unknown`, which would have silenced the rule and constrained nobody.

### Deployment

```bash
pnpm run deploy      # Deploy to Cloudflare Workers
```

### Environment Setup

#### Installing @levibe/mcp-worker

`@levibe/mcp-worker` resolves from GitHub Packages, and the committed `.npmrc` carries only the registry mapping. The credential deliberately does not live there: pnpm 11 refuses to expand an env-var credential from a project-level `.npmrc` and then sends no auth header at all, so the token has to come from user-level config, which pnpm still expands (levibe/mcp-worker#5). Three places need one, and they are different tokens:

- **Locally**: a classic PAT with `read:packages`. `~/.zshrc` already exports it from the Keychain as `GITHUB_PACKAGES_TOKEN`, so the user-level `~/.npmrc` line is `//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}`. Note that `gh auth token` does not carry `read:packages`.
- **CI**: the `PACKAGES_READ_TOKEN` repository secret, a PAT with `read:packages` — the same-repo `GITHUB_TOKEN` cannot read another repository's private package. The authenticate step in `ci.yml` writes it into user config with `pnpm config set` before install, and the comment there says why that beats `setup-node`'s `registry-url`.
- **Cloudflare Workers Builds**: `GITHUB_PACKAGES_TOKEN` as a **build** environment variable — build-time, not a runtime var, so the dashboard-var rules below are unaffected — and the build command runs the same `pnpm config set //npm.pkg.github.com/:_authToken "$GITHUB_PACKAGES_TOKEN"` before `pnpm install`. A third build variable makes that ordering possible: `SKIP_DEPENDENCY_INSTALL=true`, without which Workers Builds runs its automatic dependency install before the build command executes, and that install 401s on `@levibe/mcp-worker` before any credential exists. Like the branch-builds switch below, all of this lives in a dashboard, so it is recorded here.

#### Required Secrets (for production)

Set these via `pnpm exec wrangler secret put <SECRET_NAME>`:

- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `COOKIE_ENCRYPTION_KEY` - Random string for cookie encryption
- `ZENDESK_SUBDOMAIN` - Your Zendesk subdomain
- `ZENDESK_EMAIL` - Zendesk API user email
- `ZENDESK_API_TOKEN` - Zendesk API token
- `HOSTED_DOMAIN` - (Optional) Restrict to specific Google domain

Everything above is a secret, including `ZENDESK_SUBDOMAIN` and `ZENDESK_EMAIL`, which are not sensitive. The line is not sensitivity but where the value is set: anything set outside the repo is a secret, and non-secret deployment policy — `TOOL_CEILINGS` — is a var declared in `wrangler.jsonc` itself, where it is reviewed, versioned, and re-stated from the file on every deploy path. What must never exist is a dashboard-set plain var, because it does not survive: Workers Builds deploys the production branch with `wrangler deploy`, which honours `keep_vars`, but builds every other branch with `wrangler versions upload`, which takes no equivalent and clears plain vars while leaving encrypted ones and file-set ones alone. So a dashboard var lasts until the next pull request, and then fails as missing credentials at request time, pointing nowhere near the deploy that removed it.

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

Tools live in `src/tools/`, one file per Zendesk resource, gathered into `toolCategories` in `src/tools/index.ts`. Defining one there does not publish it, so the list a client sees is shorter than the list in the tree. There is no inventory of either here: read the definitions, or make a request and read the line the worker logs naming each group's ceiling and everything it withheld.

Publication is a comparison of two declarations. Every tool declares a reach level at its definition site — the vocabulary is the registry's, in `@levibe/mcp-worker`, ordered `read < stage < write < delete` and drawn on whether the thing takes effect without a human having looked at it — and `wrangler.jsonc` carries a ceiling per group in `TOOL_CEILINGS`. Registration offers a tool exactly when its level fits under its group's ceiling. `create_ticket` and `delete_ticket` are defined, compiled and covered by the type checker, and no client is offered them, because `write` and `delete` sit above the `read` their group ships with.

`activate` — making a staged thing take effect: enabling a rule, publishing an article — is in the vocabulary and deliberately unusable. No tool can declare it and no ceiling can permit it, so "this server never activates anything" is a type rather than a habit shared by whichever files currently observe it. The full vocabulary and the declarable subset are separate types on purpose: the ban is this server's policy, not a limitation of the mechanism, and a future consumer of the mechanism argues for its own subset rather than forking the vocabulary.

The level is a required argument of `createTool` with no default, so a newly added tool stays unexposed until somebody classifies it deliberately — the safety property is not "reads are allowed", it is "nothing is exposed until a human classified it". The tool's name plays no part in publication, so no naming convention ever publishes a future tool by itself. And a withheld tool is deliberately live code — compiled, linted, tested — because the withholding is a runtime comparison against configuration, which no static analysis can prove dead. Commenting tools out, or gating them behind compile-time booleans that make `validate` report unreachable code, is the anti-pattern this design exists to end.

Two tests hold the published surface still, and both live in `src/tool-ceilings-config.test.ts`, deliberately coupled to this repo's `wrangler.jsonc` and its real tool manifest whatever else the registry machinery does. The config test parses `wrangler.jsonc` itself and fails `validate` when `TOOL_CEILINGS` is malformed or drifts from `toolCategories` — which matters because at runtime a bad config fails closed to `read` on every group, and the error logged on every affected request is the only other symptom. The pinned inventory asserts the exact published list, in order, so any change to what clients see has to arrive as an explicit edit to that test that somebody justifies.

Changing what a deployment offers is an edit to `TOOL_CEILINGS` in `wrangler.jsonc`: reviewed, versioned, and atomic with the code that reads it, since file vars are re-stated on every deploy path. Raising a ceiling is the deliberate act that editing the old write allowlist used to be.

### A business rule this server builds can never be running

The trigger and automation writes carry a second guardrail that does not depend on the ceilings, and it is the reason they were safe to write before anyone decided to publish them. Neither `createTriggerSchema` nor `createAutomationSchema` accepts `active`, and the two create handlers send `active: false` themselves — Zendesk defaults a new rule to active, so leaving the field out would have built a live one. The update shapes leave `active` out for the same reason, which is the half that makes the other half mean anything: a rule that could be created dormant and enabled by the next call was never dormant. Turning one on is a human action in the Zendesk UI, and this server offers no way to do it.

`TriggerCreatePayload` and `AutomationCreatePayload` intersect their inferred shape with `{ active: false }` so the compiler holds that rather than a reviewer. A handler passing its validated parameters straight through stops type-checking.

The notification actions — everything named `notification_*`, plus `tweet_requester` and `satisfaction_score` — are refused by `businessRuleActionSchema`. That one is a denylist, which is the opposite shape from the level-and-ceiling comparison above, and the difference is worth keeping rather than tidying. A declared level and a configured ceiling are closed vocabularies of ours, so an exact rule works there. Action fields are Zendesk's and are not: a custom field action is `custom_fields_12345`, so any allowlist wide enough to accept one accepts anything. The prefix does the work, and a notification action Zendesk names some other way would get through — which is precisely why it is not the only control.

### A view this server builds is offered to nobody

The view writes reuse the dormant-create mechanism outright: neither view shape accepts `active`, `create_view` sends `active: false` itself, and `ViewCreatePayload` holds that in its type. A view does not act the way a trigger does, but it is where agents work, and a wrongly-filtered queue misdirects a team in proportion to how much they trust it — so showing one to agents stays a human action in the Zendesk UI. `restriction` is required and nullable at creation for the reason `user_segment_id` is on an article: `null` means every agent, and a caller has to have said so. The update can change neither, and restriction models groups only — a view restricted to a user is that person's personal view, and the only user these credentials could build one for is the service account itself.

Views speak the same per-condition grammar as the business rules but get their own group shape, `viewConditionsSchema`, because Zendesk holds views to stricter rules: `all` is required and non-empty on a view, where a trigger only needs one condition somewhere. The wire differs too — Zendesk wants `all` and `any` at the top level of the view object, and on update it replaces each array independently, touching only the ones that arrive. So the handlers flatten the nested shape at the call and always send both arrays, which is what makes "sending conditions replaces the whole set" true rather than a half-replacement that leaves removed conditions matching. A `null` restriction likewise never reaches the wire: Zendesk documents "every agent" as the property being omitted, so the handler drops the key, and the nullable-required schema field exists to make the caller state the audience rather than to be sent.

### Who somebody is, is set at creation

The user and organization updates are deliberately narrower than their creates, on the article pattern: the sharp fields are stated once, and revision is confined to description. `email`, `role` and `verified` decide where a user's mail goes, what the account may do and whether an identity check happened — rewriting them on a live account is how an account changes hands, so `update_user` offers name and phone and nothing else. Membership is the same rule seen from two sides: `domain_names` on an organization moves a whole email domain in automatically, and `organization_id` on a user moves one person deliberately, but both can change what shared tickets someone sees — so both are settable at creation only.

Creation does not offer `role` at all: every user this server creates is an end-user — `UserCreatePayload` pins `role: 'end-user'` the way the business rule payloads pin `active: false`, so the handler has to state it and forgetting it stops compiling. A privileged account at a caller-chosen email is a takeover in one call — the password reset goes wherever the email points — and an agent is a staff account whose ticket access is a group membership away, so the argument that shuts out `admin` shuts out `agent` with it. Minting either stays a human action in the Zendesk UI until #91's per-identity permission model gives the distinction somewhere to live.

### An article this server writes is always a draft, and its audience is set once

The Help Center writes are shaped the same way and for a different reason. An article is the only thing these tools build that a customer reads rather than an agent, and Zendesk supplies the staging state natively: a draft is invisible to end users. So `createArticleSchema` does not accept `draft`, `create_article` sends `draft: true` itself, and `ArticleCreatePayload` holds that in its type the way the business rule payloads hold `active: false`.

An update is two endpoints rather than one, because Zendesk splits the article itself that way. `PUT /help_center/articles/{id}` applies metadata — labels, promoted, position, comments — and silently ignores `title` and `body`, answering 200 with the article unchanged; content only moves through `PUT /help_center/articles/{id}/translations/{locale}`. So `update_article` routes content through `updateArticleTranslation` and everything else through `updateArticle`, and aims the translation write at the article's source locale, which it reads from the article per call rather than asking the caller. A mixed update is two requests, content first — the locale lookup is the step that can fail, and failing there leaves nothing half-applied.

Publishing is blocked twice over, which is worth knowing before someone tries to add it as a convenience. The translations endpoint is also the one that publishes — `{ translation: { draft: false } }` — so `updateArticleTranslation` is the one method a publish could slip through, and its payload type is what refuses it: `ArticleTranslationUpdatePayload` declares `draft?: never`, so a handler passing the flag stops compiling, the way the create payloads hold `draft: true` and `active: false`. Zendesk marking `draft` read-only on the article endpoint closes the other path.

`update_article` also declines to change who may read an article. `permission_group_id`, `user_segment_id` and `locale` are settable at creation and absent from the update shape, which is why `articleContentSchema` exists as a separate shape rather than the update being a `.partial()` of the whole create. Revising what an article says is an edit; widening who can see it is the change nobody notices until a customer has read something internal. Both stay human actions in the Zendesk UI.

`user_segment_id` is required and nullable rather than optional, and that is the distinction doing the work: `null` means everyone, and a caller has to have said so. An omitted visibility field is how an article ends up more visible than anyone intended.

The body is HTML and deliberately unchecked. A check written here would be a second sanitizer, worse than Zendesk's own and trusted more for sitting closer to the model; what protects the reader is the draft.

## Testing

### Unit Tests

Vitest, with no runtime of its own. Everything under test is either pure or reachable through a stubbed `fetch`, so nothing here needs `workerd` or the network. If something eventually does, `@cloudflare/vitest-pool-workers` runs the same suite inside the real runtime — but reach for it when a test actually requires it, not before.

```bash
pnpm run test            # Run the suite once (what validate uses)
pnpm run test:watch      # Re-run on change while working
pnpm run test:coverage   # Run once and report coverage (text plus coverage/index.html)
```

Coverage measures all of `src/`, not only the files a test imported, so a module nobody covers sits in the table at 0% instead of being absent from it. The report is there to show where the holes are, which means the untested tools belong in the denominator.

Read `coverage/index.html` rather than the terminal table when you want the full picture. Running through a coding agent, Vitest turns `skipFull` on for the text reporter, so files at 100% on all four metrics drop out of it and a directory can print a middling percentage with its finished files nowhere in sight. Setting `coverage.skipFull` back to false does not undo it — the override goes onto the reporter's own options, which win. From a plain terminal, and on CI, every file is listed. The html report always has all of them.

CI runs `test:coverage` and posts the result as a comment on the pull request, so the report is something a reviewer reads rather than something someone has to go and generate. `validate` stays on the bare `test`, which keeps the local loop to the question you usually have — did anything break.

That comment is a map of what is untested, and nothing gates on the overall number. A single figure over all of `src/` is diluted by the denominator described above, so a floor under it would mostly reward covering passthrough code, and would let a real test be deleted from the client as long as one more thin module got covered.

What does gate is a per-file threshold on each module that decides something. The numbers live in `vitest.thresholds.ts`, together with the reasoning for which metrics each one pins, and they need to stay in a file of their own. The coverage-reporting action on CI does not parse the config — it runs a regex per metric over the raw text of `vitest.config.ts` and treats the first number it finds as a target for the whole project, which is wrong here, because nothing gates on the overall figure. They are a ratchet against erosion rather than a target to climb, so set them from the measured value rounded down, with enough slack that unrelated work does not trip them. Raise one when real coverage lands, and say so in the commit when you lower one, because that is coverage being given up.

Posting that comment needs a token that can write to pull requests, so it happens in a second CI job that only checks out and reads the coverage json. Keep it that way. The job running `pnpm install` executes the dependency build scripts `pnpm-workspace.yaml` allows, and a writable token has no business sitting on the same runner while that happens — which goes double now that the install job also holds the packages-read token.

The `json-summary` and `json` reporters exist for that comment rather than for people; `text` and `html` are the ones to read locally. `reportOnFailure` is on so a failing run still explains itself.

Tests sit next to the code they cover as `*.test.ts`, which is why `pnpm run lint` and `tsc --noEmit` already reach them without a second path to configure. `wrangler deploy --dry-run` bundles from `src/index.ts` and follows imports, so nothing imports a test file and none of this ships.

Test what branches. Most tools hand a response straight to `JSON.stringify` and have nothing to get wrong; the sanitizers, the response reshaping and the hierarchy walk all make decisions, and those are what earn a test. The transport's decisions — retry, deadline, `Retry-After` — are tested in `@levibe/mcp-worker`, next to the code.

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
2. Add a `createTool(...)` entry to the relevant `ToolDefinition[]` in `src/tools/`, declaring the tool's reach level — the classification is the deliberate act, so think about it rather than pattern-matching the verb; `@levibe/mcp-worker`'s registry holds the vocabulary. A brand new file also has to be added to `toolCategories` in `src/tools/index.ts` — exporting it alone does not register it — and a brand new category needs its ceiling named in `TOOL_CEILINGS` in `wrangler.jsonc`, which the config test will remind you of by failing `validate`.
   ```typescript
   createTool(
   	'list_widgets',
   	'read',
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

**Registration is where the publication policy is enforced.** `registerTools` withholds anything the group's ceiling does not cover, as described above. A tool registered directly against the server would skip that check and reach clients whatever it does.

A write tool also has to keep its hands off the response. Handlers return the client's result and let the single `withErrorHandling` in `registerTools` shape it, the way every read tool does. A handler that builds a finished response of its own gets wrapped a second time, so the inner response is JSON-encoded as the text of the outer one — which buries `isError` where no client can see it, and a write Zendesk rejected reads back as a successful call. That is why `registerTools` is the only place that calls `withErrorHandling`, and why a `no-restricted-imports` rule in `eslint.config.mjs` stops a handler importing it from the package — every write handler in the tree had eroded off this rule at once, because nothing about a double-wrapped response looks wrong until a write fails. The wrappers that used to do this per verb are gone.

A worded confirmation travels as the final argument to `createTool` instead, so registration can apply it from inside that one wrapper:

```typescript
createTool('create_widget', 'stage', 'Create a widget', schema, handler, 'Widget created!')
```

It heads the record on the success path only, so carrying one cannot dress a failure up as a success. A handler with nothing to head returns its whole answer as a string, which `withErrorHandling` passes through untouched — `delete_ticket` is the one doing that, since a successful delete comes back empty and the sentence has to name the id.

## Development Notes

- `ZendeskRequestError` is the transport's `HttpRequestError`, re-exported under the name this client has always thrown. It carries the HTTP status when Zendesk answered and leaves it undefined when the request never completed — classify on that and on nothing else, because a status means an answer came back and no status means none did, whatever the underlying cause was. The whole retry policy — which statuses retry for which verbs, the statusless case, the one deadline over every attempt, the jittered ladder, redirects never being followed — lives with the transport in `@levibe/mcp-worker`, is deliberately not configurable from here, and carries its arguments in the package's `http-client.ts`
- Every API method on the client goes through `send`, which hands the HTTP verb to the transport, and the verb picks the retry policy. A method says what request it wants and never how many times to send it, so there is no per-method judgement to get wrong — which is the whole of #54, where five methods had chosen to retry and fifty-odd had not for no reason they shared. `which methods retry` in `src/zendesk-client.test.ts` walks the prototype and catches a method that bypasses `send`. Its denylist of non-API methods is a denylist on purpose, so a new API method is covered the day it is written and can only escape by being named
- Environment variables arrive as the `env` argument to `fetch` and are threaded from there. There is no `this.env`, because there is no longer a class to hang it on
- Error handling returns `isError: true` for failed operations
- TypeScript is used throughout for type safety
- Authentication is handled at the OAuth level, not per-API-call level

## Deployment Endpoints

- **MCP Endpoint**: `https://your-worker.workers.dev/mcp` (Streamable HTTP, for MCP clients)
- **OAuth Authorization**: `https://your-worker.workers.dev/authorize`
- **Token Endpoint**: `https://your-worker.workers.dev/token`
