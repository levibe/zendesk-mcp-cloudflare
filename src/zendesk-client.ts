/**
 * Centralized Zendesk API client with authentication and request handling
 * Compatible with Cloudflare Workers environment
 * Provides methods for all major Zendesk API endpoints across Support, Talk, Chat, and Guide
 */

interface ZendeskClientConfig {
	subdomain?: string;
	email?: string;
	apiToken?: string;
}

export class ZendeskClient {
	private subdomain: string
	private email: string
	private apiToken: string

	constructor (config?: ZendeskClientConfig, env?: any) {
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
			console.warn('Zendesk credentials not found. Please set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, and ZENDESK_API_TOKEN.')
		}
	}

	/**
	 * Sanitize subdomain to prevent injection attacks
	 * Only allows alphanumeric characters, hyphens, and underscores
	 */
	private sanitizeSubdomain (subdomain: string): string {
		const sanitized = subdomain.replace(/[^a-zA-Z0-9-_]/g, '')
		if (sanitized !== subdomain) {
			console.warn(`Subdomain was sanitized from "${subdomain}" to "${sanitized}"`)
		}
		return sanitized
	}

	/**
	 * Validate and sanitize endpoint path to prevent path traversal
	 */
	private sanitizeEndpoint (endpoint: string): string {
		// Remove any attempts at path traversal
		const sanitized = endpoint.replace(/\.\./g, '').replace(/\/\//g, '/')
		// Ensure endpoint starts with /
		return sanitized.startsWith('/') ? sanitized : `/${sanitized}`
	}

	/**
	 * Validate numeric IDs to prevent injection
	 */
	private validateId (id: number): number {
		if (!Number.isInteger(id) || id <= 0) {
			throw new Error(`Invalid ID: ${id}. ID must be a positive integer.`)
		}
		return id
	}

	// Construct the base URL for Zendesk API v2 endpoints
	private getBaseUrl (): string {
		return `https://${this.subdomain}.zendesk.com/api/v2`
	}

	// Generate Basic Authentication header using email/token format
	private getAuthHeader (): string {
		// Use Web API btoa instead of Node.js Buffer
		const credentials = `${this.email}/token:${this.apiToken}`
		const encoded = btoa(credentials)
		return `Basic ${encoded}`
	}

	/**
	 * Core HTTP request method with authentication and error handling
	 * Uses fetch API compatible with Cloudflare Workers
	 */
	async request (method: string, endpoint: string, data?: any, params?: Record<string, any>): Promise<any> {
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
				'Authorization': this.getAuthHeader(),
				'Content-Type': 'application/json',
				'Accept': 'application/json'
			}

			// Create AbortController for timeout (compatible with all Workers versions)
			const abortController = new AbortController()
			const timeoutId = setTimeout(() => abortController.abort(), 30000)

			const requestInit: RequestInit = {
				method,
				headers,
				signal: abortController.signal
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
					throw new Error(`Zendesk API Error: ${response.status} - ${errorText}`)
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
			// Re-throw with more context, preserving original error chain for debugging
			if (error instanceof Error) {
				throw new Error(`Zendesk request failed: ${error.message}`, { cause: error })
			}
			throw error
		}
	}

	/**
	 * Check if an error is retryable (transient failure)
	 */
	private isRetryableError (error: unknown): boolean {
		if (!(error instanceof Error)) {
			return false
		}

		// Check for AbortError from timeout (thrown by AbortController)
		if (error.name === 'AbortError') {
			return true
		}

		const message = error.message.toLowerCase()

		// Retry on rate limiting, server errors, and timeouts
		return (
			message.includes('429') ||  // Rate limit
			message.includes('502') ||  // Bad gateway
			message.includes('503') ||  // Service unavailable
			message.includes('504') ||  // Gateway timeout
			message.includes('timeout') || // Timeout errors
			message.includes('econnreset') || // Connection reset
			message.includes('etimedout')  // Connection timed out
		)
	}

	/**
	 * Request with automatic retry for transient failures
	 * Uses exponential backoff for retry delays
	 */
	async requestWithRetry (
		method: string,
		endpoint: string,
		data?: any,
		params?: Record<string, any>,
		maxRetries = 3
	): Promise<any> {
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

				console.warn(`Request failed (attempt ${attempt + 1}/${maxRetries}), retrying in ${delay}ms...`, {
					error: error instanceof Error ? error.message : String(error),
					method,
					endpoint
				})

				// Wait before retrying
				await new Promise(resolve => setTimeout(resolve, delay))
			}
		}

		throw lastError
	}

	// === TICKETS API ===
	async listTickets (params?: Record<string, any>) {
		return this.request('GET', '/tickets.json', null, params)
	}

	async getTicket (id: number) {
		this.validateId(id)
		return this.requestWithRetry('GET', `/tickets/${id}.json`)
	}

	async createTicket (data: any) {
		return this.request('POST', '/tickets.json', { ticket: data })
	}

	async updateTicket (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/tickets/${id}.json`, { ticket: data })
	}

	async deleteTicket (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/tickets/${id}.json`)
	}

	// === USERS API ===
	async listUsers (params?: Record<string, any>) {
		return this.request('GET', '/users.json', null, params)
	}

	async getUser (id: number) {
		this.validateId(id)
		return this.requestWithRetry('GET', `/users/${id}.json`)
	}

	async createUser (data: any) {
		return this.request('POST', '/users.json', { user: data })
	}

	async updateUser (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/users/${id}.json`, { user: data })
	}

	async deleteUser (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/users/${id}.json`)
	}

	// === ORGANIZATIONS API ===
	async listOrganizations (params?: Record<string, any>) {
		return this.request('GET', '/organizations.json', null, params)
	}

	async getOrganization (id: number) {
		this.validateId(id)
		return this.request('GET', `/organizations/${id}.json`)
	}

	async createOrganization (data: any) {
		return this.request('POST', '/organizations.json', { organization: data })
	}

	async updateOrganization (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/organizations/${id}.json`, { organization: data })
	}

	async deleteOrganization (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/organizations/${id}.json`)
	}

	// === GROUPS API ===
	async listGroups (params?: Record<string, any>) {
		return this.request('GET', '/groups.json', null, params)
	}

	async getGroup (id: number) {
		this.validateId(id)
		return this.request('GET', `/groups/${id}.json`)
	}

	async createGroup (data: any) {
		return this.request('POST', '/groups.json', { group: data })
	}

	async updateGroup (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/groups/${id}.json`, { group: data })
	}

	async deleteGroup (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/groups/${id}.json`)
	}

	// === MACROS API ===
	async listMacros (params?: Record<string, any>) {
		return this.request('GET', '/macros.json', null, params)
	}

	async getMacro (id: number) {
		this.validateId(id)
		return this.request('GET', `/macros/${id}.json`)
	}

	async createMacro (data: any) {
		return this.request('POST', '/macros.json', { macro: data })
	}

	async updateMacro (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/macros/${id}.json`, { macro: data })
	}

	async deleteMacro (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/macros/${id}.json`)
	}

	// === VIEWS API ===
	async listViews (params?: Record<string, any>) {
		return this.request('GET', '/views.json', null, params)
	}

	async getView (id: number) {
		this.validateId(id)
		return this.request('GET', `/views/${id}.json`)
	}

	async createView (data: any) {
		return this.request('POST', '/views.json', { view: data })
	}

	async updateView (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/views/${id}.json`, { view: data })
	}

	async deleteView (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/views/${id}.json`)
	}

	// === TRIGGERS API ===
	async listTriggers (params?: Record<string, any>) {
		return this.request('GET', '/triggers.json', null, params)
	}

	async getTrigger (id: number) {
		this.validateId(id)
		return this.request('GET', `/triggers/${id}.json`)
	}

	async createTrigger (data: any) {
		return this.request('POST', '/triggers.json', { trigger: data })
	}

	async updateTrigger (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/triggers/${id}.json`, { trigger: data })
	}

	async deleteTrigger (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/triggers/${id}.json`)
	}

	// === AUTOMATIONS API ===
	async listAutomations (params?: Record<string, any>) {
		return this.request('GET', '/automations.json', null, params)
	}

	async getAutomation (id: number) {
		this.validateId(id)
		return this.request('GET', `/automations/${id}.json`)
	}

	async createAutomation (data: any) {
		return this.request('POST', '/automations.json', { automation: data })
	}

	async updateAutomation (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/automations/${id}.json`, { automation: data })
	}

	async deleteAutomation (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/automations/${id}.json`)
	}

	// === SEARCH API ===
	async search (query: string, params: Record<string, any> = {}) {
		return this.requestWithRetry('GET', '/search.json', null, { query, ...params })
	}

	// === HELP CENTER API ===
	async listArticles (params?: Record<string, any>) {
		return this.request('GET', '/help_center/articles.json', null, params)
	}

	async getArticle (id: number) {
		this.validateId(id)
		return this.request('GET', `/help_center/articles/${id}.json`)
	}

	async createArticle (data: any, sectionId: number) {
		this.validateId(sectionId)
		return this.request('POST', `/help_center/sections/${sectionId}/articles.json`, { article: data })
	}

	async updateArticle (id: number, data: any) {
		this.validateId(id)
		return this.request('PUT', `/help_center/articles/${id}.json`, { article: data })
	}

	async deleteArticle (id: number) {
		this.validateId(id)
		return this.request('DELETE', `/help_center/articles/${id}.json`)
	}

	async searchArticles (params?: Record<string, any>) {
		return this.requestWithRetry('GET', '/help_center/articles/search.json', null, params)
	}

	// Categories
	async listCategories (params?: Record<string, any>) {
		return this.request('GET', '/help_center/categories.json', null, params)
	}

	async getCategory (id: number) {
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
	async listSections (params?: Record<string, any>) {
		return this.request('GET', '/help_center/sections.json', null, params)
	}

	async getSection (id: number) {
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

	async listSectionsByCategory (categoryId: number, params?: Record<string, any>) {
		this.validateId(categoryId)
		return this.request('GET', `/help_center/categories/${categoryId}/sections.json`, null, params)
	}

	async listArticlesBySection (sectionId: number, params?: Record<string, any>) {
		this.validateId(sectionId)
		return this.request('GET', `/help_center/sections/${sectionId}/articles.json`, null, params)
	}

	// === TALK API ===
	async getTalkStats () {
		return this.request('GET', '/channels/voice/stats.json')
	}

	// === CHAT API ===
	async listChats (params?: Record<string, any>) {
		return this.request('GET', '/chats.json', null, params)
	}
}