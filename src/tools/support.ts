/**
 * Core support functionality tools for fundamental Zendesk Support operations
 */

import type { ZendeskClient } from '../zendesk-client'
import type { ToolDefinition } from '../types/zendesk'
import { createTool } from '../utils/tool-registry'

export const supportTools: ToolDefinition[] = [
	createTool(
		'support_info',
		'Get information about Zendesk Support configuration',
		{},
		async () => {
			return 'Zendesk Support information: This MCP server provides comprehensive access to Zendesk Support APIs including tickets, users, organizations, groups, macros, views, triggers, and automations.'
		}
	)
]