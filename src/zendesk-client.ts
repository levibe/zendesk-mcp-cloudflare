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

		// Warn if credentials are missing (but allow instantiation for testing)
		if (!this.subdomain || !this.email || !this.apiToken) {
			console.warn('Zendesk credentials not found. Please set ZENDESK_SUBDOMAIN, ZENDESK_EMAIL, and ZENDESK_API_TOKEN.')
		}
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

			const url = new URL(`${this.getBaseUrl()}${endpoint}`)

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

			const requestInit: RequestInit = {
				method,
				headers,
			}

			// Only include body for non-GET requests
			if (method !== 'GET' && data !== null && data !== undefined) {
				requestInit.body = JSON.stringify(data)
			}

			const response = await fetch(url.toString(), requestInit)

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
		} catch (error) {
			// Re-throw with more context
			if (error instanceof Error) {
				throw new Error(`Zendesk request failed: ${error.message}`)
			}
			throw error
		}
	}

	// === TICKETS API ===
	async listTickets (params?: Record<string, any>) {
		return this.request('GET', '/tickets.json', null, params)
	}

	async getTicket (id: number) {
		return this.request('GET', `/tickets/${id}.json`)
	}

	async createTicket (data: any) {
		return this.request('POST', '/tickets.json', { ticket: data })
	}

	async updateTicket (id: number, data: any) {
		return this.request('PUT', `/tickets/${id}.json`, { ticket: data })
	}

	async deleteTicket (id: number) {
		return this.request('DELETE', `/tickets/${id}.json`)
	}

	// === USERS API ===
	async listUsers (params?: Record<string, any>) {
		return this.request('GET', '/users.json', null, params)
	}

	async getUser (id: number) {
		return this.request('GET', `/users/${id}.json`)
	}

	async createUser (data: any) {
		return this.request('POST', '/users.json', { user: data })
	}

	async updateUser (id: number, data: any) {
		return this.request('PUT', `/users/${id}.json`, { user: data })
	}

	async deleteUser (id: number) {
		return this.request('DELETE', `/users/${id}.json`)
	}

	// === ORGANIZATIONS API ===
	async listOrganizations (params?: Record<string, any>) {
		return this.request('GET', '/organizations.json', null, params)
	}

	async getOrganization (id: number) {
		return this.request('GET', `/organizations/${id}.json`)
	}

	async createOrganization (data: any) {
		return this.request('POST', '/organizations.json', { organization: data })
	}

	async updateOrganization (id: number, data: any) {
		return this.request('PUT', `/organizations/${id}.json`, { organization: data })
	}

	async deleteOrganization (id: number) {
		return this.request('DELETE', `/organizations/${id}.json`)
	}

	// === GROUPS API ===
	async listGroups (params?: Record<string, any>) {
		return this.request('GET', '/groups.json', null, params)
	}

	async getGroup (id: number) {
		return this.request('GET', `/groups/${id}.json`)
	}

	async createGroup (data: any) {
		return this.request('POST', '/groups.json', { group: data })
	}

	async updateGroup (id: number, data: any) {
		return this.request('PUT', `/groups/${id}.json`, { group: data })
	}

	async deleteGroup (id: number) {
		return this.request('DELETE', `/groups/${id}.json`)
	}

	// === MACROS API ===
	async listMacros (params?: Record<string, any>) {
		return this.request('GET', '/macros.json', null, params)
	}

	async getMacro (id: number) {
		return this.request('GET', `/macros/${id}.json`)
	}

	async createMacro (data: any) {
		return this.request('POST', '/macros.json', { macro: data })
	}

	async updateMacro (id: number, data: any) {
		return this.request('PUT', `/macros/${id}.json`, { macro: data })
	}

	async deleteMacro (id: number) {
		return this.request('DELETE', `/macros/${id}.json`)
	}

	// === VIEWS API ===
	async listViews (params?: Record<string, any>) {
		return this.request('GET', '/views.json', null, params)
	}

	async getView (id: number) {
		return this.request('GET', `/views/${id}.json`)
	}

	async createView (data: any) {
		return this.request('POST', '/views.json', { view: data })
	}

	async updateView (id: number, data: any) {
		return this.request('PUT', `/views/${id}.json`, { view: data })
	}

	async deleteView (id: number) {
		return this.request('DELETE', `/views/${id}.json`)
	}

	// === TRIGGERS API ===
	async listTriggers (params?: Record<string, any>) {
		return this.request('GET', '/triggers.json', null, params)
	}

	async getTrigger (id: number) {
		return this.request('GET', `/triggers/${id}.json`)
	}

	async createTrigger (data: any) {
		return this.request('POST', '/triggers.json', { trigger: data })
	}

	async updateTrigger (id: number, data: any) {
		return this.request('PUT', `/triggers/${id}.json`, { trigger: data })
	}

	async deleteTrigger (id: number) {
		return this.request('DELETE', `/triggers/${id}.json`)
	}

	// === AUTOMATIONS API ===
	async listAutomations (params?: Record<string, any>) {
		return this.request('GET', '/automations.json', null, params)
	}

	async getAutomation (id: number) {
		return this.request('GET', `/automations/${id}.json`)
	}

	async createAutomation (data: any) {
		return this.request('POST', '/automations.json', { automation: data })
	}

	async updateAutomation (id: number, data: any) {
		return this.request('PUT', `/automations/${id}.json`, { automation: data })
	}

	async deleteAutomation (id: number) {
		return this.request('DELETE', `/automations/${id}.json`)
	}

	// === SEARCH API ===
	async search (query: string, params: Record<string, any> = {}) {
		return this.request('GET', '/search.json', null, { query, ...params })
	}

	// === HELP CENTER API ===
	async listArticles (params?: Record<string, any>) {
		return this.request('GET', '/help_center/articles.json', null, params)
	}

	async getArticle (id: number) {
		return this.request('GET', `/help_center/articles/${id}.json`)
	}

	async createArticle (data: any, sectionId: number) {
		return this.request('POST', `/help_center/sections/${sectionId}/articles.json`, { article: data })
	}

	async updateArticle (id: number, data: any) {
		return this.request('PUT', `/help_center/articles/${id}.json`, { article: data })
	}

	async deleteArticle (id: number) {
		return this.request('DELETE', `/help_center/articles/${id}.json`)
	}

	async searchArticles (params?: Record<string, any>) {
		return this.request('GET', '/help_center/articles/search.json', null, params)
	}

	// Categories
	async listCategories (params?: Record<string, any>) {
		return this.request('GET', '/help_center/categories.json', null, params)
	}

	async getCategory (id: number) {
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
		return this.request('GET', `/help_center/categories/${categoryId}/sections.json`, null, params)
	}

	async listArticlesBySection (sectionId: number, params?: Record<string, any>) {
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