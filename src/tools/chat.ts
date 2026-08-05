import { createTool, type ZendeskToolDefinition } from './create-tool'

export const chatTools: ZendeskToolDefinition[] = [
	/**
	 * No pagination arguments, deliberately, and this is the tool to read before adding any.
	 *
	 * It used to spread `paginationSchema`, which offered `page` and `per_page` and forwarded
	 * them to `/chats.json`. Chat is a separate product API that pages by its own parameters and
	 * reads neither, so a model asking for ten got whatever Chat felt like returning and nothing
	 * anywhere said the request had been ignored. Advertising a control we do not have is worse
	 * than advertising none: a caller can work with a tool that takes no arguments, and cannot
	 * work with one whose arguments are silently dropped.
	 *
	 * Offering nothing is the honest state rather than the finished one. #67 has the argument,
	 * and giving Chat a shape built on the parameters it really takes needs someone to confirm
	 * what those are against the live API first — which is why this stops at removing the lie.
	 */
	createTool('list_chats', 'read', 'List Zendesk Chat conversations', {}, async (client) => {
		return client.listChats()
	}),
]
