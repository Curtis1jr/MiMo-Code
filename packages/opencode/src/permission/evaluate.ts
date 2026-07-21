import { Wildcard } from "@/util"

type Rule = {
  permission: string
  pattern: string
  action: "allow" | "deny" | "ask"
}

export function evaluate(permission: string, pattern: string, ...rulesets: Rule[][]): Rule {
  const rules = rulesets.flat()
  const match = rules.findLast(
    (rule) => Wildcard.match(permission, rule.permission) && Wildcard.match(pattern, rule.pattern),
  )
  return match ?? { action: "ask", permission, pattern: "*" }
}

/**
 * Skill-specific permission evaluation with two-tier matching.
 *
 * Skills can be gated by either their name (specific) or their scope (namespace).
 * We look up both patterns and let the more specific match win:
 *
 *   1. Match by name  — `compose-grill`, `data-analytics`, or wildcard `compose-*`
 *   2. Match by scope — `scope:compose`, `scope:builtin`, or wildcard `scope:*`
 *
 * A name-based rule is more specific than a scope-based one: if both exist,
 * name wins. This lets a config say:
 *   { "*": "allow", "scope:compose": "deny", "compose-grill": "allow" }
 * to default-deny an entire scope while allowlisting one skill.
 *
 * Note: `compose-*` as a NAME wildcard is a valid user-config option, but
 * default rulesets should key on `scope:compose` instead — the whole point of
 * this refactor is that mechanism keys off the structured scope field, not
 * off a name prefix that a user's own skill could accidentally match.
 *
 * When the config has no rule for either the name or the scope, both queries
 * fall through to the `pattern: "*"` fallback; in that case we return the
 * name query's result (both queries hit the same fallback ruleset).
 */
export function evaluateSkill(
  target: { name: string; scope?: string },
  ...rulesets: Rule[][]
): Rule {
  const byName = evaluate("skill", target.name, ...rulesets)
  if (byName.pattern !== "*") return byName
  if (target.scope) {
    const byScope = evaluate("skill", `scope:${target.scope}`, ...rulesets)
    if (byScope.pattern !== "*") return byScope
  }
  return byName
}
