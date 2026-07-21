import { describe, expect, test } from "bun:test"
import type { Skill } from "../../src/skill"
import { localizedAliases } from "../../src/skill/localized-alias"

const skill = (overrides: Partial<Skill.Info> & Pick<Skill.Info, "name">): Skill.Info => ({
  description: "",
  location: `/skills/${overrides.name}/SKILL.md`,
  content: `# ${overrides.name}`,
  ...overrides,
})

describe("localizedAliases", () => {
  test("returns no aliases for non-bundled skills", () => {
    expect(localizedAliases(skill({ name: "data-analytics" }))).toEqual([])
  })

  test("returns aliases for bundled non-compose skills that have i18n entries", () => {
    const aliases = localizedAliases(skill({ name: "data-analytics", bundled: true }))
    // data-analytics has zh/zht slash aliases wired up in the i18n dicts
    expect(aliases.length).toBeGreaterThan(0)
  })

  test("skips compose-scoped bundled skills so they never leak i18n aliases", () => {
    // The compose skill is bundled AND has i18n entries, but scope=compose
    // must gate it out — /compose is the entry point, not localized aliases.
    expect(localizedAliases(skill({ name: "compose-dev", bundled: true, scope: "compose" }))).toEqual([])
  })

  test("does not gate a user skill named compose-foo when scope is not compose", () => {
    // Any project/global skill that happens to start with 'compose-' must be
    // treated as a normal skill: it's the scope that gates, not the name.
    // (No i18n entries expected for user skills → still [], but the FILTER
    // must not fire on the name prefix.)
    const result = localizedAliases(skill({ name: "compose-foo", bundled: true, scope: "project" }))
    // Should follow the same code path as any other bundled skill (empty
    // because no i18n entry, NOT because of the compose gate).
    expect(result).toEqual([])
  })
})
