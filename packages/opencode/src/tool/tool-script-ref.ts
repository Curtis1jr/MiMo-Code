// Late-bound reference to the tool set executable from inside exec.
//
// exec needs the ToolRegistry def list to dispatch guest RPC calls, but the
// registry itself constructs exec (registry → exec →
// registry would be a module cycle). Mirroring workflowRef (workflow/runtime-ref.ts):
// the registry layer populates this module-local reference on initialisation and
// the tool reads it at call time.
import type { Effect } from "effect"
import type { Tool as AiTool } from "ai"
import type { Agent } from "../agent/agent"
import type { ModelID, ProviderID } from "../provider/schema"
import type { TurnContext } from "../mcp"
import type * as Tool from "./tool"

export const toolScriptRegistry: {
  current:
    | ((input?: { providerID: ProviderID; modelID: ModelID; agent: Agent.Info }) => Effect.Effect<Tool.Def[]>)
    | undefined
} = { current: undefined }

// MCP tools live outside ToolRegistry (SessionPrompt assembles them straight
// from MCP.Service), so exec reaches them through this second ref,
// populated by the SessionPrompt layer. Reusing the ref pattern keeps MCP's
// layer out of the registry graph — providing MCP.defaultLayer to the registry
// would spin up a SECOND set of MCP client connections.
export const toolScriptMcp: {
  current: ((context?: TurnContext) => Effect.Effect<Record<string, AiTool>>) | undefined
} = { current: undefined }

// Agent control-flow tools make no sense inside a script (they steer the
// conversation, not data) — excluded from both the declared API and dispatch.
export const TOOL_SCRIPT_EXCLUDED = new Set([
  "exec",
  "invalid",
  "question",
  "task",
  "actor",
  "skill",
  "plan_enter",
  "plan_exit",
  "cron",
  "session",
  "workflow",
  "change_directory",
])

// Reserved aliases share the target definition and therefore its permission,
// execution, timeout, and truncation behavior.
export const TOOL_SCRIPT_ALIASES = {
  exec_command: "bash",
} as const
