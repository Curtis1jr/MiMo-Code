import { describe, expect, test } from "bun:test"
import { loadComposeBundle } from "../../src/skill/compose/bundle.macro"
import { ConfigCompose } from "../../src/config"

const bundle = loadComposeBundle()

describe("compose skill bundle contract", () => {
  test("bundle contains exactly the three consolidated skills", () => {
    expect(Object.keys(bundle).sort()).toEqual(["compose-dev", "compose-grill", "compose-spec"])
  })

  test("bundle directory names match each SKILL.md frontmatter name (1:1 invariant)", () => {
    // loadComposeBundle no longer synthesizes `compose:${dir}` — the dir IS
    // the skill name. If someone renames a dir but forgets the frontmatter
    // (or vice-versa), scan-time scope wiring silently breaks; catch it here.
    for (const [dirName, files] of Object.entries(bundle)) {
      const md = files["SKILL.md"]
      const nameMatch = md.match(/^name:\s*(.+)$/m)
      expect(nameMatch, `${dirName}/SKILL.md missing frontmatter name`).not.toBeNull()
      expect(nameMatch![1].trim()).toBe(dirName)
    }
  })

  describe("grill: interrogation contract", () => {
    const md = () => bundle["compose-grill"]["SKILL.md"]

    test("interviews one decision at a time with a recommended answer", () => {
      expect(md()).toMatch(/one decision/i)
      expect(md()).toMatch(/recommend/i)
    })

    test("facts from the environment, decisions from the user", () => {
      expect(md()).toMatch(/explor(e|ing) the codebase/i)
    })

    test("routes questions through the question tool, never prose", () => {
      expect(md()).toContain("`question` tool")
    })

    test("has an autonomous mode that never auto-approves destructive actions", () => {
      expect(md()).toMatch(/autonomous/i)
      expect(md()).toMatch(/destructive/i)
    })

    test("hands off to compose-spec", () => {
      expect(md()).toContain("compose-spec")
    })
  })

  describe("spec: single feature document contract", () => {
    const md = () => bundle["compose-spec"]["SKILL.md"]

    test("uses stable [Sn] section anchors", () => {
      expect(md()).toMatch(/\[S1\]/)
      expect(md()).toMatch(/never renumber/i)
    })

    test("tasks carry acceptance criteria and covers references", () => {
      expect(md()).toMatch(/acceptance/i)
      expect(md()).toMatch(/covers/i)
    })

    test("forbids placeholders", () => {
      expect(md()).toMatch(/TBD/)
      expect(md()).toMatch(/placeholder/i)
    })

    test("amendments edit the document in place", () => {
      expect(md()).toMatch(/in place/i)
    })

    test("report section is part of the same document, code is truth", () => {
      expect(md()).toContain("## Report")
      expect(md()).toMatch(/code is truth/i)
    })
  })

  describe("dev: implementation contract", () => {
    const md = () => bundle["compose-dev"]["SKILL.md"]

    test("covers isolation, test-first, debugging, verification, review, finish", () => {
      for (const section of ["Workspace", "Test-First", "Debugging", "Verification", "Review", "Finish"]) {
        expect(md()).toContain(section)
      }
    })

    test("test-first is a decision rule, not an unconditional gate", () => {
      expect(md()).toMatch(/cheap failing test/i)
      expect(md()).toMatch(/Skip test-first/i)
    })

    test("verification requires fresh evidence", () => {
      expect(md()).toMatch(/fresh evidence/i)
    })

    test("review is two-gate: spec compliance before code quality", () => {
      expect(md()).toMatch(/spec compliance/i)
      expect(md()).toMatch(/code quality/i)
    })

    test("reviewers get the diff, not the implementer's report", () => {
      expect(md()).toMatch(/NOT the implementer's report/i)
      expect(md()).toMatch(/git diff/)
    })

    test("finish verifies tests before merge and never auto-discards", () => {
      expect(md()).toMatch(/Tests green first/i)
      expect(md()).toMatch(/never auto-approves/i)
    })

    test("never cleans up harness-owned worktrees", () => {
      expect(md()).toMatch(/harness- or user-owned/i)
      expect(md()).toMatch(/provenance/i)
    })
  })

  describe("dispatch vocabulary uses mimocode's tools, not Claude Code's", () => {
    test("no bundle file uses Claude Code's 'Task tool' / 'general-purpose' phrasing", () => {
      const offenders = Object.entries(bundle).flatMap(([skill, files]) =>
        Object.entries(files)
          .filter(([, content]) => /Task tool|Task Tool|general-purpose|general_purpose/.test(content))
          .map(([rel]) => `${skill}/${rel}`),
      )
      expect(offenders).toEqual([])
    })
  })
})

describe("compose docs dir resolution", () => {
  const worktree = "/repo/root"

  test("relative docs is passed through verbatim by default", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "docs/compose" })).toBe("docs/compose")
  })

  test("relative docs is anchored to worktree when docs_absolute is true", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "docs/compose", docs_absolute: true })).toBe(
      "/repo/root/docs/compose",
    )
  })

  test("absolute docs ignores worktree regardless of docs_absolute", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "/abs/docs" })).toBe("/abs/docs")
    expect(ConfigCompose.resolveDocsDir(worktree, { docs: "/abs/docs", docs_absolute: true })).toBe("/abs/docs")
  })

  test("default docs dir is used when config is absent", () => {
    expect(ConfigCompose.resolveDocsDir(worktree, undefined)).toBe(ConfigCompose.DEFAULT_DOCS_DIR)
  })

  test("skill files do not hardcode the default docs/compose prefix", () => {
    const offenders = Object.entries(bundle).flatMap(([skill, files]) =>
      Object.entries(files)
        .filter(([, content]) => content.includes("docs/compose"))
        .map(([rel]) => `${skill}/${rel}`),
    )
    expect(offenders).toEqual([])
  })
})
