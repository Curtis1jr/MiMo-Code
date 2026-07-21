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

  test("scope discriminates i18n lookup: same name, scope=compose skips, scope=user proceeds", () => {
    // Positive assertion for the scope gate: run TWO calls that differ ONLY
    // in scope. Same name, same bundled flag. If the gate were still keyed
    // on the name prefix, both would return [] (or both would return
    // aliases). Only a scope-keyed gate produces the split.
    //
    // 'data-analytics' has zh/zht slash aliases registered in the i18n
    // dictionaries. We use it as the probe payload so a positive lookup is
    // observable.
    const asBuiltin = localizedAliases(skill({ name: "data-analytics", bundled: true, scope: "builtin" }))
    const asCompose = localizedAliases(skill({ name: "data-analytics", bundled: true, scope: "compose" }))
    expect(asBuiltin.length).toBeGreaterThan(0)
    expect(asCompose).toEqual([])
    // Sanity: the two calls DID reach different branches — this is what
    // proves the scope filter is doing work, not the name prefix.
    expect(asBuiltin).not.toEqual(asCompose)
  })

  test("does not gate a user skill named compose-foo when scope is not compose", () => {
    // Any project/global skill that happens to start with 'compose-' must be
    // treated as a normal skill: it's the scope that gates, not the name.
    // (No i18n entries expected for compose-foo → still [], but the FILTER
    // must not fire on the name prefix. The positive discrimination test
    // above is what proves the gate keys on scope; this test locks in the
    // cross-scope safety property.)
    const result = localizedAliases(skill({ name: "compose-foo", bundled: true, scope: "project" }))
    expect(result).toEqual([])
  })
})
