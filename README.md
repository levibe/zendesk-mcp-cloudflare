# Zendesk MCP Server with Google OAuth

This is a [Model Context Protocol (MCP)](https://modelcontextprotocol.io/introduction) server that provides comprehensive Zendesk API integration with Google OAuth authentication, deployed on Cloudflare Workers.

The server allows MCP clients (like Claude Desktop) to interact securely with Zendesk APIs through authenticated remote connections. It reads across tickets, users, organizations, the Help Center and more, and writes only macros.

[Available Tools](#available-tools) is the authority on what it will and will not do.

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

Complete the authentication flow and you'll see the tools the server publishes.

## Connecting a Claude Client

There are two routes in, and they behave differently enough that the choice matters. Prefer the connector unless something rules it out.

### As a custom connector

Claude holds remote MCP servers on your account rather than in a file on disk, so there is nothing to install and no Node runtime on the machine. Each person adds it once themselves, and it asks for a display name as well as the URL:

```
Name   Momentum Zendesk
URL    https://zendesk-mcp.<your-subdomain>.workers.dev/mcp
```

Inside Claude Desktop that is **Settings → Connectors → Add custom connector**, which `Cmd+,` opens directly. At claude.ai it sits under **Customize → Connectors** instead, behind the **+** button.

An Owner on Team or Enterprise can instead enable the connector for the whole organization, under **Organization settings → Connectors**. That saves everyone adding it, but it does not sign anyone in. Each member still authorizes individually the first time they use it, unless the organization has configured managed authentication.

Either way the connector follows the account rather than the machine, so it appears in Claude Desktop and at claude.ai both, and `claude_desktop_config.json` is not involved at all.

`/mcp` is the only endpoint. `/sse` served the superseded HTTP+SSE transport, which MCP revision 2026-07-28 deprecates outright, and it has been removed, so a client configured against it now gets nothing. Clients too old to speak the current revision are still served at `/mcp`, so on transport grounds this only strands one that can speak HTTP+SSE and nothing else.

A browser-based client can be turned away for an unrelated reason. The server validates the `Origin` header whenever a request carries one, accepting localhost and, on a `workers.dev` address, the worker's own hostname. A custom domain is therefore left allowing localhost alone, and any other origin gets a 403. Nothing on this page is affected, since a connector is fetched by Anthropic's servers and `mcp-remote` runs under Node, so neither sends an `Origin` at all. It is only worth knowing if a browser-based client fails with a message about origins rather than about transports.

Anthropic's infrastructure makes this connection rather than the user's machine, so the worker has to be reachable over the public internet, which a deployed worker already is. That is also the property that makes this route viable for people who will never open a terminal: nothing runs locally, so there is nothing local to go wrong. `HOSTED_DOMAIN` still governs who may sign in, so a connector does not widen access.

### Through the `mcp-remote` proxy

Servers listed in `claude_desktop_config.json` are started as local programs and spoken to over stdin and stdout, so reaching an HTTP server needs a local adapter in between. Use this only for clients that cannot take a connector.

Open the file with **Settings → Developer → Edit Config**, or edit it directly:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`, which expands to `C:\Users\<you>\AppData\Roaming\Claude\claude_desktop_config.json`

The file usually already holds your app preferences, so add `mcpServers` alongside the keys that are there rather than replacing the whole thing. Leave the command as `npx` and not `pnpm dlx`: it runs on the user's own machine, where Node ships `npx` but pnpm may not be installed at all. The `-y` matters, because `npx` asks to confirm before installing a package it does not have yet and there is no terminal for anyone to answer in.

```json
{
	"mcpServers": {
		"zendesk": {
			"command": "npx",
			"args": [
				"-y",
				"mcp-remote",
				"https://zendesk-mcp.<your-subdomain>.workers.dev/mcp",
				"--auth-timeout",
				"120"
			]
		}
	}
}
```

Claude Desktop reads this file only at launch, so quit it fully and start it again. Closing the window leaves it running in the background and changes nothing. On macOS press Cmd+Q, and on Windows right-click the tray icon and choose Quit. To point at a local server instead, run `pnpm run dev` and use `http://localhost:8788/mcp`.

This route asks a lot more of the machine, and the failures are worth knowing before handing it to anyone:

- **Node has to be installed.** `npx` is not present on a machine without Node, which rules this out for most non-technical users on its own.
- **Two timers run against first-time sign-in, and both are short.** `mcp-remote` waits 30 seconds for the OAuth callback unless `--auth-timeout` says otherwise, and Claude Desktop separately cancels a server that has not finished initializing within 60 seconds. Picking a Google account can outlast either. The symptom is a browser landing on `localhost:<port>` with nothing listening, because the proxy was gone before the redirect came back. Retrying usually works, since the second attempt reuses the approval cookie and the Google session, which is exactly why this is easy to dismiss as a fluke.
- **A slow tool call gets dropped.** Node's fetch abandons a response body after 300 seconds of silence, which surfaces as `Body Timeout Error` and a reconnect underneath you, and reconnecting can re-enter the auth path and open a browser window unprompted. This used to be the common failure, because the server held a stream open between calls for the old transport to push down. It no longer holds one, so the only way to sit silent that long now is a single Zendesk request taking five minutes.
- **Windows cannot find `npx`.** Claude Desktop spawns the command without a shell, so the `.cmd` shim never resolves. Use `"command": "cmd"` with `"args": ["/c", "npx", "mcp-remote", "<your-url>"]`.
- **Tokens are cached on disk.** They live in `~/.mcp-auth` on macOS and `%USERPROFILE%\.mcp-auth` on Windows. Delete that folder if authentication gets stuck after a URL change. A stale lockfile there needs no attention, since the proxy detects and clears it.

### Either way

Authenticate through the browser flow when prompted, then ask Claude to:

- "Show me the latest support tickets"
- "Search for tickets about billing problems"
- "List all users in the Sales organization"
- "Draft a macro that solves a ticket and thanks the customer"

## Connecting ChatGPT

ChatGPT speaks MCP as well, so this server works there, but only through Developer Mode.

ChatGPT consumes an MCP server in two quite different ways. An ordinary connector, the kind behind deep research and company knowledge, never calls arbitrary tools: it calls exactly two, named `search` and `fetch`, returning a shape OpenAI specifies. This server publishes neither, so ChatGPT will refuse to add it that way. Developer Mode is the other route, and there the whole published tool list is callable, which is more than the two-tool connector would ever have given you.

### Enabling Developer Mode

It is a beta feature on the web, available on Pro, Plus, Business, Enterprise and Education accounts. Find it under **Settings → Security and login** and turn on the **Developer mode** toggle. That toggle has moved between releases and previously lived under **Settings → Connectors → Advanced settings**, so look there if it is not where you expect.

On a Business or Enterprise workspace an administrator can switch Developer Mode off for everyone, or allow only named connectors. A missing toggle on a work account usually means that rather than an unsupported plan.

### Adding the server

With Developer Mode on, create a connector and give it a name, the URL and OAuth as the authentication method:

```
Name   Momentum Zendesk
URL    https://zendesk-mcp.<your-subdomain>.workers.dev/mcp
```

Use `/mcp`. Ignore any instruction that a remote MCP URL has to end in `/sse`, including some of OpenAI's own documentation. That endpoint served the superseded transport and has been removed here, as described above. ChatGPT speaks Streamable HTTP, which is what `/mcp` answers.

You will be sent through the Google sign-in flow the first time, and `HOSTED_DOMAIN` governs who may complete it, exactly as it does for a Claude connector. ChatGPT registers itself through `/register` on the way past, so there is no client ID to create or paste anywhere.

### Living with it

The connector appears as a Developer mode tool in the composer, and you select it during a conversation rather than it being always on.

The tool list is the same one Claude sees: the reads, plus `create_macro` and `update_macro`. Nothing is published to one client and withheld from another, because registration applies the same policy on every request whoever is asking.

Write actions ask for confirmation before they run. You can tell ChatGPT to remember the answer for the rest of that conversation, and a new conversation starts asking again. Read the arguments rather than waving it through: that prompt is the last thing standing between a model's mistake and a real macro in Zendesk.

Deep research and company knowledge will not use this server at all, for the reason at the top of this section: they only ever reach for `search` and `fetch`.

OpenAI is direct that Developer Mode is for people who understand what they are switching on, and names three risks: prompt injection, a model getting a write wrong, and a malicious server stealing data. The first two apply here as much as anywhere. The third is a question about who runs the server, which in this case is you. What limits the blast radius of the other two is the same thing that limits it for every other client. Deleting a ticket, creating a user and the rest are never offered to anybody, so full access in Developer Mode is full access to a deliberately short list.

## Available Tools

The server reads widely and writes almost nothing.

**Reading** covers tickets, users, organizations, groups, macros, views, triggers, automations, Talk statistics, Chat conversations and the whole Help Center. You can list them, fetch one by ID, and search. Anything named `list_*`, `get_*` or `search_*` is available, along with `search` and `support_info`.

**Writing** is limited to `create_macro` and `update_macro`. A macro is a shortcut an agent applies to a ticket by hand, so creating one changes nothing on its own, which is why these two are permitted where nothing else is.

**Everything else is refused.** Creating, updating and deleting a ticket, and creating a user, an organization or a group, are all written and working in the code but never offered to a client, so asking for them will not work. Nothing else writes at all. Deleting a macro, for instance, was never built as a tool. The server logs what it withheld each time it starts.

The permitted set is decided in `src/utils/tool-registry.ts`, and the tools themselves are defined under `src/tools/`. See CLAUDE.md for how a tool gets permitted.

## Development

### Adding New Tools

1. Add the API method to `ZendeskClient` in `src/zendesk-client.ts`
2. Add a `createTool` entry to the relevant file under `src/tools/`
3. If the file is a new one, add it to `toolCategories` in `src/tools/index.ts`. Exporting it is not enough, because registration walks that object and nothing else.

```typescript
// In src/tools/custom.ts
export const customTools: ToolDefinition[] = [
	createTool(
		'list_widgets',
		'List widgets in Zendesk',
		{ ...paginationSchema },
		async (client, params) => {
			return client.listWidgets(params)
		}
	),
]
```

Do not annotate the handler's parameters. They are inferred from the schema you pass as the third argument, and writing the type out by hand creates a second source of truth that nothing reconciles.

Adding a tool does not publish it. A read gets through on its `list_`, `get_` or `search_` prefix, while a write reaches no client at all until it is named in `WRITE_TOOLS_ENABLED` in `src/utils/tool-registry.ts`. CLAUDE.md carries the test a write has to pass to get in.

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
