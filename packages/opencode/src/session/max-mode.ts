import { Cause, Effect } from "effect"
import * as Stream from "effect/Stream"
import type { ModelMessage, Tool as AITool } from "ai"
import { LLM } from "./llm"
import { SessionProcessor } from "./processor"
import * as Session from "./session"
import type { Provider } from "@/provider"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import {
  createTextNgramMonitor,
  isTextNgramRepeat,
  textNgramRepeat,
} from "./prompt/text-ngram-detection"
import type { Permission } from "@/permission"
import { Log } from "@/util"

const log = Log.create({ service: "session.max-mode" })

export const DEFAULT_CANDIDATES = 5

/** Name of the built-in max-mode primary agent. */
export const MAX_MODE_AGENT = "max"

/** One candidate's collected output from a propose-only stream. */
export type Candidate = {
  index: number
  reasoning: string
  reasoningMetadata?: Record<string, any>
  text: string
  textMetadata?: Record<string, any>
  toolCalls: SessionProcessor.ProposedToolCall[]
  finishReason: string
  usage?: any
  providerMetadata?: Record<string, any>
}

/**
 * Shared inputs for a max-mode step. These mirror exactly what the runLoop has
 * in scope at the main `handle.process` call site, so the orchestrator can be
 * dropped in with no extra plumbing.
 */
export type MaxStepInput = {
  handle: SessionProcessor.Handle
  llm: LLM.Interface
  user: MessageV2.User
  agent: Agent.Info
  model: Provider.Model
  sessionID: string
  parentSessionID?: string
  permission?: Permission.Ruleset
  /** Custom system additions (same array passed to handle.process). */
  system: string[]
  /** Prebuilt system array (verbatim) — same as handle.process. */
  prebuiltSystem?: string[]
  /** Model messages for this step. */
  messages: ModelMessage[]
  /** Execute-bearing tools from resolveTools — used to run the winner. */
  tools: Record<string, AITool>
  agentID?: string
  /**
   * Tool-choice from the per-step args. Accepted (so the same processArgs object
   * can be spread in) but unused: candidates always run propose-only and the
   * json_schema path never takes the max-mode branch.
   */
  toolChoice?: "auto" | "required" | "none"
  /** Number of parallel candidates (default 5). */
  candidates?: number
  /**
   * Optional per-candidate model dispatch. When non-empty, candidate i uses
   * models[i % models.length] instead of `model`. Used by MoA-style max mode
   * where different reasoners produce a more diverse candidate pool. When
   * omitted or empty, all candidates share `model` (legacy behaviour).
   */
  models?: Provider.Model[]
  /**
   * Selection strategy. "pick" (default, legacy) asks the judge for a single
   * winning index. "aggregate" uses a fusion-lead aggregator that returns
   * `{picked_index, revisions}` and appends the revisions to the winner's
   * message before replay, so the next step's model sees them. Both modes
   * still replay exactly ONE candidate through the processor — the aggregate
   * branch does NOT execute multiple candidates.
   */
  mode?: "pick" | "aggregate"
  /**
   * Optional hook to surface progress to the UI during the (otherwise
   * invisible) candidate + judge phases. Called with a short English label,
   * or undefined to clear back to a plain busy state.
   */
  setStatus?: (message: string | undefined) => Effect.Effect<void>
}

/**
 * Strip the `execute` closure from each tool, yielding "schema-only" tools.
 * The AI SDK stops the step and emits a `tool-call` event (without executing)
 * when an invoked tool has no `execute` — exactly the propose-only behaviour
 * candidates need.
 */
export function toSchemaOnlyTools(tools: Record<string, AITool>): Record<string, AITool> {
  const out: Record<string, AITool> = {}
  for (const [key, t] of Object.entries(tools)) {
    const { execute: _execute, ...rest } = t as any
    out[key] = rest as AITool
  }
  return out
}

/**
 * Run a single propose-only candidate stream, collecting reasoning + text +
 * proposed tool calls without executing anything. Returns null on failure so a
 * single bad draw doesn't sink the whole step.
 *
 * Transient network failures (ECONNRESET / EPIPE / SSE timeout / 5xx) are
 * retried with the same persistent schedule the normal stream path uses. This
 * is safe — and deliberately broader than the normal path — because a
 * candidate emits NOTHING externally until it completes: each attempt rebuilds
 * a fresh accumulator, so re-streaming after a mid-stream reset cannot
 * duplicate user-visible output the way the live processor stream would. A
 * mid-stream ECONNRESET that the normal path can't retry (it only wraps
 * connection setup) is fully recoverable here.
 */
