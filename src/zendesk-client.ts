import type {
	ArticleCreatePayload,
	ArticleTranslationUpdatePayload,
	ArticleUpdatePayload,
	AutomationCreatePayload,
	AutomationUpdatePayload,
	GroupCreatePayload,
	GroupUpdatePayload,
	MacroCreatePayload,
	MacroUpdatePayload,
	OrganizationCreatePayload,
	OrganizationUpdatePayload,
	TicketCreatePayload,
	TicketUpdatePayload,
	TriggerCreatePayload,
	TriggerUpdatePayload,
	UserCreatePayload,
	UserUpdatePayload,
	ViewCreatePayload,
	ViewUpdatePayload,
} from './types/zendesk'
import { HttpClient } from './utils/http-client'

/**
 * The transport's error under the name this client has always thrown. A re-export rather
 * than a subclass, so `instanceof` agrees wherever the error is caught — the class sets its
 * own `name` to HttpRequestError now, which only changes what a stack trace leads with.
 */
export { HttpRequestError as ZendeskRequestError } from './utils/http-client'

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

/** The subdomain reaches a hostname, so anything outside `[a-zA-Z0-9-_]` is dropped. */
const sanitizeSubdomain = (subdomain: string): string => {
	const sanitized = subdomain.replace(/[^a-zA-Z0-9-_]/g, '')
	if (sanitized !== subdomain) {
		console.warn(`Subdomain was sanitized from "${subdomain}" to "${sanitized}"`)
	}
	return sanitized
}

export class ZendeskClient {
	private readonly http: HttpClient

	constructor(config?: ZendeskClientConfig, env?: ZendeskEnv) {
		const subdomain = sanitizeSubdomain(config?.subdomain || env?.ZENDESK_SUBDOMAIN || '')
		const email = config?.email || env?.ZENDESK_EMAIL || ''
		const apiToken = config?.apiToken || env?.ZENDESK_API_TOKEN || ''

		// Nothing warns about a missing credential here. The `authHeader` closure throws on one
		// before anything is sent, and that throw reaches the caller where a log line never
		// does — thrown there rather than checked per call site because `HttpClient.request`
		// calls it outside its try, which is what keeps a missing credential a plain,
		// never-retried error. A warning at construction would also fire on every tool call,
		// since #40 made the server stateless and a fresh client is built per request.
		this.http = new HttpClient({
			baseUrl: `https://${subdomain}.zendesk.com/api/v2`,
			authHeader: () => {
				if (!subdomain || !email || !apiToken) {
					throw new Error('Zendesk credentials not configured. Please set environment variables.')
				}
				return `Basic ${btoa(`${email}/token:${apiToken}`)}`
			},
			label: 'Zendesk',
			redirectHint: 'If the Zendesk subdomain has moved, update ZENDESK_SUBDOMAIN.',
		})
	}

	// There is no endpoint sanitizer here, and its absence is a decision rather than a gap.
	//
	// Nothing could reach one. Every endpoint in this file is either a fixed literal like
	// `/tickets.json` or a template holding an id that `validateId` has already proved to be a
	// positive integer, and no tool handler passes an endpoint at all. Do not add one back on
	// the strength of the 0.1.0 changelog listing the old one under "Security": that listing is
	// the part that did real damage, because a control nobody can reach still costs every reader
	// of this request path the time it takes to work out that it defends nothing.
	//
	// What would change that is an endpoint whose shape a caller decides — a tool taking a path
	// fragment, or a method interpolating a string where an id goes today. The answer then is
	// to keep the caller's value out of the path, by validating it into something known or
	// sending it as a query parameter, rather than to reinstate a filter that has to guess what
	// will be tried against it.
	//
	// The place a model-supplied string does become syntax is elsewhere, and is still open:
	// every `search_*` tool concatenates free text into a Zendesk search expression —
	// `type:ticket ${query}` in src/tools/tickets.ts, and the same pattern in users.ts,
	// organizations.ts and help-center.ts — so a query of `foo type:user` changes what is being
	// searched. That is left alone knowingly, because it crosses no privilege boundary: one
	// shared service account, reads only. It is named here because it is where to look if you
	// arrived expecting the sanitizers to be the protection.

	private validateId(id: number): number {
		if (!Number.isInteger(id) || id <= 0) {
			throw new Error(`Invalid ID: ${id}. ID must be a positive integer.`)
		}
		return id
	}

