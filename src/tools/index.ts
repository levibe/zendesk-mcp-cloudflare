/**
 * Centralized export of all Zendesk MCP tools
 * Provides organized tool categories for easy registration
 */

import { ticketsTools } from './tickets'
import { usersTools } from './users'
import { organizationsTools } from './organizations'
import { groupsTools } from './groups'
import { macrosTools } from './macros'
import { viewsTools } from './views'
import { triggersTools } from './triggers'
import { automationsTools } from './automations'
import { searchTools } from './search'
import { helpCenterTools } from './help-center'
import { supportTools } from './support'
import { talkTools } from './talk'
import { chatTools } from './chat'

// Export individual tool categories
export {
	ticketsTools,
	usersTools,
	organizationsTools,
	groupsTools,
	macrosTools,
	viewsTools,
	triggersTools,
	automationsTools,
	searchTools,
	helpCenterTools,
	supportTools,
	talkTools,
	chatTools
}

// Export organized tool categories for bulk registration
export const toolCategories = {
	tickets: ticketsTools,
	users: usersTools,
	organizations: organizationsTools,
	groups: groupsTools,
	macros: macrosTools,
	views: viewsTools,
	triggers: triggersTools,
	automations: automationsTools,
	search: searchTools,
	helpCenter: helpCenterTools,
	support: supportTools,
	talk: talkTools,
	chat: chatTools
}

// Export all tools as a flat array
export const allTools = Object.values(toolCategories).flat()