// Exported for integration tests (drives the real candidate path with a mock
// llm.stream). Not part of the public surface — call sites use runMaxStep.
export const runCandidate = (
  input: MaxStepInput,
  index: number,
  modelOverride?: Provider.Model,
): Effect.Effect<Candidate | null | "text-repeat"> =>
  Effect.gen(function* () {
    const monitor = createTextNgramMonitor()
    // Fresh accumulator per attempt: the retry below re-runs this whole block,
    // so partial reasoning/text/toolCalls from a failed attempt must not carry
    // over into the retry.
    const candidate: Candidate = {
      index,
      reasoning: "",
      text: "",
      toolCalls: [],
      finishReason: "stop",
    }

    const schemaOnly = toSchemaOnlyTools(input.tools)
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: modelOverride ?? input.model,
      agent: input.agent,
      permission: input.permission,
      system: input.system,
      prebuiltSystem: input.prebuiltSystem,
      messages: input.messages,
      tools: schemaOnly,
      agentID: input.agentID,
    })

    yield* Stream.runForEach(stream, (event: LLM.Event) => {
      switch (event.type) {
        case "reasoning-delta":
          candidate.reasoning += event.text
          if (monitor.append(event.text)) return Effect.fail(textNgramRepeat())
          if (event.providerMetadata) candidate.reasoningMetadata = event.providerMetadata
          break
        case "text-delta":
          candidate.text += event.text
          if (monitor.append(event.text)) return Effect.fail(textNgramRepeat())
          if (event.providerMetadata) candidate.textMetadata = event.providerMetadata
          break
        case "tool-call":
          candidate.toolCalls.push({
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            input: (event.input as Record<string, any>) ?? {},
            providerMetadata: event.providerMetadata,
          })
          break
        case "finish-step":
          candidate.finishReason = event.finishReason ?? candidate.finishReason
          candidate.usage = event.usage
          candidate.providerMetadata = event.providerMetadata
          break
        // The AI SDK surfaces a transient stream failure (ECONNRESET etc.) as
        // an `error` PART that ends the stream normally — it does NOT throw, and
        // the normal processor path only converts this via its own catchCause.
        // Emit it into the Effect error channel (NOT a thrown defect, which the
        // retry's `while` predicate would skip) so Effect.retry below can fire;
        // otherwise the error is silently swallowed and the candidate ends
        // half-streamed.
        case "error":
          return Effect.fail(event.error)
        default:
          break
      }
      return Effect.void
    })

    return candidate
  }).pipe(
    // Mirror the proven build/plan path (processor.ts): convert any DEFECT into
    // a typed failure before retrying. The SSE-timeout / aborted-fetch errors
    // raised deep in the provider stream surface as defects (Cause.die), which
    // Effect.retry's `while` and Effect.catch both skip — so without this they
    // escape the fiber as an unhandled rejection and kill the whole session.
    // Interrupts (genuine user cancel) are left to propagate.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    Effect.retry({
      while: LLM.isTransientCapacityError,
      schedule: LLM.persistentRetrySchedule,
    }),
    Effect.catchIf(isTextNgramRepeat, () => Effect.succeed("text-repeat" as const)),
    Effect.catch((e) =>
      Effect.sync(() => {
        log.warn("candidate failed", { index, error: e instanceof Error ? e.message : String(e) })
        return null
      }),
    ),
  )

/** Render a candidate compactly for the judge. `label` is its judge-facing index. */
function renderCandidate(c: Candidate, label: number): string {
  const tools =
    c.toolCalls.length === 0
      ? "(no tool calls — final answer / text only)"
      : c.toolCalls
          .map((t) => `  - ${t.toolName}(${JSON.stringify(t.input)})`)
          .join("\n")
  const reasoning = c.reasoning.trim() ? c.reasoning.trim() : "(no reasoning emitted)"
  const text = c.text.trim() ? c.text.trim() : "(no text emitted)"
  return [
    `### Candidate ${label}`,
    `Reasoning:\n${reasoning}`,
    `Message:\n${text}`,
    `Proposed tool calls:\n${tools}`,
  ].join("\n")
}

