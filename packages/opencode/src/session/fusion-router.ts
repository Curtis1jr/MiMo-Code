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
    // Shadow-mode marker: routing is observed only, no model switch yet.
    shadow: z.boolean(),
  }),
)

export const Event = { DecisionSuggested }

/**
 * Compute a routing verdict and publish it on the bus. Returns the verdict so
 * callers can log without a second decide() call. In shadow mode (currently the
 * only mode) the verdict is informational — no model or agent switch happens.
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
  yield* input.bus.publish(DecisionSuggested, {
    sessionID: input.sessionID,
    agentID: input.agentID,
    decision: verdict.decision,
    reason: verdict.reason,
    softScore: verdict.softScore,
    shadow: true,
  })
  return verdict
})

export * as FusionRouter from "./fusion-router"
