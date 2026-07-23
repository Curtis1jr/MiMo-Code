export const meta = {
  name: "moa-implement",
  description:
    "Mixture-of-Agents implementation — fan out an implementation task to K fusion-sidekick agents running in isolated worktrees, then aggregate their proposed patches via the fusion-lead aggregator, which picks a winner and returns the winning unified diff. The losing worktrees stay on disk (their metadata is surfaced) so the caller can inspect or reclaim them.",
  whenToUse:
    "Use when a single implementation task has real ambiguity in the plan (multiple defensible designs, competing correctness/perf tradeoffs) and you want independent parallel attempts before committing to one. Gate: not free — K sidekick agents each burn a full implementation run's tokens. Prefer for load-bearing/risky changes, not routine edits.",
  phases: [
    { title: "Fanout", detail: "K sidekick agents in isolated worktrees, each proposing a unified diff" },
    { title: "Aggregate", detail: "fusion-lead picks the best patch and returns it" },
  ],
}

const DEFAULT_K = 3
const MAX_K = 8

const _a = (() => {
  if (args == null || args === undefined) return {}
  if (typeof args === "string") {
    try {
      const p = JSON.parse(args)
      return typeof p === "object" && p !== null ? p : { task: args }
    } catch {
      return { task: args }
    }
  }
  return typeof args === "object" ? args : {}
})()

const task = _a.task
if (!task || typeof task !== "string" || !task.trim()) {
  throw new Error("args.task is required — pass {task: \"<what to implement>\"} or a raw task string as args")
}

const requestedK = Number.isInteger(_a.k) && _a.k > 0 ? _a.k : DEFAULT_K
const k = Math.min(requestedK, MAX_K)
const context = typeof _a.context === "string" ? _a.context : ""
const aggregatorModel = typeof _a.aggregatorModel === "object" && _a.aggregatorModel !== null ? _a.aggregatorModel : undefined

log(`moa-implement · k=${k} · task=${task.slice(0, 120)}`)

