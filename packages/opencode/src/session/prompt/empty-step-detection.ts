import type { MessageV2 } from "../message-v2"

/**
 * Empty / no-op tool-call detection.
 *
 * Detects two shapes of invalid assistant output:
 *
 *  (a) The step emitted one or more client (non-providerExecuted) tool parts,
 *      but EVERY such tool part has an empty/invalid input — no keys, or only
 *      keys whose values are null/undefined/empty-string/whitespace. The model
 *      "called a tool" but passed nothing actionable.
 *
 *  (b) The step produced NO client tool part at all AND no substantive text and
 *      no substantive reasoning — a fully empty terminal.
 *
 * A step that emits at least one tool part with real input, or any substantive
 * text/reasoning, is NOT empty — the model is making some kind of progress.
 *
 * Provider-executed tool parts (e.g. server-side web search) are ignored for
 * the "has a tool part" test: they are not client actions and their presence
 * does not mean the model issued an actionable call.
 */

/**
 * Is this assistant step an empty / no-op tool call?
 *
 * Two shapes count as empty (mirrors the task's definition):
 *
 *  (a) The step emitted one or more client (non-providerExecuted) tool parts,
 *      but EVERY such tool part has an empty/invalid input — no keys, or only
 *      keys whose values are null/undefined/empty-string/whitespace. The model
 *      "called a tool" but passed nothing actionable, so the call cannot make
 *      progress and re-looping just repeats it.
 *
 *  (b) The step produced NO client tool part at all AND no substantive text and
 *      no substantive reasoning — a fully empty terminal. (This overlaps with
 *      classify's `invalid`/"empty output".)
 *
 * A step that emits at least one tool part with real input, or any substantive
 * text/reasoning, is NOT empty — the model is making some kind of progress.
 *
 * Provider-executed tool parts (e.g. server-side web search) are ignored for
 * the "has a tool part" test: they are not client actions and their presence
 * does not mean the model issued an actionable call.
 */
export function isEmptyStep(parts: readonly MessageV2.Part[]): boolean {
  const clientToolParts = parts.filter(
    (part): part is Extract<MessageV2.Part, { type: "tool" }> =>
      part.type === "tool" && !part.metadata?.providerExecuted,
  )

  if (clientToolParts.length > 0) {
    // (a) Every client tool part has an empty/invalid input.
    return clientToolParts.every((part) => isEmptyInput(part.state.input))
  }

  // (b) No client tool part — empty only if there is also no substantive
  // text and no substantive reasoning (a pure-empty terminal). A step with a
  // real text answer or real reasoning is a legitimate (non-loop) outcome.
  const hasSubstantiveText = parts.some(
    (part) => part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
  )
  if (hasSubstantiveText) return false
  const hasSubstantiveReasoning = parts.some(
    (part) => part.type === "reasoning" && part.text.trim().length > 0,
  )
  if (hasSubstantiveReasoning) return false
  return true
}

/**
 * An input object counts as empty when it has no (non-meta) keys, or every
 * value is null/undefined/empty-string/whitespace-only. Keys prefixed with
 * "_" (harness bookkeeping like _meta) are excluded from the check.
 * Nested objects/arrays with any content count as non-empty (the model
 * passed *something*).
 */
export function isEmptyInput(input: Record<string, unknown> | undefined | null): boolean {
  if (input === undefined || input === null) return true
  // Filter out meta/underscore-prefixed fields — they are harness
  // bookkeeping, not actionable tool arguments.
  const keys = Object.keys(input).filter((k) => !k.startsWith("_"))
  if (keys.length === 0) return true
  return keys.every((k) => isEmptyValue(input[k]))
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === "string") return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as Record<string, unknown>).length === 0
  // number / boolean → the model passed a real value.
  return false
}
