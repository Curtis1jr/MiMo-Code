import { describe, expect, test } from "bun:test"
import { parseActorNotification, renderActorNotification } from "../../src/inbox/render"

describe("parseActorNotification", () => {
  test("parses a success notification with reported status + summary", () => {
    const text = renderActorNotification({
      actorID: "explore-1",
      description: "Find error recovery",
      status: "completed",
      reportedStatus: "success",
      reportedSummary: "Located 3 recovery sites",
      result: "full body here",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "success",
      description: "Find error recovery",
      summary: "Located 3 recovery sites",
    })
  })

  test("success without a summary falls back to the Result line", () => {
    const text = renderActorNotification({
      actorID: "explore-2",
      description: "Scan repo",
      status: "completed",
      reportedStatus: "success",
      result: "42 files scanned",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "success",
      description: "Scan repo",
      summary: "42 files scanned",
    })
  })

  test("success without a summary does not mistake an embedded Summary: line in the Result body", () => {
    const text = renderActorNotification({
      actorID: "explore-3",
      description: "Draft report",
      status: "completed",
      reportedStatus: "success",
      result: "Here is the outline:\nSummary: this is inside the result body\nmore text",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "success",
      description: "Draft report",
      summary: "Here is the outline:",
    })
  })

  test("a partial task outcome does not imply completion", () => {
    const text = renderActorNotification({
      actorID: "general-4",
      description: "Migrate module",
      status: "completed",
      reportedStatus: "partial",
      reportedSummary: "2 of 3 files migrated",
      result: "details",
    })
    expect(text).toContain("finished with status: partial")
    expect(text).not.toContain("completed")
    expect(parseActorNotification(text)).toEqual({
      status: "partial",
      description: "Migrate module",
      summary: "2 of 3 files migrated",
    })
  })

  test("a self-reported failed task outcome does not say completed", () => {
    const text = renderActorNotification({
      actorID: "general-5",
      description: "Fix flaky test",
      status: "completed",
      reportedStatus: "failed",
      result: "could not reproduce",
    })
    expect(text).toContain("finished with status: failed")
    expect(text).not.toContain("completed")
    expect(parseActorNotification(text)).toEqual({
      status: "failed",
      description: "Fix flaky test",
      summary: "could not reproduce",
    })
  })

  test("a blocked task outcome maps to blocked", () => {
    const text = renderActorNotification({
      actorID: "general-6",
      description: "Deploy service",
      status: "completed",
      reportedStatus: "blocked",
      reportedSummary: "waiting on credentials",
      result: "details",
    })
    expect(text).toContain("finished with status: blocked")
    expect(parseActorNotification(text)).toEqual({
      status: "blocked",
      description: "Deploy service",
      summary: "waiting on credentials",
    })
  })

  test("no reported status → neutral 'finished', no misleading Status line", () => {
    const text = renderActorNotification({
      actorID: "explore-7",
      description: "Investigate crash",
      status: "completed",
      result: "looked around the logger",
    })
    expect(text).toContain(") finished.")
    expect(text).not.toContain("completed")
    expect(text).not.toContain("Status: unknown")
    expect(parseActorNotification(text)).toEqual({
      status: "finished",
      description: "Investigate crash",
      summary: "looked around the logger",
    })
  })

  test("parses a failed (process) notification with the Error line as summary", () => {
    const text = renderActorNotification({
      actorID: "general-9",
      description: "Type checker review",
      status: "failed",
      error: "process exited 1",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "failed",
      description: "Type checker review",
      summary: "process exited 1",
    })
  })

  test("parses a cancelled notification (no summary)", () => {
    const text = renderActorNotification({
      actorID: "peer-3",
      description: "Long running search",
      status: "cancelled",
    })
    expect(parseActorNotification(text)).toEqual({
      status: "cancelled",
      description: "Long running search",
    })
  })

  test("parses a stalled notification (watchdog variant)", () => {
    const text =
      '<actor-notification>\nBackground actor "Wedged agent" (actor_id: general-7) stalled.\nSummary: no output for 10m\n</actor-notification>'
    expect(parseActorNotification(text)).toEqual({
      status: "stalled",
      description: "Wedged agent",
      summary: "no output for 10m",
    })
  })

  test("returns null for non-notification text", () => {
    expect(parseActorNotification("just a normal user message")).toBeNull()
    expect(parseActorNotification("<inbox from=\"x:y\">hello</inbox>")).toBeNull()
    expect(parseActorNotification("")).toBeNull()
  })

  test("returns null when the wrapper is present but the header is malformed", () => {
    expect(parseActorNotification("<actor-notification>\ngarbage\n</actor-notification>")).toBeNull()
  })
})
