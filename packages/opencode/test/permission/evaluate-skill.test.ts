import { describe, expect, test } from "bun:test"
import { Permission } from "../../src/permission"

// Helper: build a ruleset of the shape Permission.fromConfig produces.
function ruleset(entries: Record<string, "allow" | "deny" | "ask">): Permission.Ruleset {
  return Object.entries(entries).map(([pattern, action]) => ({
    permission: "skill",
    pattern,
    action,
  })) as Permission.Ruleset
}

describe("Permission.evaluateSkill", () => {
  test("name-specific rule wins over scope rule (allowlist an item in a denied scope)", () => {
    const rules = ruleset({
      "*": "allow",
      "scope:compose": "deny",
      "compose-grill": "allow",
    })
    // compose-grill has scope=compose, so scope:compose says deny, but the
    // more specific name rule says allow. Name must win.
    const result = Permission.evaluateSkill({ name: "compose-grill", scope: "compose" }, rules)
    expect(result.action).toBe("allow")
    expect(result.pattern).toBe("compose-grill")
  })

  test("scope rule wins over wildcard when name has no explicit rule", () => {
    const rules = ruleset({
      "*": "allow",
      "scope:compose": "deny",
    })
    // compose-spec has scope=compose but no name-specific rule; scope:compose
    // must beat the "*" wildcard.
    const result = Permission.evaluateSkill({ name: "compose-spec", scope: "compose" }, rules)
    expect(result.action).toBe("deny")
    expect(result.pattern).toBe("scope:compose")
  })

  test("compose-foo with scope=project is not gated by scope:compose deny", () => {
    // The whole point of scope gating: a user skill that happens to start
    // with 'compose-' but has a different scope is untouched.
    const rules = ruleset({
      "*": "allow",
      "scope:compose": "deny",
    })
    const result = Permission.evaluateSkill({ name: "compose-foo", scope: "project" }, rules)
    expect(result.action).toBe("allow")
    // Fell through both name and scope-specific rules → wildcard hit.
    expect(result.pattern).toBe("*")
  })

  test("missing scope on the target does not crash and falls back to name/wildcard", () => {
    const rules = ruleset({
      "*": "allow",
      "scope:compose": "deny",
    })
    // A skill discovered without a scope tag should still work: no scope
    // lookup, straight to the wildcard.
    const result = Permission.evaluateSkill({ name: "some-skill" }, rules)
    expect(result.action).toBe("allow")
    expect(result.pattern).toBe("*")
  })

  test("empty ruleset returns the safe default ask", () => {
    const result = Permission.evaluateSkill({ name: "compose-grill", scope: "compose" }, [])
    expect(result.action).toBe("ask")
  })

  test("scope wildcard 'scope:*' catches any scoped skill", () => {
    const rules = ruleset({
      "*": "allow",
      "scope:*": "deny",
    })
    // Every scoped skill hits the scope wildcard; unscoped falls to "*".
    expect(Permission.evaluateSkill({ name: "compose-grill", scope: "compose" }, rules).action).toBe("deny")
    expect(Permission.evaluateSkill({ name: "data-analytics", scope: "builtin" }, rules).action).toBe("deny")
    expect(Permission.evaluateSkill({ name: "loose" }, rules).action).toBe("allow")
  })

  test("name wildcard beats scope rule when it's more specific than '*'", () => {
    // Both rules match compose-grill, but name-wildcard 'compose-*' is a
    // proper name pattern (non-"*"), so it wins over the scope rule.
    const rules = ruleset({
      "*": "allow",
      "scope:compose": "deny",
      "compose-*": "allow",
    })
    const result = Permission.evaluateSkill({ name: "compose-grill", scope: "compose" }, rules)
    expect(result.action).toBe("allow")
    expect(result.pattern).toBe("compose-*")
  })
})
