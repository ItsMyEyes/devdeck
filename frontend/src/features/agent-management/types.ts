import type { AgentModel, AgentSkill, AgentSummary, MCPServer } from '@/store/types'

export interface AgentSkillInventory {
  agent: AgentSummary
  skills: AgentSkill[]
  error?: Error
}

export interface AgentModelInventory {
  agent: AgentSummary
  models: AgentModel[]
  error?: Error
}

export interface AgentMCPInventory {
  agent: AgentSummary
  servers: MCPServer[]
  error?: Error
}

export interface CatalogSkill extends AgentSkill {
  installations: Map<string, AgentSkill>
}