	/**
	 * What every method below calls. The verb→policy dispatch and its argument live on
	 * `HttpClient.send`; this stays the single doorway into the transport so that `which
	 * methods retry` in the tests can keep asking one question of every method — did it go
	 * through `send` at all — and so no method can choose its own retry behaviour, which is
	 * the discipline #54 exists to hold.
	 */
	private async send(
		method: string,
		endpoint: string,
		data?: unknown,
		params?: Record<string, unknown>
	): Promise<unknown> {
		return this.http.send(method, endpoint, data, params)
	}

	// === TICKETS API ===
	async listTickets(params?: Record<string, unknown>) {
		return this.send('GET', '/tickets.json', null, params)
	}

	async getTicket(id: number) {
		this.validateId(id)
		return this.send('GET', `/tickets/${id}.json`)
	}

	async createTicket(data: TicketCreatePayload) {
		return this.send('POST', '/tickets.json', { ticket: data })
	}

	async updateTicket(id: number, data: TicketUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/tickets/${id}.json`, { ticket: data })
	}

	async deleteTicket(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/tickets/${id}.json`)
	}

	// === USERS API ===

	/**
	 * The user the configured credentials authenticate as. `support_info` is built on this
	 * because it is the smallest call that exercises the subdomain, the email and the token
	 * together — any of the three being wrong or missing fails here rather than being reported
	 * as healthy. It also answers the question that gets asked when something is misconfigured,
	 * which is not whether a request works but which identity the server is using.
	 */
	async getCurrentUser() {
		return this.send('GET', '/users/me.json')
	}

	async listUsers(params?: Record<string, unknown>) {
		return this.send('GET', '/users.json', null, params)
	}

	async getUser(id: number) {
		this.validateId(id)
		return this.send('GET', `/users/${id}.json`)
	}

	async createUser(data: UserCreatePayload) {
		return this.send('POST', '/users.json', { user: data })
	}

	async updateUser(id: number, data: UserUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/users/${id}.json`, { user: data })
	}

	async deleteUser(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/users/${id}.json`)
	}

	// === ORGANIZATIONS API ===
	async listOrganizations(params?: Record<string, unknown>) {
		return this.send('GET', '/organizations.json', null, params)
	}

	async getOrganization(id: number) {
		this.validateId(id)
		return this.send('GET', `/organizations/${id}.json`)
	}

	async createOrganization(data: OrganizationCreatePayload) {
		return this.send('POST', '/organizations.json', { organization: data })
	}

	async updateOrganization(id: number, data: OrganizationUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/organizations/${id}.json`, { organization: data })
	}

	async deleteOrganization(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/organizations/${id}.json`)
	}

	// === GROUPS API ===
	async listGroups(params?: Record<string, unknown>) {
		return this.send('GET', '/groups.json', null, params)
	}

	async getGroup(id: number) {
		this.validateId(id)
		return this.send('GET', `/groups/${id}.json`)
	}

	async createGroup(data: GroupCreatePayload) {
		return this.send('POST', '/groups.json', { group: data })
	}

	async updateGroup(id: number, data: GroupUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/groups/${id}.json`, { group: data })
	}

	async deleteGroup(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/groups/${id}.json`)
	}

	// === MACROS API ===
	async listMacros(params?: Record<string, unknown>) {
		return this.send('GET', '/macros.json', null, params)
	}

	async getMacro(id: number) {
		this.validateId(id)
		return this.send('GET', `/macros/${id}.json`)
	}

	/**
	 * Every create and update payload on this client is typed like these two: derived from the
	 * tool's own Zod schema in types/zendesk.ts, so what a caller may send is whatever MCP
	 * already validated, and neither shape is written a second time against Zendesk's docs.
	 */
	async createMacro(data: MacroCreatePayload) {
		return this.send('POST', '/macros.json', { macro: data })
	}

	async updateMacro(id: number, data: MacroUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/macros/${id}.json`, { macro: data })
	}

	async deleteMacro(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/macros/${id}.json`)
	}

	// === VIEWS API ===
	async listViews(params?: Record<string, unknown>) {
		return this.send('GET', '/views.json', null, params)
	}

	async getView(id: number) {
		this.validateId(id)
		return this.send('GET', `/views/${id}.json`)
	}

	async createView(data: ViewCreatePayload) {
		return this.send('POST', '/views.json', { view: data })
	}

	async updateView(id: number, data: ViewUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/views/${id}.json`, { view: data })
	}

	async deleteView(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/views/${id}.json`)
	}

	// === TRIGGERS API ===
	async listTriggers(params?: Record<string, unknown>) {
		return this.send('GET', '/triggers.json', null, params)
	}

	async getTrigger(id: number) {
		this.validateId(id)
		return this.send('GET', `/triggers/${id}.json`)
	}

	async createTrigger(data: TriggerCreatePayload) {
		return this.send('POST', '/triggers.json', { trigger: data })
	}

	async updateTrigger(id: number, data: TriggerUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/triggers/${id}.json`, { trigger: data })
	}

	async deleteTrigger(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/triggers/${id}.json`)
	}

	// === AUTOMATIONS API ===
	async listAutomations(params?: Record<string, unknown>) {
		return this.send('GET', '/automations.json', null, params)
	}

	async getAutomation(id: number) {
		this.validateId(id)
		return this.send('GET', `/automations/${id}.json`)
	}

	async createAutomation(data: AutomationCreatePayload) {
		return this.send('POST', '/automations.json', { automation: data })
	}

	async updateAutomation(id: number, data: AutomationUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/automations/${id}.json`, { automation: data })
	}

	async deleteAutomation(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/automations/${id}.json`)
	}

	// === SEARCH API ===
	async search(query: string, params: Record<string, unknown> = {}) {
		return this.send('GET', '/search.json', null, { query, ...params })
	}

	// === HELP CENTER API ===
	async listArticles(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/articles.json', null, params)
	}

	async getArticle(id: number) {
		this.validateId(id)
		return this.send('GET', `/help_center/articles/${id}.json`)
	}

	async createArticle(data: ArticleCreatePayload, sectionId: number) {
		this.validateId(sectionId)
		return this.send('POST', `/help_center/sections/${sectionId}/articles.json`, {
			article: data,
		})
	}

	async updateArticle(id: number, data: ArticleUpdatePayload) {
		this.validateId(id)
		return this.send('PUT', `/help_center/articles/${id}.json`, { article: data })
	}

	// Where an article's content actually changes: the article endpoint above applies metadata
	// only and silently ignores `title` and `body`. This is also the endpoint that publishes,
	// which is why the payload type refuses `draft` — see ArticleTranslationUpdatePayload.
	async updateArticleTranslation(
		id: number,
		locale: string,
		data: ArticleTranslationUpdatePayload
	) {
		this.validateId(id)
		return this.send(
			'PUT',
			`/help_center/articles/${id}/translations/${encodeURIComponent(locale)}.json`,
			{ translation: data }
		)
	}

	async deleteArticle(id: number) {
		this.validateId(id)
		return this.send('DELETE', `/help_center/articles/${id}.json`)
	}

	async searchArticles(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/articles/search.json', null, params)
	}

	// Categories
	async listCategories(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/categories.json', null, params)
	}

	async getCategory(id: number) {
		this.validateId(id)
		return this.send('GET', `/help_center/categories/${id}.json`)
	}

	// Nothing here creates, updates or deletes a category or a section. Six commented-out
	// methods used to say so under a "DISABLED FOR SECURITY" label, which read as though the
	// comment were the control; the ceilings gating registration in src/utils/tool-registry.ts
	// are.

	// Sections
	async listSections(params?: Record<string, unknown>) {
		return this.send('GET', '/help_center/sections.json', null, params)
	}

	async getSection(id: number) {
		this.validateId(id)
		return this.send('GET', `/help_center/sections/${id}.json`)
	}

	async listSectionsByCategory(categoryId: number, params?: Record<string, unknown>) {
		this.validateId(categoryId)
		return this.send('GET', `/help_center/categories/${categoryId}/sections.json`, null, params)
	}

	async listArticlesBySection(sectionId: number, params?: Record<string, unknown>) {
		this.validateId(sectionId)
		return this.send('GET', `/help_center/sections/${sectionId}/articles.json`, null, params)
	}

	// === TALK API ===
	async getTalkStats() {
		return this.send('GET', '/channels/voice/stats.json')
	}

	// === CHAT API ===
	// No query parameters, because Chat reads none of the ones this client knows how to send.
	// It is a separate product API with its own pagination scheme, so the shape it does take
	// has to be established against the live API rather than assumed from the Support ones —
	// #67 carries that. Taking a `params` nothing could usefully fill was the same inert
	// argument the tool was advertising, one layer down.
	async listChats() {
		return this.send('GET', '/chats.json')
	}
}
