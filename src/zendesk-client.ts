/**
 * Centralized Zendesk API client with authentication and request handling
 * Compatible with Cloudflare Workers environment
 * Provides methods for all major Zendesk API endpoints across Support, Talk, Chat, and Guide
 */

import type { MacroCreatePayload, MacroUpdatePayload } from './types/zendesk'

interface ZendeskClientConfig {
	subdomain?: string
	email?: string
	apiToken?: string
}

/**
 * The slice of the Worker environment this client reads. Naming it keeps a typo like
 * ZENDESK_SUBDOMIAN a compile error rather than an empty string that only surfaces as a
 * failed API call, and lets tests pass credentials without a whole Env.
 */
type ZendeskEnv = Pick<Env, 'ZENDESK_SUBDOMAIN' | 'ZENDESK_EMAIL' | 'ZENDESK_API_TOKEN'>

/**
 * What `request` throws. `status` is the HTTP status when the server answered and undefined
 * when it did not, which is the distinction the retry policy turns on: a status means Zendesk
 * replied and said no, no status means the request never completed.
 *
 * It exists so that the status survives being turned into a sentence. `request` builds its
 * message out of the response body, and the classifier used to search that message for '429'
 * and friends — which cannot tell a status from the same three digits quoted in a body.
 */
export class ZendeskRequestError extends Error {
	constructor(
		message: string,
		readonly status?: number,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'ZendeskRequestError'
	}
}

/**
 * Statuses where Zendesk is asking to be called back rather than refusing the request.
 *
 * 408 is in because it means the request timed out on their side and is worth sending again.
 * The old classifier retried it only when the body happened to contain the word "timeout",
 * so an empty-bodied 408 was dropped — the inconsistency is the bug, not the retry.
 *
 * 500 is out, for the opposite reason: it is a fault that will fail the same way on a second
 * attempt. 502, 503 and 504 mean the request never reached a healthy backend at all.
 */
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 504])

/**
 * Error names fetch uses when the request never produced a response. `AbortError` is what the
 * 30 second timeout below raises; `TimeoutError` is what `AbortSignal.timeout` would raise if
 * this ever moves to it.
 */
const RETRYABLE_ERROR_NAMES = new Set(['AbortError', 'TimeoutError'])

/**
 * Socket-level failures, which arrive as a `code` rather than as a distinct error name.
 *
 * `code` is a Node convention, so this branch fires under Vitest and would fire on Node, but
 * not on workerd, where a dropped connection comes back as a plain `Error` reading "Network
 * connection lost." with no code to match on. Those go unretried, which is what they did
 * before this file stopped matching message text as well — the old substring list looked for
 * `econnreset`, and workerd's wording contains nothing of the sort. See #29.
 */
const RETRYABLE_ERROR_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'])

/**
 * Yields an error and then each `cause` beneath it. `request` rewraps whatever it caught, so
 * the failure worth classifying is usually a link or two down rather than in hand — and fetch
 * itself nests, reporting a socket error as the cause of a bare "fetch failed".
 *
 * The depth cap is only there so a self-referential chain cannot hang the retry loop.
 */
function* causeChain(error: unknown, maxDepth = 10): Generator<Error> {
	let current = error
	for (let depth = 0; depth < maxDepth && current instanceof Error; depth += 1) {
		yield current
		current = current.cause
	}
}

export class ZendeskClient {
	private subdomain: string
	private email: string
	private apiToken: string

	constructor(config?: ZendeskClientConfig, env?: ZendeskEnv) {
		// Load Zendesk credentials from config, environment, or Cloudflare Workers env
		this.subdomain = config?.subdomain || env?.ZENDESK_SUBDOMAIN || ''
		this.email = config?.email || env?.ZENDESK_EMAIL || ''
		this.apiToken = config?.apiToken || env?.ZENDESK_API_TOKEN || ''

		// Validate and sanitize subdomain to prevent injection
		if (this.subdomain) {
			this.subdomain = this.sanitizeSubdomain(this.subdomain)
		}

		// Warn if credentials are missing (but allow instantiation for testing)
		if (!this.subdomain || !this.email || !this.apiToken) {
			console.warn(
				'Zendesk credentials not found. Please set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, and ZENDESK_API_TOKEN.'
			)
		}
	}

