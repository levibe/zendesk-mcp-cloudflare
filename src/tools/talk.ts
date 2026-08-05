import type { ToolDefinition } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const talkTools: ToolDefinition[] = [
	createTool('get_talk_stats', 'read', 'Get Zendesk Talk statistics', {}, async (client) => {
		return client.getTalkStats()
	}),
]