const JUDGE_SYSTEM = [
  "You are a judge selecting the single best next step for a coding agent.",
  "You will see several independent candidate drafts for the SAME step. Each candidate contains its reasoning, its message text, and the tool calls it proposes to make next.",
  "Pick the ONE candidate that has the most correct, grounded, and useful next step. Prefer candidates whose reasoning is sound and whose proposed tool calls are appropriate and safe.",
  "Respond with ONLY the integer index of the winning candidate (e.g. `2`). No other text.",
].join("\n")

/**
 * Parse the judge's free-text reply into a valid candidate index. Returns 0
 * (first survivor) when the reply has no integer or is out of range — so a
 * flaky judge never blocks the step.
 */
export function parseJudgeIndex(out: string, count: number): number {
  const match = out.match(/\d+/)
  if (!match) return 0
  const picked = parseInt(match[0], 10)
  if (Number.isNaN(picked) || picked < 0 || picked >= count) return 0
  return picked
}

/**
 * Ask the model to pick the best candidate. Returns the winner's index in the
 * `candidates` array (NOT the candidate.index field) plus the judge call's own
 * token usage. Falls back to index 0 on any parse/out-of-range issue.
 */
/** Exported for integration tests; call sites go through runMaxStep. */
export const judge = (input: MaxStepInput, candidates: Candidate[]): Effect.Effect<{ pick: number; usage?: any }> =>
  Effect.gen(function* () {
    if (candidates.length === 1) return { pick: 0, usage: undefined }

    const rendered = candidates.map((c, i) => renderCandidate(c, i)).join("\n\n")
    const judgePrompt = [
      `There are ${candidates.length} candidates, indexed 0..${candidates.length - 1}.`,
      "",
      rendered,
      "",
      `Reply with ONLY the integer index (0..${candidates.length - 1}) of the best candidate.`,
    ].join("\n")

    const messages: ModelMessage[] = [{ role: "user", content: judgePrompt }]

    let out = ""
    let usage: any | undefined
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: [JUDGE_SYSTEM],
      messages,
      tools: {},
      toolChoice: "none",
      agentID: input.agentID,
    })

    yield* Stream.runForEach(stream, (event: LLM.Event) => {
      if (event.type === "text-delta") out += event.text
      else if (event.type === "finish-step") usage = event.usage
      // Same as runCandidate: a transient failure arrives as an `error` part,
      // not a thrown error. Surface it into the error channel so Effect.retry
      // below can fire instead of silently picking candidate 0.
      else if (event.type === "error") return Effect.fail(event.error)
      return Effect.void
    })

    return { pick: parseJudgeIndex(out, candidates.length), usage }
  }).pipe(
    // Convert defects (SSE timeout / aborted fetch surfacing as Cause.die) into
    // typed failures before retrying — same as runCandidate and the proven
    // processor path. Otherwise the defect escapes and kills the session
    // instead of degrading to pick 0.
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    // Same transient-retry rationale as runCandidate: the judge accumulates
    // `out`/`usage` locally and emits nothing externally until it returns, so
    // re-streaming after a mid-stream reset is safe. Without this, a single
    // ECONNRESET during judging silently collapses the whole step to pick 0.
    Effect.retry({
      while: LLM.isTransientCapacityError,
      schedule: LLM.persistentRetrySchedule,
    }),
    Effect.catch((e) => {
      log.warn("judge failed, defaulting to candidate 0", {
        error: e instanceof Error ? e.message : String(e),
      })
      return Effect.succeed({ pick: 0, usage: undefined })
    }),
  )

const AGGREGATOR_SYSTEM = [
  "You are an aggregator (mixture-of-agents lead) selecting the best next step for a coding agent.",
  "You will see several independent candidate drafts for the SAME step. Each candidate contains its reasoning, its message text, and the tool calls it proposes.",
  "Your job:",
  "1. Pick ONE candidate (`picked_index`) whose plan is the most correct, grounded, and safe.",
  "2. Optionally emit `revisions` — a short list of concrete, targeted improvements the picked candidate MUST apply on top of its own draft. Keep each revision to one sentence, imperative, and directly grounded in what the OTHER candidates got right that the picked one missed.",
  "Do NOT rewrite the candidate. Do NOT emit stylistic nits. Only emit revisions when they materially improve correctness or safety of the next step.",
  "Return STRICT JSON: {\"picked_index\": number, \"revisions\": string[]}. No commentary outside JSON.",
].join("\n")

/**
 * Parse the aggregator's JSON reply. Falls back to {pick:0, revisions:[]} on
 * any parse/type/range issue — a flaky aggregator must never block the step.
 * The parser tolerates extra prose around the JSON block (some models still
 * add trailing commentary), so it scans for the first {...} JSON object.
 */
