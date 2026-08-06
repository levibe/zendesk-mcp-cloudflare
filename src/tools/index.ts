/**
 * Defining a tool here does not publish it. Every tool declares its reach level, each group
 * below carries a ceiling in wrangler.jsonc's TOOL_CEILINGS, and registration withholds
 * whatever sits above the ceiling — so most of the create, update and delete tools below are
 * compiled and tested but never offered to a client. `registerTools` in @levibe/mcp-worker's
 * registry applies that policy and holds the level vocabulary.
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
	chatTools,
}

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
	chat: chatTools,
}

export const allTools = Object.values(toolCategories).flat()
