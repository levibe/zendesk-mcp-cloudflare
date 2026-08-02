# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- The endpoint path sanitizer on the Zendesk client, along with the call to it in `request`. It stripped `..` and collapsed `//` on the path, and nothing could ever reach it: every endpoint is built inside the client from a fixed literal or from an id `validateId` has already checked, and no tool handler supplies one. Removing it changes no request this server can send.
- The constructor's warning about missing credentials. The server has been stateless since #40, so a client is built for every request and a misconfigured Worker logged that line on every tool call. `request` already throws `Zendesk credentials not configured` before it sends anything, and unlike the warning that reaches the caller.
- Six commented-out Help Center write methods labelled `DISABLED FOR SECURITY` (create, update and delete for categories and sections). They dated from before registration became the enforcement point and read as though the comment were the control. The allowlists in `src/utils/tool-registry.ts` are what decides, and they would withhold those tools whether or not the methods existed.

### Security

- Corrects the record on 0.1.0, whose entry below is left as shipped. "Validate endpoint paths to prevent path traversal" listed a control that was never reachable, so it protected nothing and cost every reader of the request path the time to work out why. Removing it lowers no real defence. The place a model-supplied string genuinely becomes syntax is untouched and still open: the `search_*` tools concatenate free text into a Zendesk search expression, so a query can change what is being searched. It crosses no privilege boundary — one shared service account, reads only — and is recorded in a comment beside `validateId` in `src/zendesk-client.ts` rather than fixed here.

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
