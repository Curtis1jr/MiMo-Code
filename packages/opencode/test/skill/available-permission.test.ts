import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import fs from "fs/promises"
import { provideInstance, tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Skill } from "../../src/skill"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

// Force external skills off so that only bundled + project user skills participate,
// which keeps the fixture deterministic across dev machines.
process.env.MIMOCODE_DISABLE_EXTERNAL_SKILLS = "true"
delete process.env.MIMOCODE_DISABLE_BUILTIN_SKILLS
delete process.env.MIMOCODE_DISABLE_COMPOSE_SKILLS

function load<A>(dir: string, fn: (agent: Agent.Interface, skill: Skill.Interface) => Effect.Effect<A>) {
  return Effect.runPromise(
    provideInstance(dir)(
      Effect.gen(function* () {
        const agent = yield* Agent.Service
        const skill = yield* Skill.Service
        return yield* fn(agent, skill)
      }),
    ).pipe(Effect.provide(Layer.mergeAll(Agent.defaultLayer, Skill.defaultLayer, CrossSpawnSpawner.defaultLayer))),
  )
}

afterEach(async () => {
  await Instance.disposeAll()
})

describe("Skill.available permission gate", () => {
  test("build agent excludes scope=compose skills; compose agent includes them", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await load(tmp.path, (agentSvc, skillSvc) =>
      Effect.gen(function* () {
        const agents = yield* agentSvc.list()
        const build = agents.find((a) => a.name === "build")!
        const compose = agents.find((a) => a.name === "compose")!
        const buildList = yield* skillSvc.available(build)
        const composeList = yield* skillSvc.available(compose)
        return {
          buildComposeCount: buildList.filter((s) => s.scope === "compose").length,
          composeComposeNames: composeList.filter((s) => s.scope === "compose").map((s) => s.name).toSorted(),
        }
      }),
    )
    // build sees zero compose-scoped skills
    expect(result.buildComposeCount).toBe(0)
    // compose sees all three
    expect(result.composeComposeNames).toEqual(["compose-dev", "compose-grill", "compose-spec"])
  })

  test("user skill named 'compose-foo' (scope=project) is NOT filtered on build agent", async () => {
    await using tmp = await tmpdir({ git: true })
    // Create a project-scope user skill that starts with 'compose-' — the
    // name prefix used to be the mechanism key and would sweep this up. With
    // scope-based gating it must NOT be filtered.
    const skillDir = path.join(tmp.path, ".opencode", "skills", "compose-foo")
    await fs.mkdir(skillDir, { recursive: true })
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      "---\nname: compose-foo\ndescription: User-defined helper that happens to share the compose- prefix.\n---\n\nBody.\n",
    )

    // Ensure this project's scan picks up .opencode/skills — flag has to be off.
    delete process.env.MIMOCODE_DISABLE_EXTERNAL_SKILLS
    delete process.env.MIMOCODE_DISABLE_OPENCODE_SKILLS
    try {
      const result = await load(tmp.path, (agentSvc, skillSvc) =>
        Effect.gen(function* () {
          const agents = yield* agentSvc.list()
          const build = agents.find((a) => a.name === "build")!
          const list = yield* skillSvc.available(build)
          return list.find((s) => s.name === "compose-foo")
        }),
      )
      expect(result).toBeDefined()
      expect(result!.scope).not.toBe("compose")
    } finally {
      process.env.MIMOCODE_DISABLE_EXTERNAL_SKILLS = "true"
    }
  })
})
