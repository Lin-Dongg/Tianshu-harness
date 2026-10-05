import type { ToolDefinition } from '../api/types.js'
import type { OaiToolDefinition } from '../api/oai-types.js'

export function buildOaiToolDefinitions(tools: readonly ToolDefinition[]): OaiToolDefinition[] | undefined {
  if (!tools.length) return undefined
  return tools.map(tool => ({ type: 'function', function: {
    name: tool.name, description: tool.description,
    parameters: tool.input_schema ?? { type: 'object', properties: {} },
    ...(tool.providerFormat ? { providerFormat: tool.providerFormat } : {}),
  } }))
}
