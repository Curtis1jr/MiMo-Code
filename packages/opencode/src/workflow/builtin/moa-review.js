export const meta = {
  name: "moa-review",
  description:
    "Mixture-of-Agents review — fan out a diff to N reviewer agents (correctness, performance, security-and-style) in parallel, then aggregate their findings into a single verdict via the fusion-lead aggregator. Reviewers are read-only.",
  whenToUse:
    "Use to review a diff or patch when you want independent perspectives from multiple focus areas before accepting a change. Best paired with Fusion mode: fusion-lead delegates to fusion-sidekick to produce a patch, then runs moa-review on the sidekick's diff before committing. Gate: skipped automatically for tiny diffs when configured.",
  phases: [
    { title: "Fanout", detail: "One reviewer agent per focus, in parallel" },
    { title: "Aggregate", detail: "fusion-lead consolidates findings into a pass/fail verdict" },
  ],
}

const DEFAULT_FOCUSES = ["correctness", "performance", "security-and-style"]
const DEFAULT_MAX_REVIEWERS = 3
const DEFAULT_MIN_DIFF_LINES = 20
const ALWAYS_FANOUT_PATH_PREFIXES = ["security/", "auth/", "data/"]

const _a = (() => {
  if (args == null || args === undefined) return {}
  if (typeof args === "string") {
    try {
      const p = JSON.parse(args)
      return typeof p === "object" && p !== null ? p : { diff: args }
    } catch {
      return { diff: args }
    }
  }
  return typeof args === "object" ? args : {}
})()

const diff = _a.diff
if (!diff || typeof diff !== "string" || !diff.trim()) {
  throw new Error("args.diff is required — pass {diff: \"<unified diff text>\"} or a raw diff string as args")
}

const requestedReviewers = Number.isInteger(_a.reviewers) && _a.reviewers > 0 ? _a.reviewers : DEFAULT_MAX_REVIEWERS
const focuses = Array.isArray(_a.focuses) && _a.focuses.length > 0 ? _a.focuses : DEFAULT_FOCUSES
const activeFocuses = focuses.slice(0, requestedReviewers)
const aggregatorModel = typeof _a.aggregatorModel === "string" ? _a.aggregatorModel : undefined
const minDiffLines = Number.isInteger(_a.minDiffLines) && _a.minDiffLines >= 0 ? _a.minDiffLines : DEFAULT_MIN_DIFF_LINES

const diffLineCount = diff.split(/\r?\n/).length
const hitsSensitivePath = (() => {
  const paths = []
  for (const line of diff.split(/\r?\n/)) {
    const match = line.match(/^(?:diff --git a\/|\+\+\+ b\/|--- a\/)([^\s]+)/)
    if (match) paths.push(match[1])
  }
  return paths.some((p) => ALWAYS_FANOUT_PATH_PREFIXES.some((prefix) => p.startsWith(prefix)))
})()

const shouldFanout = hitsSensitivePath || diffLineCount >= minDiffLines
log(
  `diff: ${diffLineCount} lines · sensitivePath=${hitsSensitivePath} · fanout=${shouldFanout} · reviewers=${activeFocuses.length}`,
)

const REVIEW_FINDING_SHAPE = {
  type: "object",
  required: ["focus", "findings"],
  properties: {
    focus: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "message"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          message: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          suggestion: { type: "string" },
        },
      },
    },
  },
}

const VERDICT_SHAPE = {
  type: "object",
  required: ["verdict", "summary", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["severity", "message"],
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          message: { type: "string" },
          file: { type: "string" },
          line: { type: "number" },
          suggestion: { type: "string" },
          focus: { type: "string" },
        },
      },
    },
    patchesToRequest: { type: "array", items: { type: "string" } },
  },
}

const REVIEWER_INSTRUCTIONS = {
  correctness:
    "Focus on CORRECTNESS: logic bugs, off-by-one errors, wrong branches, incorrect assumptions, missing edge cases, race conditions, error-handling gaps. Do not comment on style or performance.",
  performance:
    "Focus on PERFORMANCE: quadratic loops, N+1 queries, unnecessary allocations, blocking calls in hot paths, missing memoization opportunities. Do not comment on style or correctness bugs unless they materially affect throughput.",
  "security-and-style":
    "Focus on SECURITY and STYLE: injection risks, unsafe deserialization, missing input validation, secrets in logs, and clear violations of the project's stated style guide. Do not comment on performance or correctness bugs.",
}

const renderReviewerPrompt = (focus, diffText) => {
  const focusInstruction = REVIEWER_INSTRUCTIONS[focus] ?? `Focus on ${focus}. Report only findings in scope for this focus.`
  return `You are a code reviewer with a narrow, dedicated focus. ${focusInstruction}

Return STRICT JSON matching the provided schema. Do not include commentary outside the schema. Only include findings you can defend from the diff itself — do NOT speculate about code you cannot see.

Diff under review:
\`\`\`diff
${diffText}
\`\`\``
}

const renderAggregatorPrompt = (reviewsJson, originalDiff) => `You are the aggregator for a mixture-of-agents review. You will receive independent findings from ${activeFocuses.length} reviewers, each with a narrow focus.

Your job:
1. Merge overlapping findings — same-issue-different-wording gets combined, with focus= set to the merged reviewer focuses.
2. Escalate to \`verdict: "fail"\` ONLY if at least one blocker or two majors survive the merge. Otherwise \`verdict: "pass"\`.
3. Reject any finding that is unsupported by the diff or that generalizes from a single line. Prefer to drop a finding rather than pass on a shaky claim.
4. If any finding suggests a concrete diff-level fix, add the fix description to \`patchesToRequest\`.

Return STRICT JSON matching the provided schema — no commentary outside the schema.

Reviewer findings:
\`\`\`json
${JSON.stringify(reviewsJson, null, 2)}
\`\`\`

Original diff (for reference — the reviewers already saw it):
\`\`\`diff
${originalDiff}
\`\`\``

phase("Fanout")
const reviewerCount = shouldFanout ? activeFocuses.length : 1
const scopedFocuses = activeFocuses.slice(0, reviewerCount)
log(`spawning ${scopedFocuses.length} reviewer(s): ${scopedFocuses.join(", ")}`)

const reviews = await parallel(
  scopedFocuses.map((focus) => () =>
    agent(renderReviewerPrompt(focus, diff), {
      label: `reviewer-${focus}`,
      phase: "Fanout",
      agentType: "general",
      tools: ["read", "grep"],
      schema: REVIEW_FINDING_SHAPE,
    }),
  ),
)

const validReviews = reviews.filter((r) => r && Array.isArray(r.findings))
if (validReviews.length === 0) {
  return { verdict: "fail", summary: "All reviewers failed to produce structured findings.", findings: [], patchesToRequest: [] }
}

phase("Aggregate")
const aggregatorOptions = {
  label: "aggregator",
  phase: "Aggregate",
  agentType: "fusion-lead",
  schema: VERDICT_SHAPE,
}
if (aggregatorModel) aggregatorOptions.model = aggregatorModel

const verdict = await agent(renderAggregatorPrompt(validReviews, diff), aggregatorOptions)
if (!verdict) throw new Error("aggregator step failed to produce a verdict")
log(`verdict: ${verdict.verdict} · ${verdict.findings?.length ?? 0} findings`)
return verdict
