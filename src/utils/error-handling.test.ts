/**
 * Every registered tool is wrapped in `withErrorHandling`, so its shaping of a result — and
 * of a failure — is the shape MCP clients actually see.
 */

import { describe, expect, it, vi } from 'vitest'
import { withErrorHandling } from './error-handling'

const textOf = (response: { content: Array<{ text: string }> }) => response.content[0].text

describe('withErrorHandling', () => {
	it('passes a string result straight through as the text', async () => {
		const handler = withErrorHandling(async () => 'Ticket 42 deleted successfully!')

		expect(await handler()).toEqual({
			content: [{ type: 'text', text: 'Ticket 42 deleted successfully!' }],
		})
	})

	it('pretty-prints anything else as JSON', async () => {
		const handler = withErrorHandling(async () => ({ ticket: { id: 42 } }))

		expect(textOf(await handler())).toBe(JSON.stringify({ ticket: { id: 42 } }, null, 2))
	})

	it('puts the success message above the JSON, separated by a blank line', async () => {
		const handler = withErrorHandling(async () => ({ id: 42 }), 'Ticket created successfully!')

		expect(textOf(await handler())).toBe(
			`Ticket created successfully!\n\n${JSON.stringify({ id: 42 }, null, 2)}`
		)
	})

	// The string branch returns before the success message is ever consulted, so a handler that
	// already words its own answer keeps it rather than getting a second heading. `delete_ticket`
	// is the tool relying on this: it has an empty body to report and names the id instead.
	it('ignores the success message when the result is already a string', async () => {
		const handler = withErrorHandling(async () => 'Already worded', 'Ticket created successfully!')

		expect(textOf(await handler())).toBe('Already worded')
	})

	it('forwards its arguments to the wrapped function', async () => {
		const fn = vi.fn(async (id: number, status: string) => ({ id, status }))
		const handler = withErrorHandling(fn)

		await handler(42, 'solved')

		expect(fn).toHaveBeenCalledWith(42, 'solved')
	})

	it('turns a thrown error into an error response rather than propagating', async () => {
		const handler = withErrorHandling(async () => {
			throw new Error('Zendesk request failed: Zendesk API Error: 404 - RecordNotFound')
		})

		expect(await handler()).toEqual({
			content: [
				{
					type: 'text',
					text: 'Error: Zendesk request failed: Zendesk API Error: 404 - RecordNotFound',
				},
			],
			isError: true,
		})
	})

	it('reports something thrown that was not an Error as an unknown one', async () => {
		const handler = withErrorHandling(async () => {
			throw 'just a string'
		})

		const response = await handler()

		expect(textOf(response)).toBe('Error: Unknown error')
		expect(response.isError).toBe(true)
	})

	// JSON.stringify(undefined) is undefined rather than a string, so this leaves `text`
	// unset on a response typed as always having one. No tool returns undefined today —
	// every write either hands back a record or words its own sentence — but nothing stops one.
	it('leaves the text unset when the wrapped function resolves to undefined', async () => {
		const handler = withErrorHandling(async () => undefined)

		expect(textOf(await handler())).toBeUndefined()
	})

	// What #28 was actually about. A handler that built its own response used to be wrapped a
	// second time here, and this is what the client got: the inner response pretty-printed as
	// text, with the `isError` that said the write failed encoded inside it rather than set on
	// the response. Nothing downstream could tell the failure from a success.
	it('encodes a response handed to it as text, losing the isError on it', async () => {
		const alreadyShaped = {
			content: [{ type: 'text' as const, text: 'Error: 422 - RecordInvalid' }],
			isError: true,
		}
		const handler = withErrorHandling(async () => alreadyShaped)

		const response = await handler()

		expect(response.isError).toBeUndefined()
		expect(textOf(response)).toBe(JSON.stringify(alreadyShaped, null, 2))
	})
})
