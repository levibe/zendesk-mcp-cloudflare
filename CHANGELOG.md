# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
