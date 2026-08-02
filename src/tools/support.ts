import type { ToolDefinition } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'
import { summarizeCurrentUser } from '../utils/support-response'

export const supportTools: ToolDefinition[] = [
	/**
	 * This asks Zendesk rather than describing it. The description promises information about the
	 * configuration, which makes it the tool anyone reaches for to check the server is wired up
	 * correctly, and it used to answer with a fixed sentence that stayed true whether or not a
	 * single credential was set. A worker whose subdomain and email had gone missing reported
	 * itself healthy here while every other tool failed — worse than having no such tool at all.
	 *
	 * The name has to stay. `support_info` is named in READ_ONLY_TOOL_NAMES rather than matching
	 * a query prefix, so renaming it withholds the tool from every client.
	 *
	 * This is one of the few tools that does not hand its response straight back. The current-user
	 * body carries an `authenticity_token`, and a tool people run to reassure themselves about
	 * credentials should not be the one that leaks one into a model's context.
	 */
	createTool(
		'support_info',
		'Check the Zendesk connection and report which user the server authenticates as',
		{},
		async (client) => {
			return summarizeCurrentUser(await client.getCurrentUser())
		}
	),
]
