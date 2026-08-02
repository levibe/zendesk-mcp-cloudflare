/**
 * `summarizeCurrentUser` decides what leaves the server, so these cover both halves of that: the
 * fields it keeps, and the ones it drops. The dropping is the part with a reason beyond tidiness
 * — Zendesk puts an `authenticity_token` in this response — so it gets a test of its own rather
 * than being implied by the shape of the others.
 */

import { describe, expect, it } from 'vitest'
import { summarizeCurrentUser } from './support-response'

/** Trimmed from a real /users/me.json body, keeping the fields that matter either way. */
const body = {
	user: {
		id: 20262006607,
		url: 'https://example.zendesk.com/api/v2/users/20262006607.json',
		name: 'Support',
		email: 'support@example.com',
		role: 'admin',
		active: true,
		suspended: false,
		authenticity_token: 'do-not-hand-this-out',
		photo: { url: 'https://example.zendesk.com/api/v2/attachments/1.json' },
		signature: 'Sent from a support desk',
	},
}

describe('summarizeCurrentUser', () => {
	it('keeps the fields that say whether the server is configured and as whom', () => {
		expect(summarizeCurrentUser(body)).toEqual({
			account: 'example.zendesk.com',
			user: {
				id: 20262006607,
				name: 'Support',
				email: 'support@example.com',
				role: 'admin',
				active: true,
				suspended: false,
			},
		})
	})

	// The reason this function exists rather than the handler returning the body.
	it('drops the authenticity token and everything else it was not asked for', () => {
		const summary = JSON.stringify(summarizeCurrentUser(body))

		expect(summary).not.toContain('do-not-hand-this-out')
		expect(summary).not.toContain('authenticity_token')
		expect(summary).not.toContain('photo')
		expect(summary).not.toContain('signature')
	})

	it('reads the account off the response, so it names the Zendesk that actually answered', () => {
		const moved = { user: { url: 'https://elsewhere.zendesk.com/api/v2/users/1.json' } }

		expect(summarizeCurrentUser(moved).account).toBe('elsewhere.zendesk.com')
	})

	// Called when things are broken, so a malformed body has to produce an answer rather than
	// throw on the way to reporting a problem.
	it.each([
		['a body that is not an object', 'nonsense'],
		['null', null],
		['a body with no user', { meta: {} }],
		['a user that is not an object', { user: 'nope' }],
	])('describes what it found given %s', (_case, input) => {
		expect(summarizeCurrentUser(input)).toEqual({
			account: null,
			user: { id: null, name: null, email: null, role: null, active: null, suspended: null },
		})
	})

	it.each([
		['a url that will not parse', 'not-a-url'],
		['a url that is not a string', 42],
	])('reports no account given %s', (_case, url) => {
		expect(summarizeCurrentUser({ user: { url } }).account).toBeNull()
	})

	// Zendesk sends null for fields an account has not set, and a null role should read as
	// unknown rather than as the string "null".
	it('reports a field of the wrong type as absent rather than coercing it', () => {
		const odd = { user: { id: '20262006607', name: null, active: 'yes' } }

		expect(summarizeCurrentUser(odd).user).toEqual({
			id: null,
			name: null,
			email: null,
			role: null,
			active: null,
			suspended: null,
		})
	})
})