export function parseAggregatorReply(
  out: string,
  count: number,
): { pick: number; revisions: string[] } {
  const jsonMatch = out.match(/\{[\s\S]*\}/)
  if (!jsonMatch) return { pick: 0, revisions: [] }
  const parsed = (() => {
    try {
      return JSON.parse(jsonMatch[0])
    } catch {
      return null
    }
  })()
  if (!parsed || typeof parsed !== "object") return { pick: 0, revisions: [] }
  const raw = (parsed as Record<string, unknown>).picked_index
  const picked = typeof raw === "number" ? raw : typeof raw === "string" ? parseInt(raw, 10) : NaN
  const pick = Number.isInteger(picked) && picked >= 0 && picked < count ? picked : 0
  const revsRaw = (parsed as Record<string, unknown>).revisions
  const revisions = Array.isArray(revsRaw)
    ? revsRaw.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim())
    : []
  return { pick, revisions }
}

/**
 * Ask a fusion-lead aggregator to merge candidate plans, pick a winner, and
 * emit revisions. Same retry / defect-conversion posture as `judge`.
 */
export const aggregate = (
  input: MaxStepInput,
  candidates: Candidate[],
): Effect.Effect<{ pick: number; revisions: string[]; usage?: any }> =>
  Effect.gen(function* () {
    if (candidates.length === 1) return { pick: 0, revisions: [], usage: undefined }

    const rendered = candidates.map((c, i) => renderCandidate(c, i)).join("\n\n")
    const aggregatorPrompt = [
      `There are ${candidates.length} candidates, indexed 0..${candidates.length - 1}.`,
      "",
      rendered,
      "",
      "Return STRICT JSON matching {picked_index: number, revisions: string[]}.",
    ].join("\n")

    const messages: ModelMessage[] = [{ role: "user", content: aggregatorPrompt }]

    let out = ""
    let usage: any | undefined
    const stream = input.llm.stream({
      user: input.user,
      sessionID: input.sessionID,
      parentSessionID: input.parentSessionID,
      model: input.model,
      agent: input.agent,
      permission: input.permission,
      system: [AGGREGATOR_SYSTEM],
      messages,
      tools: {},
      toolChoice: "none",
      agentID: input.agentID,
    })

    yield* Stream.runForEach(stream, (event: LLM.Event) => {
      if (event.type === "text-delta") out += event.text
      else if (event.type === "finish-step") usage = event.usage
      else if (event.type === "error") return Effect.fail(event.error)
      return Effect.void
    })

    const parsed = parseAggregatorReply(out, candidates.length)
    return { ...parsed, usage }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.fail(Cause.squash(cause)),
    ),
    Effect.retry({
      while: LLM.isTransientCapacityError,
      schedule: LLM.persistentRetrySchedule,
    }),
    Effect.catch((e) => {
      log.warn("aggregator failed, defaulting to candidate 0 with no revisions", {
        error: e instanceof Error ? e.message : String(e),
      })
      return Effect.succeed({ pick: 0, revisions: [], usage: undefined })
    }),
  )

/**
 * Render aggregator revisions as a distinctive block appended to the winner's
 * text. Kept as its own function so max-mode.ts stays the single source of
 * truth for the format — downstream logs / history views can match on the
 * `_AGGREGATOR_REVISIONS_MARKER` sentinel to strip or highlight it.
 */
export const _AGGREGATOR_REVISIONS_MARKER = "\n\n---\n**Aggregator revisions (apply on the next step):**\n"
function appendRevisions(text: string, revisions: string[]): string {
  if (revisions.length === 0) return text
  return text + _AGGREGATOR_REVISIONS_MARKER + revisions.map((r) => `- ${r}`).join("\n")
  }

/**
 * Run one max-mode step: N parallel propose-only candidates → judge picks the
 * winner → replay (execute) the winner through the processor. Returns the same
 * Result contract as `handle.process`.
 *
 * Degradation: if every candidate fails (0 survivors), falls back to a normal
 * single `handle.process` call so the step still makes progress.
 */
