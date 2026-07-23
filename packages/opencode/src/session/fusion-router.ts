import z from "zod"
import { Effect } from "effect"
import { BusEvent } from "@/bus/bus-event"
import type { Interface as BusInterface } from "@/bus"
import { Flag } from "../flag/flag"
import { SessionID } from "./schema"
import { Log } from "../util"
import type { TryBestReason } from "./try-best-detector"

const log = Log.create({ service: "fusion.router" })

export type Decision = "upgrade" | "downgrade" | "keep"

export type Signals = {
  tryBestFired: boolean
  tryBestReason?: TryBestReason
  consecutiveSidekickFailures: number
  retryCount: number
  pressureLevel: number
  emptyStepStreak: number
  textNgramRepeat: boolean
  easyTurnsSinceUpgrade: number
  currentlyOnLead: boolean
}

export type Reason =
  | "try_best_fired"
  | "sidekick_failure_streak"
  | "retry_streak"
  | "soft_pressure"
  | "cooldown_expired"
  | "keep"

export type Verdict = {
  decision: Decision
  reason: Reason
  softScore?: number
}

export function decide(signals: Signals): Verdict {
  if (signals.tryBestFired) return { decision: "upgrade", reason: "try_best_fired" }
  if (signals.consecutiveSidekickFailures >= 3) return { decision: "upgrade", reason: "sidekick_failure_streak" }
  if (signals.retryCount >= 3) return { decision: "upgrade", reason: "retry_streak" }

  const softScore =
    (signals.pressureLevel >= 2 ? 1 : 0) + (signals.emptyStepStreak >= 2 ? 1 : 0) + (signals.textNgramRepeat ? 1 : 0)
  if (softScore >= 2) return { decision: "upgrade", reason: "soft_pressure", softScore }

  // Preserve Lead during bash_retry Debug scenarios — never downgrade when the last try-best
  // signal was bash_retry, even if the cool-down window has elapsed.
  if (signals.easyTurnsSinceUpgrade >= 5 && signals.currentlyOnLead && signals.tryBestReason !== "bash_retry") {
    return { decision: "downgrade", reason: "cooldown_expired" }
  }

  return { decision: "keep", reason: "keep", softScore }
}

const DecisionEnum = z.enum(["upgrade", "downgrade", "keep"])
const ReasonEnum = z.enum([
  "try_best_fired",
  "sidekick_failure_streak",
  "retry_streak",
  "soft_pressure",
  "cooldown_expired",
  "keep",
])

export const DecisionSuggested = BusEvent.define(
  "fusion.router.decision",
  z.object({
    sessionID: SessionID.zod,
    agentID: z.string().optional(),
    decision: DecisionEnum,
    reason: ReasonEnum,
    softScore: z.number().int().min(0).optional(),
    // Shadow-mode marker: routing observed only, no live model switch happened.
    // False when the verdict was actually consumed by compaction.
    shadow: z.boolean(),
  }),
)

export const ModelSwitched = BusEvent.define(
  "fusion.router.model_switched",
  z.object({
    sessionID: SessionID.zod,
    agentID: z.string().optional(),
    from: z.enum(["lead", "sidekick", "unknown"]),
    to: z.enum(["lead", "sidekick"]),
    reason: ReasonEnum,
    providerID: z.string(),
    modelID: z.string(),
  }),
)

export const Event = { DecisionSuggested, ModelSwitched }

/**
 * In-memory ledger of the most recent non-keep verdict per session, waiting to
 * be consumed at the next compaction boundary. Non-persistent by design — a
 * process restart resets Fusion routing back to sidekick, which is safe.
 */
const latestBySession = new Map<string, Verdict>()

/**
 * Consume (read + clear) the latest verdict pending for `sessionID`. Returns
 * undefined when no non-keep verdict is pending. Compaction is expected to
 * call this at the boundary to decide whether to swap models.
 */
export function consume(sessionID: string): Verdict | undefined {
  const verdict = latestBySession.get(sessionID)
  if (verdict) latestBySession.delete(sessionID)
  return verdict
}

/**
 * Test-only helper: clear all pending verdicts. Not exported through the
 * public FusionRouter namespace facade to keep production callers off it.
 */
export function _reset() {
  latestBySession.clear()
}

/**
 * Compute a routing verdict and publish it on the bus. Non-keep verdicts are
 * stashed so the next compaction boundary can consume them. Returns the verdict
 * so callers can log without a second decide() call.
 *
 * Takes an already-resolved Bus.Interface so callers don't leak Bus.Service
 * into their own Effect requirements.
 */
export const observe = Effect.fn("FusionRouter.observe")(function* (input: {
  bus: BusInterface
  sessionID: SessionID
  agentID?: string
  signals: Signals
}) {
  if (!Flag.MIMOCODE_EXPERIMENTAL_FUSION) return { decision: "keep", reason: "keep" } as Verdict
  const verdict = decide(input.signals)
  log.info("verdict", {
    session: input.sessionID,
    agent: input.agentID,
    decision: verdict.decision,
    reason: verdict.reason,
    softScore: verdict.softScore,
  })
  if (verdict.decision !== "keep") {
    latestBySession.set(input.sessionID, verdict)
  }
  yield* input.bus.publish(DecisionSuggested, {
    sessionID: input.sessionID,
    agentID: input.agentID,
    decision: verdict.decision,
    reason: verdict.reason,
    softScore: verdict.softScore,
    // Still shadow until compaction consumes it. `consume()` doesn't republish;
    // the ModelSwitched event carries the "live" signal instead.
    shadow: true,
  })
  return verdict
})

export * as FusionRouter from "./fusion-router"