	/**
	 * Sanitize subdomain to prevent injection attacks
	 * Only allows alphanumeric characters, hyphens, and underscores
	 */
	private sanitizeSubdomain(subdomain: string): string {
		const sanitized = subdomain.replace(/[^a-zA-Z0-9-_]/g, '')
		if (sanitized !== subdomain) {
			console.warn(`Subdomain was sanitized from "${subdomain}" to "${sanitized}"`)
		}
		return sanitized
	}

	/**
	 * Validate and sanitize endpoint path to prevent path traversal
	 */
	private sanitizeEndpoint(endpoint: string): string {
		// Remove any attempts at path traversal
		const sanitized = endpoint.replace(/\.\./g, '').replace(/\/\//g, '/')
		// Ensure endpoint starts with /
		return sanitized.startsWith('/') ? sanitized : `/${sanitized}`
	}

	/**
	 * Validate numeric IDs to prevent injection
	 */
	private validateId(id: number): number {
		if (!Number.isInteger(id) || id <= 0) {
			throw new Error(`Invalid ID: ${id}. ID must be a positive integer.`)
		}
		return id
	}

	// Construct the base URL for Zendesk API v2 endpoints
	private getBaseUrl(): string {
		return `https://${this.subdomain}.zendesk.com/api/v2`
	}

	// Generate Basic Authentication header using email/token format
	private getAuthHeader(): string {
		// Use Web API btoa instead of Node.js Buffer
		const credentials = `${this.email}/token:${this.apiToken}`
		const encoded = btoa(credentials)
		return `Basic ${encoded}`
	}

	/**
	 * Core HTTP request method with authentication and error handling
	 * Uses fetch API compatible with Cloudflare Workers
	 */
	async request(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>
	): Promise<unknown> {
		try {
			// Validate credentials before making requests
			if (!this.subdomain || !this.email || !this.apiToken) {
				throw new Error('Zendesk credentials not configured. Please set environment variables.')
			}

			// Sanitize endpoint to prevent path traversal attacks
			const sanitizedEndpoint = this.sanitizeEndpoint(endpoint)

			const url = new URL(`${this.getBaseUrl()}${sanitizedEndpoint}`)

			// Add query parameters if provided
			if (params) {
				Object.entries(params).forEach(([key, value]) => {
					if (value !== undefined && value !== null) {
						url.searchParams.append(key, String(value))
					}
				})
			}

			const headers: Record<string, string> = {
				Authorization: this.getAuthHeader(),
				'Content-Type': 'application/json',
				Accept: 'application/json',
			}

			// Create AbortController for timeout (compatible with all Workers versions)
			const abortController = new AbortController()
			const timeoutId = setTimeout(() => abortController.abort(), 30000)

			const requestInit: RequestInit = {
				method,
				headers,
				signal: abortController.signal,
			}

			// Only include body for non-GET requests
			if (method !== 'GET' && data !== null && data !== undefined) {
				requestInit.body = JSON.stringify(data)
			}

			try {
				const response = await fetch(url.toString(), requestInit)
				clearTimeout(timeoutId)

				if (!response.ok) {
					const errorText = await response.text()
					throw new ZendeskRequestError(
						`Zendesk API Error: ${response.status} - ${errorText}`,
						response.status
					)
				}

				// Handle empty responses (e.g., from DELETE requests)
				const contentType = response.headers.get('content-type')
				if (contentType && contentType.includes('application/json')) {
					return await response.json()
				} else {
					return { success: true }
				}
			} finally {
				clearTimeout(timeoutId)
			}
		} catch (error) {
			// Re-throw with more context, preserving original error chain for debugging.
			// The status is carried onto the new error rather than left behind in the message,
			// so a caller holding what request threw can read it without walking `cause`.
			if (error instanceof Error) {
				throw new ZendeskRequestError(
					`Zendesk request failed: ${error.message}`,
					error instanceof ZendeskRequestError ? error.status : undefined,
					{ cause: error }
				)
			}
			throw error
		}
	}

	/**
	 * Check if an error is retryable (transient failure)
	 *
	 * Classification reads the status and the error's identity, never the message text. The
	 * message is built out of the Zendesk response body, so matching on it cannot tell a 502
	 * that happened from a 502 the body merely quotes.
	 */
	private isRetryableError(error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false
		}

		for (const link of causeChain(error)) {
			// A status means Zendesk answered. Retry only the ones that mean "ask again";
			// anything else it refused will be refused just as firmly on a second attempt.
			if (link instanceof ZendeskRequestError && link.status !== undefined) {
				return RETRYABLE_STATUSES.has(link.status)
			}

			// No status yet: this link may still be a timeout, or a connection that failed
			// underneath fetch and was reported as the cause of a bare "fetch failed".
			if (RETRYABLE_ERROR_NAMES.has(link.name)) {
				return true
			}
			const { code } = link as { code?: unknown }
			if (typeof code === 'string' && RETRYABLE_ERROR_CODES.has(code)) {
				return true
			}
		}

		return false
	}

