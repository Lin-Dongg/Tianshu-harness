import { parseDocument } from 'yaml'

export type SkillMode = 'auto' | 'manual' | 'off'
export interface SkillMetadata {
  displayName?: string
  shortDescription?: string
  defaultPrompt?: string
  defaultMode: SkillMode
  dependencies: unknown[]
  unsupported: string[]
}

export function parseSkillYaml(raw: string): Record<string, unknown> {
  const document = parseDocument(raw, { uniqueKeys: true })
  if (document.errors.length) throw new Error(document.errors.map(e => e.message).join('; '))
  const value: unknown = document.toJS({ maxAliasCount: 20 })
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Skill metadata must be a YAML mapping')
  return value as Record<string, unknown>
}

export function skillMetadata(frontmatter: Record<string, unknown>, openai?: Record<string, unknown>): SkillMetadata {
  const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const ui = object(openai?.interface)
  const policy = object(openai?.policy)
  const dependencies = object(openai?.dependencies)
  const string = (value: unknown) => typeof value === 'string' ? value : undefined
  return {
    displayName: string(ui.display_name), shortDescription: string(ui.short_description), defaultPrompt: string(ui.default_prompt),
    defaultMode: frontmatter['disable-model-invocation'] === true || policy.allow_implicit_invocation === false ? 'manual' : 'auto',
    dependencies: Array.isArray(dependencies.tools) ? dependencies.tools : [],
    unsupported: ['allowed-tools', 'context', 'agent', 'model', 'hooks', 'user-invocable'].filter(key => frontmatter[key] !== undefined),
  }
}