const SIDEKICK_SHAPE = {
  type: "object",
  required: ["summary", "patch"],
  properties: {
    summary: { type: "string" },
    patch: { type: "string" },
    filesTouched: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
}

const AGGREGATOR_SHAPE = {
  type: "object",
  required: ["picked_index", "rationale", "patch"],
  properties: {
    picked_index: { type: "integer" },
    rationale: { type: "string" },
    patch: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
  },
}

const renderSidekickPrompt = (idx, taskText, ctx) => {
  const contextBlock = ctx.trim() ? `\n\nAdditional grounding context:\n${ctx.trim()}\n` : ""
  return `You are a fusion-sidekick working on ONE candidate implementation among ${k}. Your worktree is isolated — other candidates cannot see your work and you cannot see theirs. Work directly against your worktree with edit/write tools.

Task:
${taskText}
${contextBlock}
When you are done implementing, produce STRICT JSON matching the provided schema. The \`patch\` field MUST be the full output of \`git diff HEAD\` from your worktree root — a unified diff, verbatim, no wrapping code fences. Use the bash tool to run \`git diff HEAD\` and copy its stdout into \`patch\`. Do NOT wrap the diff in \`\`\`diff / \`\`\` markers.

If you decide the task is impossible or the plan is broken, still return the schema with \`patch: ""\` and an explanation in \`summary\` / \`notes\`.

Return ONLY the JSON — no commentary outside the schema.

This is candidate ${idx} of ${k}. Bring your best independent attempt; do NOT try to guess what the other candidates might do.`
}

const renderAggregatorPrompt = (deliverables, taskText) => {
  const rendered = deliverables
    .map((d, i) => {
      if (!d) return `### Candidate ${i}\n(candidate failed — no deliverable)`
      const filesTouched = Array.isArray(d.filesTouched) ? d.filesTouched.join(", ") : "(none listed)"
      const patchPreview = typeof d.patch === "string" ? d.patch : "(no patch)"
      const notes = typeof d.notes === "string" && d.notes.trim() ? `\nNotes: ${d.notes.trim()}` : ""
      return `### Candidate ${i}\nSummary: ${d.summary ?? "(no summary)"}\nFiles touched: ${filesTouched}${notes}\nPatch:\n\`\`\`diff\n${patchPreview}\n\`\`\``
    })
    .join("\n\n")

  return `You are the aggregator (fusion-lead) for a mixture-of-agents implementation. You will see ${deliverables.length} independent candidate patches for the SAME task. Each candidate worked in an isolated worktree and returned its \`git diff HEAD\`.

Original task:
${taskText}

Your job:
1. Pick the ONE candidate whose patch is the most correct, minimal, and safe. \`picked_index\` MUST be an integer in [0, ${deliverables.length - 1}].
2. Copy that candidate's patch verbatim into your \`patch\` field. Do NOT synthesize a new patch, do NOT edit or merge patches — the picked patch must match its source byte-for-byte.
3. In \`rationale\`, explain in one paragraph why this patch beat the others. Reference specific decisions ("candidate 1's approach to X is safer than candidate 2's because…").
4. In \`concerns\`, list any residual issues with the picked patch that a follow-up review should catch. Each concern one sentence, imperative.

If NO candidate produced a usable patch, pick the least-broken one and put the explanation in \`concerns\`.

Return STRICT JSON matching the schema. No commentary outside the schema.

Candidate deliverables:
${rendered}`
}

phase("Fanout")
log(`spawning ${k} sidekick(s) in isolated worktrees`)

const rawDeliverables = await parallel(
  Array.from({ length: k }, (_, i) => () =>
    agent(renderSidekickPrompt(i, task, context), {
      label: `sidekick-${i}`,
      phase: "Fanout",
      agentType: "fusion-sidekick",
      isolation: "worktree",
      schema: SIDEKICK_SHAPE,
    }),
  ),
)

// Split each result into its structured payload and its worktree handle (the
// runtime wraps deliverables in { _worktree, ...payload } when isolation is set
// and changes exist). A null result means the sidekick failed outright — surface
// it as null so the aggregator can still consider its neighbours and the caller
// sees which slots failed.
const deliverables = rawDeliverables.map((r) => {
  if (!r || typeof r !== "object") return null
  // schema-shape fields live at the top level; _worktree is a sibling key when
  // present. Extract by omission.
  const worktree = r._worktree
  const payload = { ...r }
  delete payload._worktree
  // When the deliverable was wrapped as { _worktree, result: <schema> } (the
  // structured-nesting fallback), unwrap the result.
  const structured = payload && "result" in payload && Object.keys(payload).length === 1 ? payload.result : payload
  return { payload: structured, worktree: worktree ?? null }
})

const survivors = deliverables
  .map((d, i) => (d && d.payload && typeof d.payload === "object" ? { i, ...d } : null))
  .filter((x) => x !== null)

if (survivors.length === 0) {
  log("all sidekicks failed to produce a deliverable")
  return {
    picked_index: -1,
    rationale: "All sidekick candidates failed to produce a structured deliverable.",
    patch: "",
    concerns: ["Retry with more grounding context, a smaller task, or a different aggregator model."],
    worktrees: [],
  }
}

phase("Aggregate")
const aggregatorOptions = {
  label: "aggregator",
  phase: "Aggregate",
  agentType: "fusion-lead",
  schema: AGGREGATOR_SHAPE,
}
if (aggregatorModel && typeof aggregatorModel.providerID === "string" && typeof aggregatorModel.modelID === "string") {
  aggregatorOptions.model = `${aggregatorModel.providerID}/${aggregatorModel.modelID}`
}

const verdict = await agent(
  renderAggregatorPrompt(survivors.map((s) => s.payload), task),
  aggregatorOptions,
)
if (!verdict || typeof verdict !== "object") {
  throw new Error("aggregator step failed to produce a verdict")
}

// Clamp picked_index to a survivor slot. The aggregator was told to pick from
// the SURVIVORS array (0..survivors.length-1). Map back to the ORIGINAL slot
// index so the caller can correlate with the worktree list.
const rawPick = Number.isInteger(verdict.picked_index) ? verdict.picked_index : 0
const clampedPick = rawPick >= 0 && rawPick < survivors.length ? rawPick : 0
const winner = survivors[clampedPick]
const originalIndex = winner.i

log(`verdict: picked survivor ${clampedPick} (original candidate ${originalIndex}) · concerns=${(verdict.concerns ?? []).length}`)

return {
  picked_index: originalIndex,
  rationale: typeof verdict.rationale === "string" ? verdict.rationale : "",
  patch: typeof verdict.patch === "string" ? verdict.patch : (typeof winner.payload.patch === "string" ? winner.payload.patch : ""),
  concerns: Array.isArray(verdict.concerns) ? verdict.concerns.filter((c) => typeof c === "string") : [],
  worktrees: deliverables.map((d, i) => ({
    index: i,
    directory: d?.worktree?.directory ?? null,
    branch: d?.worktree?.branch ?? null,
    changed: d?.worktree?.changed ?? false,
    picked: i === originalIndex,
  })),
}
