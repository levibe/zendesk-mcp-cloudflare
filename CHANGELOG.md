# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-08-05

### Added

- Write tools for macros, triggers, automations, Help Center articles, users, groups, organizations and views (#21, #22, #23, #12). Only the macro pair is published to clients — everything else is defined but withheld by the registration allowlist until somebody publishes it deliberately.
- Compiler-held guardrails on the sharper writes: a trigger, automation or view is always created dormant, an article is always created as a draft that these tools cannot publish or re-audience, and every user this server creates is an end-user (#22, #23, #12).
- `support_info` asks Zendesk about the account instead of describing the server, and answers only what it was asked for.
- A test suite over the code that branches, per-file coverage thresholds on the modules that decide something, and a coverage report posted on every pull request (#14, #25, #26).
- Clients on the 2026-07-28 MCP revision may cache the tool list for five minutes (#47).

### Changed

- Migrated to the stateless 2026-07-28 MCP revision: a fresh server per request, no Durable Object, `/sse` removed (#40). Pre-revision clients still work through the legacy path, but a client that can only speak HTTP+SSE cannot connect.
- MCP is served over Streamable HTTP at `/mcp` (#1).
- The retry policy was rebuilt around one deadline per call and what the response said: the HTTP verb decides what may retry, failures classify on status alone, and a `Retry-After` is waited out in full with up to a second of spread added after it, never before (#17, #29, #54, #56, #58, #78).
- Redirects are no longer followed: the platform strips `Authorization` on a cross-host hop, so a 3xx fails naming where it pointed instead of surfacing as a misleading 401 (#39).
- `no-explicit-any` is enforced at error, with the vendored OAuth file quarantined; the read path returns `unknown` for callers to narrow, and every write payload derives from its tool's own Zod schema (#8, #12, #13).
- The toolchain is pinned: pnpm via `packageManager`, Prettier owning formatting, current Cloudflare runtime and Wrangler (#2, #5).

### Removed

- The endpoint path sanitizer on the Zendesk client, which nothing could reach: every endpoint is built from a fixed literal or an already-validated id, so removing it changes no request this server can send.
- The constructor's missing-credentials warning, which a stateless server logged on every tool call; `request` already throws before sending anything, and that reaches the caller where the warning only reached the log.
- Six commented-out Help Center write methods labelled `DISABLED FOR SECURITY`; the registration allowlists are the control, and would withhold those tools whether or not the methods existed.

### Fixed

- OAuth state is encoded through UTF-8, so an authorization request carrying non-ASCII text signs in instead of getting a fixed 400 on every attempt (#74). Old-format states and approval cookies keep decoding, permanently — the cookie lives for a year.
- A corrupt approval cookie falls through to the consent dialog instead of answering 500 on every `/authorize` until the user clears cookies by hand (#4).
- A failed write and a failed read are reported as failures instead of hiding inside a response that reads as success (#28, #68).
- `list_chats` stopped advertising pagination parameters the Chat API never reads (#67).
- A tool with nothing to report keeps its response text a string (#60).

### Security

- The OAuth callback state is bound to the browser that started the flow with a nonce cookie, refusing authorization-code injection (#65).
- The consent page checks link schemes when it renders, not only at client registration (#3).
- Malformed input to the OAuth endpoints answers a fixed 400 instead of a bare 500, and responses are bounded (#64).
- The CI token that writes pull-request comments is kept out of the job that installs dependencies (#30).
- Corrects the record on 0.1.0, whose entry below is left as shipped: "Validate endpoint paths to prevent path traversal" listed a control nothing could reach, so removing it lowers no real defence. The place a model-supplied string genuinely becomes syntax — the `search_*` tools concatenating free text into a search expression — is unchanged, and is recorded beside `validateId` in `src/zendesk-client.ts`.

## [0.1.0] - 2025-10-16

### Added

- Request timeout protection (30s) to prevent hanging operations
- Automatic retry logic with exponential backoff for transient failures
- Input validation and sanitization for subdomain, endpoints, and IDs
- Structured error logging with timing metrics and stack traces
- Enhanced error metadata (errorType, errorCause, duration) for MCP clients
- Error chain preservation using cause parameter for debugging

### Fixed

- OAuth token exchange using correct snake_case parameter names
- AbortSignal.timeout() replaced with AbortController for broader runtime compatibility
- Unsafe type assertions replaced with proper TypeScript types

### Changed

- Enable retry logic on critical operations (search, getTicket, getUser, searchArticles)
- Reduce exponential backoff cap from 10s to 5s for better user experience
- Remove hardcoded production credentials from configuration

### Security

- Sanitize subdomain input to prevent injection attacks
- Validate endpoint paths to prevent path traversal
- Validate numeric IDs as positive integers across all API methods

## [0.0.1] - 2025-07-22

### Added

- Initial release of Zendesk MCP server
- Google OAuth authentication
- Comprehensive Zendesk API client
- Support for Tickets, Users, Organizations, Groups, Macros, Views, Triggers, Automations
- Help Center API support (Articles, Categories, Sections)
- Search functionality
- Cloudflare Workers deployment
