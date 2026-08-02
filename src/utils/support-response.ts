import type { SupportInfo } from '../types/zendesk'
import { isRecord } from './narrow'

/**
 * The host a Zendesk resource URL points at, or null if there isn't a usable one.
 *
 * Reading this off the response rather than off configuration is the point: it says which
 * Zendesk answered, not which one we meant to ask.
 */
const hostOf = (value: unknown): string | null => {
	if (typeof value !== 'string') {
		return null
	}
	try {
		return new URL(value).host
	} catch {
		return null
	}
}

const stringOr = (value: unknown): string | null => (typeof value === 'string' ? value : null)
const numberOr = (value: unknown): number | null => (typeof value === 'number' ? value : null)
const booleanOr = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)

/**
 * Narrows the current-user response to the handful of fields that answer whether the server is
 * configured and as whom.
 *
 * Returning the raw body instead would be the cheaper choice, and it is the wrong one here for
 * two reasons. Zendesk includes an `authenticity_token` in this response, and a tool whose job
 * is to reassure someone about credentials has no business handing one to whatever called it.
 * And the rest — a photo record, thumbnails, custom role identifiers, notification preferences —
 * is noise in front of the four facts anyone runs this to learn.
 *
 * Nothing is asserted about the shape beyond `isRecord`, so a response missing `user` entirely
 * still produces a well-formed answer full of nulls. That is deliberate: this tool is called
 * when things are broken, and it should describe what it found rather than fail alongside it.
 */
export function summarizeCurrentUser(rawResponse: unknown): SupportInfo {
	const user: Record<string, unknown> =
		isRecord(rawResponse) && isRecord(rawResponse.user) ? rawResponse.user : {}

	return {
		account: hostOf(user.url),
		user: {
			id: numberOr(user.id),
			name: stringOr(user.name),
			email: stringOr(user.email),
			role: stringOr(user.role),
			active: booleanOr(user.active),
			// Reported because a suspended agent authenticates and then fails everything
			// afterwards, which looks like a permissions problem rather than an account one.
			suspended: booleanOr(user.suspended),
		},
	}
}
