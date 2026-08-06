import { toolFactory } from '../utils/tool-registry'
import type { ToolDefinition } from '../types/mcp'
import type { ZendeskClient } from '../zendesk-client'

/**
 * The one place this server names its client to the registry. Every tool file imports
 * `createTool` from here rather than binding `toolFactory` itself, so the binding cannot
 * drift between files, and the registry stays generic — see `toolFactory` for why the
 * client type is bound rather than inferred.
 */
export const createTool = toolFactory<ZendeskClient>()

/**
 * What a tool array annotates itself with. The alias is required rather than convenient:
 * the handler's `client` parameter is contravariant, so a bare `ToolDefinition` naming no
 * client could not accept a handler typed against `ZendeskClient`.
 */
export type ZendeskToolDefinition = ToolDefinition<ZendeskClient>
