import type { InboxRow } from "./inbox.sql"

export function renderInboxRow(row: InboxRow): string {
  if (row.type === "actor_notification") {
    // Pre-rendered notification text — sender produced the full
    // <actor-notification>...</actor-notification> wrapper.
    const content = row.content as { text?: string }
    return content.text ?? "(no notification body)"
  }
  // Default: type === "text" or unknown — wrap as <inbox> element so
  // the LLM can route by sender; the wrapper format mirrors the
  // <actor-notification> convention from the legacy completion.ts.
  const content = row.content as { text?: string }
  const sender = row.sender_session_id
    ? `${row.sender_session_id}:${row.sender_actor_id ?? "?"}`
    : "system"
  const sentAt = new Date(row.created_at).toISOString()
  return `<inbox from="${sender}" sent_at="${sentAt}">\n${content.text ?? "(empty)"}\n</inbox>`
}

export function renderActorNotification(event: {
  actorID: string
  description: string
  status: "completed" | "failed" | "cancelled"
  result?: string
  error?: string
  reportedStatus?: string
  reportedSummary?: string
}): string {
  const header = `Background actor "${event.description}" (actor_id: ${event.actorID})`
  if (event.status === "completed") {
    // event.status is the actor *process lifecycle* — the child ended cleanly.
    // event.reportedStatus is the *task* outcome the child self-reported via a
    // `**Status**: ...` header. These are independent: a process can exit
    // cleanly while the task failed/partial/blocked. Word the top line by the
    // task outcome so we never imply a success the child didn't claim, and drop
    // the misleading "Status: unknown" line when nothing was reported.
    const reported = event.reportedStatus?.toLowerCase()
    const summaryLine = event.reportedSummary ? `\nSummary: ${event.reportedSummary}` : ""
    const resultLine = `\nResult: ${event.result ?? "(no output)"}`
    // success → the only case that keeps the affirmative "completed" verb.
    if (reported === "success") {
      return `<actor-notification>\n${header} completed (success).${summaryLine}${resultLine}\n</actor-notification>`
    }
    // partial/failed/blocked → child ran to the end but the task did not fully
    // succeed. State the outcome; don't say "completed".
    if (reported === "partial" || reported === "failed" || reported === "blocked") {
      return `<actor-notification>\n${header} finished with status: ${reported}.${summaryLine}${resultLine}\n</actor-notification>`
    }
    // No status reported → neutral "finished" (session ended). No status line.
    return `<actor-notification>\n${header} finished.${summaryLine}${resultLine}\n</actor-notification>`
  }
  if (event.status === "failed") {
    return `<actor-notification>\n${header} failed.\nError: ${event.error ?? "unknown"}\n</actor-notification>`
  }
  return `<actor-notification>\n${header} was cancelled.\n</actor-notification>`
}

export type ParsedActorNotification = {
  // Reflects the *task* outcome the child reported, not just the process
  // lifecycle. renderActorNotification's completed branch fans out into
  // success / partial / failed / blocked / finished (no status reported) based
  // on reportedStatus; the failed branch (process failure) also maps to
  // "failed", cancelled → "cancelled".
  //
  // "stalled" is reserved for a future watchdog-emitted notification;
  // renderActorNotification never produces it today. The parse + card styling
  // exist ahead of that producer.
  status: "success" | "partial" | "failed" | "blocked" | "finished" | "cancelled" | "stalled"
  description: string
  summary?: string
}

// Inverse of renderActorNotification: recover the structured fields from the
// pre-rendered <actor-notification> text so the TUI can show a card instead of
// the raw wrapper. Pure + exported so it's unit-testable without the renderer.
// Returns null for any text that isn't an actor notification.
export function parseActorNotification(text: string): ParsedActorNotification | null {
  if (!text.trimStart().startsWith("<actor-notification>")) return null
  // Match the top-line verb + optional reported task status. The completed
  // process branch renders one of:
  //   completed (success)            → task succeeded
  //   finished with status: <s>      → partial / failed / blocked
  //   finished                       → process ended, no task status reported
  // and the other lifecycle branches render: failed / was cancelled / stalled.
  const header = text.match(
    /Background actor "(.*?)" \(actor_id: [^)]*\)\s+(completed \(success\)|finished with status: (?:partial|failed|blocked)|finished|failed|was cancelled|stalled)(?=[.\s]|$)/,
  )
  if (!header) return null
  const description = header[1]
  const verb = header[2]
  const status: ParsedActorNotification["status"] = verb.startsWith("completed")
    ? "success"
    : verb.startsWith("finished with status:")
      ? (verb.slice("finished with status: ".length) as "partial" | "failed" | "blocked")
      : verb === "finished"
        ? "finished"
        : verb === "failed"
          ? "failed"
          : verb === "stalled"
            ? "stalled"
            : "cancelled"
  // Prefer the most human-relevant one-liner: Summary > Result > Error.
  // renderActorNotification always emits the Summary line before the Result
  // line, so restrict the Summary match to the region before the first
  // "Result:" line — otherwise a `Summary:`-prefixed line inside the Result
  // body would be mistaken for the notification's own summary.
  const resultIdx = text.search(/^Result:/m)
  const beforeResult = resultIdx === -1 ? text : text.slice(0, resultIdx)
  const line = (label: string, scope: string) => scope.match(new RegExp(`^${label}:\\s*(.+)$`, "m"))?.[1]?.trim()
  const summary = line("Summary", beforeResult) ?? line("Result", text) ?? line("Error", text)
  return summary ? { status, description, summary } : { status, description }
}