	/**
	 * Request with automatic retry for transient failures
	 * Uses exponential backoff for retry delays
	 */
	async requestWithRetry(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>,
		maxRetries = 3
	): Promise<unknown> {
		let lastError: Error | undefined

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				return await this.request(method, endpoint, data, params)
			} catch (error) {
				lastError = error as Error

				// Don't retry if this is the last attempt or error is not retryable
				if (attempt === maxRetries - 1 || !this.isRetryableError(error)) {
					throw error
				}

				// Calculate exponential backoff delay: 1s, 2s, 4s (capped at 5s)
				const delay = Math.min(1000 * Math.pow(2, attempt), 5000)

				console.warn(
					`Request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`,
					{
						error: error instanceof Error ? error.message : String(error),
						method,
						endpoint,
					}
				)

				// Wait before retrying
				await new Promise((resolve) => setTimeout(resolve, delay))
			}
		}

		throw lastError
	}

	// === TICKETS API ===
	async listTickets(params?: Record<string, unknown>) {
		return this.request('GET', '/tickets.json', null, params)
	}

	async getTicket(id: number) {
		this.validateId(id)
		return this.requestWithRetry('GET', `/tickets/${id}.json`)
	}

	async createTicket(data: any) {
		return this.request('POST', '/tickets.json', { ticket: data })
	}

	async updateTicket(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/tickets/${id}.json`, { ticket: data })
	}

	async deleteTicket(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/tickets/${id}.json`)
	}

	// === USERS API ===
	async listUsers(params?: Record<string, unknown>) {
		return this.request('GET', '/users.json', null, params)
	}

	async getUser(id: number) {
		this.validateId(id)
		return this.requestWithRetry('GET', `/users/${id}.json`)
	}

	async createUser(data: any) {
		return this.request('POST', '/users.json', { user: data })
	}

	async updateUser(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/users/${id}.json`, { user: data })
	}

	async deleteUser(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/users/${id}.json`)
	}

	// === ORGANIZATIONS API ===
	async listOrganizations(params?: Record<string, unknown>) {
		return this.request('GET', '/organizations.json', null, params)
	}

	async getOrganization(id: number) {
		this.validateId(id)
		return this.request('GET', `/organizations/${id}.json`)
	}

	async createOrganization(data: any) {
		return this.request('POST', '/organizations.json', { organization: data })
	}

	async updateOrganization(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/organizations/${id}.json`, { organization: data })
	}

	async deleteOrganization(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/organizations/${id}.json`)
	}

	// === GROUPS API ===
	async listGroups(params?: Record<string, unknown>) {
		return this.request('GET', '/groups.json', null, params)
	}

	async getGroup(id: number) {
		this.validateId(id)
		return this.request('GET', `/groups/${id}.json`)
	}

	async createGroup(data: any) {
		return this.request('POST', '/groups.json', { group: data })
	}

	async updateGroup(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/groups/${id}.json`, { group: data })
	}

	async deleteGroup(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/groups/${id}.json`)
	}

	// === MACROS API ===
	async listMacros(params?: Record<string, unknown>) {
		return this.request('GET', '/macros.json', null, params)
	}

	async getMacro(id: number) {
		this.validateId(id)
		return this.request('GET', `/macros/${id}.json`)
	}

	/**
	 * The two typed payloads on this client. Their types come from the macro tools' own Zod
	 * schemas, so what a caller may send is whatever MCP already validated. The other sixteen
	 * create and update payloads are still `any` and are #12's to settle.
	 */
	async createMacro(data: MacroCreatePayload) {
		return this.request('POST', '/macros.json', { macro: data })
	}

	async updateMacro(id: number, data: MacroUpdatePayload) {
		this.validateId(id)
		return this.request('PUT', `/macros/${id}.json`, { macro: data })
	}

	async deleteMacro(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/macros/${id}.json`)
	}

	// === VIEWS API ===
	async listViews(params?: Record<string, unknown>) {
		return this.request('GET', '/views.json', null, params)
	}

	async getView(id: number) {
		this.validateId(id)
		return this.request('GET', `/views/${id}.json`)
	}

	async createView(data: any) {
		return this.request('POST', '/views.json', { view: data })
	}

	async updateView(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/views/${id}.json`, { view: data })
	}

	async deleteView(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/views/${id}.json`)
	}

	// === TRIGGERS API ===
	async listTriggers(params?: Record<string, unknown>) {
		return this.request('GET', '/triggers.json', null, params)
	}

	async getTrigger(id: number) {
		this.validateId(id)
		return this.request('GET', `/triggers/${id}.json`)
	}

	async createTrigger(data: any) {
		return this.request('POST', '/triggers.json', { trigger: data })
	}

	async updateTrigger(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/triggers/${id}.json`, { trigger: data })
	}

	async deleteTrigger(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/triggers/${id}.json`)
	}

	// === AUTOMATIONS API ===
	async listAutomations(params?: Record<string, unknown>) {
		return this.request('GET', '/automations.json', null, params)
	}

	async getAutomation(id: number) {
		this.validateId(id)
		return this.request('GET', `/automations/${id}.json`)
	}

	async createAutomation(data: any) {
		return this.request('POST', '/automations.json', { automation: data })
	}

	async updateAutomation(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/automations/${id}.json`, { automation: data })
	}

	async deleteAutomation(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/automations/${id}.json`)
	}

	// === SEARCH API ===
	async search(query: string, params: Record<string, unknown> = {}) {
		return this.requestWithRetry('GET', '/search.json', null, { query, ...params })
	}

	// === HELP CENTER API ===
	async listArticles(params?: Record<string, unknown>) {
		return this.request('GET', '/help_center/articles.json', null, params)
	}

	async getArticle(id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/articles/${id}.json`)
	}

	async createArticle(data: any, sectionId: number) {
		this.validateId(sectionId)
		return this.request('POST', `/help_center/sections/${sectionId}/articles.json`, {
			article: data,
		})
	}

	async updateArticle(id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/help_center/articles/${id}.json`, { article: data })
	}

	async deleteArticle(id: number) {
		this.validateId(id)
		return this.request('DELETE', `/help_center/articles/${id}.json`)
	}

	async searchArticles(params?: Record<string, unknown>) {
		return this.requestWithRetry('GET', '/help_center/articles/search.json', null, params)
	}

	// Categories
	async listCategories(params?: Record<string, unknown>) {
		return this.request('GET', '/help_center/categories.json', null, params)
	}

	async getCategory(id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/categories/${id}.json`)
	}

	/* DISABLED FOR SECURITY - create_category method
	async createCategory (data: any) {
		return this.request('POST', '/help_center/categories.json', { category: data })
	}
	*/

	/* DISABLED FOR SECURITY - update_category method
	async updateCategory (id: number, data: any) {
		return this.request('PUT', `/help_center/categories/${id}.json`, { category: data })
	}
	*/

	/* DISABLED FOR SECURITY - delete_category method
	async deleteCategory (id: number) {
		return this.request('DELETE', `/help_center/categories/${id}.json`)
	}
	*/

	// Sections
	async listSections(params?: Record<string, unknown>) {
		return this.request('GET', '/help_center/sections.json', null, params)
	}

	async getSection(id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/sections/${id}.json`)
	}

	/* DISABLED FOR SECURITY - create_section method
	async createSection (data: any, categoryId: number) {
		return this.request('POST', `/help_center/categories/${categoryId}/sections.json`, { section: data })
	}
	*/

	/* DISABLED FOR SECURITY - update_section method
	async updateSection (id: number, data: any) {
		return this.request('PUT', `/help_center/sections/${id}.json`, { section: data })
	}
	*/

	/* DISABLED FOR SECURITY - delete_section method
	async deleteSection (id: number) {
		return this.request('DELETE', `/help_center/sections/${id}.json`)
	}
	*/

	async listSectionsByCategory(categoryId: number, params?: Record<string, unknown>) {
		this.validateId(categoryId)
		return this.request('GET', `/help_center/categories/${categoryId}/sections.json`, null, params)
	}

	async listArticlesBySection(sectionId: number, params?: Record<string, unknown>) {
		this.validateId(sectionId)
		return this.request('GET', `/help_center/sections/${sectionId}/articles.json`, null, params)
	}

	// === TALK API ===
	async getTalkStats() {
		return this.request('GET', '/channels/voice/stats.json')
	}

	// === CHAT API ===
	async listChats(params?: Record<string, unknown>) {
		return this.request('GET', '/chats.json', null, params)
	}
}
