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
      expect(md()).toMatch(/Inspect the repository/i)
      expect(md()).toMatch(/facts available from the environment/i)
    })

    test("routes questions through the question tool, never prose", () => {
      expect(md()).toContain("`question` tool")
      expect(md()).toContain("`options: []`")
    })

    test("handles absent user input without auto-approving destructive actions", () => {
      expect(md()).toMatch(/Without User Input/i)
      expect(md()).toMatch(/marked `\(Recommended\)`/i)
      expect(md()).toMatch(/destructive/i)
      expect(md()).toMatch(/only to the current decision/i)
      expect(md()).toMatch(/call the `question` tool again/i)
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
      expect(md()).toMatch(/smallest independently verifiable/i)
    })

    test("forbids placeholders", () => {
      expect(md()).toMatch(/TBD/)
      expect(md()).toMatch(/placeholder/i)
    })

    test("amendments edit the document in place", () => {
      expect(md()).toMatch(/in place/i)
    })

    test("report section and journey log stay in the same feature document", () => {
      expect(md()).toContain("## Report")
      expect(md()).toMatch(/one document per feature/i)
      expect(md()).toMatch(/Journey log/i)
    })

    test("finalizes and commits the report before branch completion", () => {
      expect(md()).toMatch(/before merge or PR completion/i)
      expect(md()).toMatch(/feature branch before finishing/i)
    })
  })

  describe("dev: implementation contract", () => {
    const md = () => bundle["compose-dev"]["SKILL.md"]

    test("covers isolation, test-first, debugging, verification, review, finish", () => {
      for (const section of ["Workspace", "Implement", "Verify", "Review", "Finish"]) {
        expect(md()).toContain(section)
      }
      expect(md()).toMatch(/root cause/i)
    })

    test("test-first is a decision rule, not an unconditional gate", () => {
      expect(md()).toMatch(/cheap reproduction/i)
      expect(md()).toMatch(/Skip test-first/i)
    })

    test("verification requires fresh evidence", () => {
      expect(md()).toMatch(/fresh evidence/i)
    })

    test("review requires explicit conclusions for spec compliance, correctness, and codebase consistency", () => {
      expect(md()).toMatch(/spec compliance/i)
      expect(md()).toMatch(/Correctness:/i)
      expect(md()).toMatch(/Codebase consistency:/i)
      expect(md()).toMatch(/separate conclusions/i)
    })

    test("reviewers get exact revision coordinates and a compact verification summary", () => {
      expect(md()).toMatch(/base SHA, head SHA/i)
      expect(md()).toMatch(/compact verification summary/i)
      expect(md()).toMatch(/Do not paste full command output/i)
      expect(md()).toMatch(/implementer-authored narrative/i)
    })

    test("reviewer subagent is told the worktree path and base branch to diff against", () => {
      // Fresh subagents start at the repo root; without an explicit worktree
      // pointer + base branch, `git diff` in the reviewer produces the wrong
      // (or empty) delta.
      expect(md()).toMatch(/worktree path/i)
      expect(md()).toMatch(/base branch/i)
    })

    test("reviewer is at least as capable as the implementer", () => {
      expect(md()).toMatch(/at least as capable/i)
    })

    test("verification finishes before review and passing heavy tests are not repeated", () => {
      expect(md()).toMatch(/Verification and review are sequential/i)
      expect(md()).toMatch(/wait for all verification commands to exit/i)
      expect(md()).toMatch(/must not repeat a command already reported as passing/i)
      expect(md()).toMatch(/heavy E2E suite/i)
    })

    test("workspace contract names the linked-worktree command", () => {
      expect(md()).toContain('git worktree add "$path" -b "$branch"')
      expect(md()).toMatch(/\.worktrees\/.*wins when both exist/i)
    })

    test("finish verifies tests before merge and never auto-discards", () => {
      expect(md()).toMatch(/verification is green/i)
      expect(md()).toMatch(/Never auto-discard/i)
    })

    test("never cleans up harness-owned worktrees", () => {
      expect(md()).toMatch(/harness- and user-owned/i)
      expect(md()).toMatch(/Only remove worktrees/i)
      expect(md()).toContain("git worktree prune")
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