export const runMaxStep = (input: MaxStepInput): Effect.Effect<SessionProcessor.Result> =>
  Effect.gen(function* () {
    const n = Math.max(1, input.candidates ?? DEFAULT_CANDIDATES)
    const setStatus = (message: string | undefined) =>
      input.setStatus ? input.setStatus(message) : Effect.void

    // Total wall-clock of the whole ensemble phase (N parallel candidates +
    // judge), measured from just before the candidates start until just before
    // replay. Shown as the winner's thinking duration.
    const ensembleStartedAt = Date.now()

    const modelList = input.models && input.models.length > 0 ? input.models : undefined
    const modelForIndex = (i: number): Provider.Model | undefined =>
      modelList ? modelList[i % modelList.length] : undefined

    yield* setStatus(`thinking — ${n} candidates`)
    const results = yield* Effect.all(
      Array.from({ length: n }, (_, i) => runCandidate(input, i, modelForIndex(i))),
      { concurrency: n },
    )
    if (results.some((result) => result === "text-repeat")) return "text-repeat"
    const survivors = results.filter((c): c is Candidate => c !== null && c !== "text-repeat")

    if (survivors.length === 0) {
      log.warn("all candidates failed, falling back to single process")
      yield* setStatus(undefined)
      return yield* input.handle.process({
        user: input.user,
        agent: input.agent,
        permission: input.permission,
        sessionID: input.sessionID,
        parentSessionID: input.parentSessionID,
        system: input.system,
        prebuiltSystem: input.prebuiltSystem,
        messages: input.messages,
        tools: input.tools,
        model: input.model,
        agentID: input.agentID,
      })
    }

    const mode = input.mode ?? "pick"
    yield* setStatus(
      mode === "aggregate" ? `aggregating ${survivors.length} candidates` : `judging ${survivors.length} candidates`,
    )
    const selection =
      mode === "aggregate"
        ? yield* aggregate(input, survivors)
        : yield* judge(input, survivors).pipe(Effect.map((r) => ({ pick: r.pick, revisions: [] as string[], usage: r.usage })))
    const winner = survivors[selection.pick]
    log.info("max step", {
      candidates: n,
      survivors: survivors.length,
      winner: selection.pick,
      toolCalls: winner.toolCalls.length,
      mode,
      revisions: selection.revisions.length,
    })

    // The winner's own usage is what actually enters history, so it (and only
    // it) must drive the message's `tokens` — that field feeds the context
    // overflow / prune / compaction estimators. Feeding the aggregate there
    // would make max mode believe context is ~Nx fuller than it is and trigger
    // premature compaction.
    //
    // The losing candidates + the judge are real spend but consume NO context.
    // We surface them as `overhead`: extra cost + extra in/out token counts the
    // processor adds to `cost` and the ModelCall metric only — never to
    // `tokens`. So billing/metrics reflect the true ~Nx spend while context
    // estimation stays honest.
    const overheadUsages = [...survivors.filter((_, i) => i !== selection.pick).map((c) => c.usage), selection.usage]
    const overhead = overheadUsages.reduce(
      (acc, u) => {
        if (!u) return acc
        const g = Session.getUsage({ model: input.model, usage: u })
        acc.cost += g.cost
        acc.tokensIn += g.tokens.input + g.tokens.cache.read + g.tokens.cache.write
        acc.tokensOut += g.tokens.output + g.tokens.reasoning
        return acc
      },
      { cost: 0, tokensIn: 0, tokensOut: 0 },
    )

    // In aggregate mode, append the aggregator's revisions to the winner's
    // visible text so both the user and the NEXT step's model see them. This is
    // deliberately part of the assistant message (not a separate synthetic
    // user message) — max mode's contract is already "we aggressively engineer
    // this turn's message before it's shown", and threading a new user-role
    // message mid-loop would fight session invariants elsewhere. The
    // `_AGGREGATOR_REVISIONS_MARKER` sentinel lets downstream tools identify
    // and, if needed, strip the block.
    const winnerText = mode === "aggregate" ? appendRevisions(winner.text, selection.revisions) : winner.text

    // Clear the max-mode label before replay so the winner streams under the
    // normal busy state.
    yield* setStatus(undefined)
    return yield* input.handle.replay({
      reasoning: winner.reasoning,
      reasoningMetadata: winner.reasoningMetadata,
      text: winnerText,
      textMetadata: winner.textMetadata,
      toolCalls: winner.toolCalls,
      finishReason: winner.finishReason,
      usage: winner.usage,
      providerMetadata: winner.providerMetadata,
      tools: input.tools as any,
      messages: input.messages,
      selection: { winner: selection.pick, total: survivors.length },
      thinkingMs: Date.now() - ensembleStartedAt,
      overhead,
    })
  })

export * as MaxMode from "./max-mode"
