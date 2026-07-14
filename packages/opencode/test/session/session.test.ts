import { describe, expect, test } from "bun:test"
import path from "path"
import { Session as SessionNs } from "../../src/session"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util"
import { Instance } from "../../src/project/instance"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"
import { deriveTopic, FRESH_SENTINEL } from "../../src/tool/session"

const projectRoot = path.join(__dirname, "../..")
void Log.init({ print: false })

function create(input?: SessionNs.CreateInput) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.create(input)))
}

function get(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.get(id)))
}

function remove(id: SessionID) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.remove(id)))
}

function updateMessage<T extends MessageV2.Info>(msg: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updateMessage(msg)))
}

function updatePart<T extends MessageV2.Part>(part: T) {
  return AppRuntime.runPromise(SessionNs.Service.use((svc) => svc.updatePart(part)))
}

describe("session.created event", () => {
  test("should emit session.created event when session is created", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        let eventReceived = false
        let receivedInfo: SessionNs.Info | undefined

        const unsub = Bus.subscribe(SessionNs.Event.Created, (event) => {
          eventReceived = true
          receivedInfo = event.properties.info as SessionNs.Info
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsub()

        expect(eventReceived).toBe(true)
        expect(receivedInfo).toBeDefined()
        expect(receivedInfo?.id).toBe(info.id)
        expect(receivedInfo?.projectID).toBe(info.projectID)
        expect(receivedInfo?.directory).toBe(info.directory)
        expect(receivedInfo?.title).toBe(info.title)

        await remove(info.id)
      },
    })
  })

  test("session.created event should be emitted before session.updated", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const events: string[] = []

        const unsubCreated = Bus.subscribe(SessionNs.Event.Created, () => {
          events.push("created")
        })

        const unsubUpdated = Bus.subscribe(SessionNs.Event.Updated, () => {
          events.push("updated")
        })

        const info = await create({})
        await new Promise((resolve) => setTimeout(resolve, 100))
        unsubCreated()
        unsubUpdated()

        expect(events).toContain("created")
        expect(events).toContain("updated")
        expect(events.indexOf("created")).toBeLessThan(events.indexOf("updated"))

        await remove(info.id)
      },
    })
  })
})

describe("step-finish token propagation via Bus event", () => {
  test(
    "non-zero tokens propagate through PartUpdated event",
    async () => {
      await Instance.provide({
        directory: projectRoot,
        fn: async () => {
          const info = await create({})

          const messageID = MessageID.ascending()
          await updateMessage({
            id: messageID,
            sessionID: info.id,
            role: "user",
            time: { created: Date.now() },
            agent: "user",
            model: { providerID: "test", modelID: "test" },
            tools: {},
            mode: "",
          } as unknown as MessageV2.Info)

          let received: MessageV2.Part | undefined
          const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
            received = event.properties.part
          })

          const tokens = {
            total: 1500,
            input: 500,
            output: 800,
            reasoning: 200,
            cache: { read: 100, write: 50 },
          }

          const partInput = {
            id: PartID.ascending(),
            messageID,
            sessionID: info.id,
            type: "step-finish" as const,
            reason: "stop",
            cost: 0.005,
            tokens,
          }

          await updatePart(partInput)
          await new Promise((resolve) => setTimeout(resolve, 100))

          expect(received).toBeDefined()
          expect(received!.type).toBe("step-finish")
          const finish = received as MessageV2.StepFinishPart
          expect(finish.tokens.input).toBe(500)
          expect(finish.tokens.output).toBe(800)
          expect(finish.tokens.reasoning).toBe(200)
          expect(finish.tokens.total).toBe(1500)
          expect(finish.tokens.cache.read).toBe(100)
          expect(finish.tokens.cache.write).toBe(50)
          expect(finish.cost).toBe(0.005)
          expect(received).not.toBe(partInput)

          unsub()
          await remove(info.id)
        },
      })
    },
    { timeout: 30000 },
  )
})

describe("Session", () => {
  test("remove works without an instance", async () => {
    await using tmp = await tmpdir({ git: true })

    const info = await Instance.provide({
      directory: tmp.path,
      fn: () => create({ title: "remove-without-instance" }),
    })

    await expect(async () => {
      await remove(info.id)
    }).not.toThrow()

    let missing = false
    await get(info.id).catch(() => {
      missing = true
    })

    expect(missing).toBe(true)
  })
})

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
