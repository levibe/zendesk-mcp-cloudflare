/**
 * Zendesk Talk tools for managing phone system statistics and call data
 */

import type { ToolDefinition } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const talkTools: ToolDefinition[] = [
	createTool('get_talk_stats', 'Get Zendesk Talk statistics', {}, async (client) => {
		return client.getTalkStats()
	}),
]
