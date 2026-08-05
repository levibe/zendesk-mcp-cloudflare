import { createTool, type ZendeskToolDefinition } from './create-tool'

export const talkTools: ZendeskToolDefinition[] = [
	createTool('get_talk_stats', 'read', 'Get Zendesk Talk statistics', {}, async (client) => {
		return client.getTalkStats()
	}),
]
