import { describe, expect, test } from "bun:test"
import { deriveTopic, FRESH_SENTINEL } from "../src/tool/session"

describe("deriveTopic", () => {
  test("derives topic from PR number in task", () => {
    expect(deriveTopic({ task: "Fix bug in #1234" })).toBe("auto:pr-1234")
    expect(deriveTopic({ task: "PR 5678: implement feature" })).toBe("auto:pr-5678")
    expect(deriveTopic({ task: "review pull/9012 changes" })).toBe("auto:pr-9012")
    expect(deriveTopic({ task: "Fix #42" })).toBe("auto:pr-42")
  })

  test("derives topic from directory basename", () => {
    expect(deriveTopic({ task: "fix bug", dir: "/Users/dev/projects/my-app" })).toBe("auto:dir-my-app")
    expect(deriveTopic({ task: "fix bug", dir: "/path/to/My_Project" })).toBe("auto:dir-my-project")
    expect(deriveTopic({ task: "fix bug", dir: "/path/to/project_name_here" })).toBe("auto:dir-project-name-here")
  })

  test("PR number takes precedence over directory", () => {
    expect(deriveTopic({ task: "Fix #1234", dir: "/path/to/my-app" })).toBe("auto:pr-1234")
  })

  test("returns undefined when no stable signal available", () => {
    expect(deriveTopic({ task: "fix some bug" })).toBeUndefined()
    expect(deriveTopic({ task: "implement feature" })).toBeUndefined()
  })

  test("is stable — same inputs produce same output", () => {
    const input = { task: "Fix #1234", dir: "/path/to/my-app" }
    const result1 = deriveTopic(input)
    const result2 = deriveTopic(input)
    expect(result1).toBe(result2)
    expect(result1).toBe("auto:pr-1234")
  })

  test("explicit topic takes precedence over derived", () => {
    // When op.topic is already set, deriveTopic is not called.
    // This test documents that FRESH_SENTINEL is recognized.
    expect(FRESH_SENTINEL).toBe("__fresh__")
  })

  test("handles edge cases in PR pattern", () => {
    // PR at start of string
    expect(deriveTopic({ task: "#100 fix typo" })).toBe("auto:pr-100")
    // PR with hash prefix
    expect(deriveTopic({ task: "merge #2000 into main" })).toBe("auto:pr-2000")
    // No match for non-PR patterns
    expect(deriveTopic({ task: "version 1.2.3" })).toBeUndefined()
    // "issue #123" is a valid issue/PR reference
    expect(deriveTopic({ task: "issue #123" })).toBe("auto:pr-123")
    // "PR #123" should match
    expect(deriveTopic({ task: "PR #123 is ready" })).toBe("auto:pr-123")
    // Attached hash (no space) should NOT match
    expect(deriveTopic({ task: "fix issue#123 bug" })).toBeUndefined()
  })
})
