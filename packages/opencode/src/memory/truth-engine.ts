/**
 * Phase 4A — Truth-Awareness Engine
 *
 * Evaluates claim scopes and issues speaking authority.
 *
 * Governing rule:
 *   No supporting memory + no current evidence + no explicit user-provided context
 *   = no project-specific factual assertion
 *
 * Speaking authority states:
 *   SUPPORTED — release grounded claims
 *   RETRIEVAL_REQUIRED — retrieve evidence before generation
 *   CONFLICTED — expose conflict; do not silently choose
 *   STALE — refresh current evidence before current-state claims
 *   UNSUPPORTED — abstain or request missing evidence
 */

import { Effect } from "effect"
import { Log } from "../util"
import { createHash } from "crypto"

const log = Log.create({ service: "memory.truth-engine" })

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SpeakingAuthority =
  | "SUPPORTED"
  | "RETRIEVAL_REQUIRED"
  | "CONFLICTED"
  | "STALE"
  | "UNSUPPORTED"

export type AuthorityLevel =
  | "live_runtime"
  | "ledger_receipt"
  | "repository_state"
  | "project_documentation"
  | "current_session_user"
  | "historical_memory"
  | "model_inference"

export interface EvidenceItem {
  readonly evidence_id: string
  readonly project_id?: string
  readonly session_id?: string
  readonly source_type: string
  readonly source_id: string
  readonly observed_at: number
  readonly valid_from?: number
  readonly revision?: number
  readonly authority: AuthorityLevel
  readonly superseded: boolean
  readonly confidence: number
  readonly content_hash: string
  readonly claim_scopes: readonly string[]
}

export interface ClaimScope {
  readonly scope: string
  readonly description: string
  readonly required_evidence: AuthorityLevel[]
}

export interface TruthEvaluation {
  readonly authority: SpeakingAuthority
  readonly claim_scope: string
  readonly evidence: readonly EvidenceItem[]
  readonly conflicts: readonly string[]
  readonly staleness_ms?: number
  readonly reason: string
}

export interface ClaimValidation {
  readonly claim_id: string
  readonly claim_text: string
  readonly claim_scope: string
  readonly evidence_ids: readonly string[]
  readonly authority_verdict: SpeakingAuthority
  readonly freshness_verdict: "current" | "stale" | "unknown"
  readonly conflict_verdict: "none" | "detected" | "unresolved"
  readonly release_verdict: "release" | "rewrite" | "block" | "retrieve"
  readonly reason: string
}

// ---------------------------------------------------------------------------
// Authority hierarchy
// ---------------------------------------------------------------------------

const AUTHORITY_ORDER: AuthorityLevel[] = [
  "live_runtime",
  "ledger_receipt",
  "repository_state",
  "project_documentation",
  "current_session_user",
  "historical_memory",
  "model_inference",
]

export function authorityRank(level: AuthorityLevel): number {
  return AUTHORITY_ORDER.indexOf(level)
}

export function isHigherAuthority(a: AuthorityLevel, b: AuthorityLevel): boolean {
  return authorityRank(a) < authorityRank(b)
}

// ---------------------------------------------------------------------------
// Claim scopes
// ---------------------------------------------------------------------------

export const CLAIM_SCOPES: Record<string, ClaimScope> = {
  "current_phase_status": {
    scope: "current_phase_status",
    description: "Current phase or implementation status",
    required_evidence: ["ledger_receipt", "repository_state", "live_runtime"],
  },
  "implementation_status": {
    scope: "implementation_status",
    description: "Whether a feature is implemented",
    required_evidence: ["ledger_receipt", "repository_state"],
  },
  "build_deployment_state": {
    scope: "build_deployment_state",
    description: "Build, install, or deployment state",
    required_evidence: ["live_runtime", "ledger_receipt"],
  },
  "commit_branch_identity": {
    scope: "commit_branch_identity",
    description: "Commit SHA, branch name, or repository state",
    required_evidence: ["repository_state", "live_runtime"],
  },
  "runtime_identity": {
    scope: "runtime_identity",
    description: "Running process identity or launcher resolution",
    required_evidence: ["live_runtime"],
  },
  "file_path_content": {
    scope: "file_path_content",
    description: "File paths, contents, or structure",
    required_evidence: ["repository_state", "live_runtime"],
  },
  "prior_user_decision": {
    scope: "prior_user_decision",
    description: "Prior user decisions or directives",
    required_evidence: ["current_session_user", "historical_memory"],
  },
  "architecture_contract": {
    scope: "architecture_contract",
    description: "Architecture decisions or contracts",
    required_evidence: ["project_documentation", "ledger_receipt"],
  },
  "open_blocker": {
    scope: "open_blocker",
    description: "Open blockers or known issues",
    required_evidence: ["ledger_receipt", "historical_memory"],
  },
  "test_certification_status": {
    scope: "test_certification_status",
    description: "Test results or certification status",
    required_evidence: ["live_runtime", "ledger_receipt"],
  },
  "migration_recovery_status": {
    scope: "migration_recovery_status",
    description: "Migration or recovery status",
    required_evidence: ["ledger_receipt", "live_runtime"],
  },
}

// ---------------------------------------------------------------------------
// Staleness thresholds
// ---------------------------------------------------------------------------

const STALENESS_THRESHOLDS: Record<string, number> = {
  "current_phase_status": 24 * 60 * 60 * 1000, // 24 hours
  "implementation_status": 24 * 60 * 60 * 1000,
  "build_deployment_state": 60 * 60 * 1000, // 1 hour
  "commit_branch_identity": 60 * 60 * 1000,
  "runtime_identity": 5 * 60 * 1000, // 5 minutes
  "file_path_content": 60 * 60 * 1000,
  "prior_user_decision": 7 * 24 * 60 * 60 * 1000, // 7 days
  "architecture_contract": 7 * 24 * 60 * 60 * 1000,
  "open_blocker": 24 * 60 * 60 * 1000,
  "test_certification_status": 60 * 60 * 1000,
  "migration_recovery_status": 24 * 60 * 60 * 1000,
}

// ---------------------------------------------------------------------------
// Truth-Awareness Engine
// ---------------------------------------------------------------------------

/**
 * Evaluate speaking authority for a claim scope given available evidence.
 */
export function evaluateTruth(input: {
  claim_scope: string
  evidence: EvidenceItem[]
  current_time?: number
}): TruthEvaluation {
  const { claim_scope, evidence } = input
  const now = input.current_time ?? Date.now()

  const scopeConfig = CLAIM_SCOPES[claim_scope]
  if (!scopeConfig) {
    return {
      authority: "UNSUPPORTED",
      claim_scope,
      evidence: [],
      conflicts: [],
      reason: `Unknown claim scope: ${claim_scope}`,
    }
  }

  // Filter out superseded evidence
  const activeEvidence = evidence.filter((e) => !e.superseded)

  if (activeEvidence.length === 0) {
    return {
      authority: "UNSUPPORTED",
      claim_scope,
      evidence: [],
      conflicts: [],
      reason: "No supporting evidence found for claim scope",
    }
  }

  // Check if any evidence meets the required authority level
  const hasRequiredAuthority = activeEvidence.some((e) =>
    scopeConfig.required_evidence.includes(e.authority),
  )

  if (!hasRequiredAuthority) {
    // Check if we have lower-authority evidence that requires retrieval
    const hasLowerAuthority = activeEvidence.some(
      (e) => !scopeConfig.required_evidence.includes(e.authority),
    )

    if (hasLowerAuthority) {
      return {
        authority: "RETRIEVAL_REQUIRED",
        claim_scope,
        evidence: activeEvidence,
        conflicts: [],
        reason: `Evidence exists but below required authority. Need: ${scopeConfig.required_evidence.join(" or ")}`,
      }
    }

    return {
      authority: "UNSUPPORTED",
      claim_scope,
      evidence: activeEvidence,
      conflicts: [],
      reason: `No evidence at required authority level: ${scopeConfig.required_evidence.join(" or ")}`,
    }
  }

  // Check staleness
  const staleThreshold = STALENESS_THRESHOLDS[claim_scope] ?? 24 * 60 * 60 * 1000
  const staleEvidence = activeEvidence.filter((e) => {
    const age = now - e.observed_at
    return age > staleThreshold
  })

  const freshEvidence = activeEvidence.filter((e) => {
    const age = now - e.observed_at
    return age <= staleThreshold
  })

  if (freshEvidence.length === 0 && staleEvidence.length > 0) {
    return {
      authority: "STALE",
      claim_scope,
      evidence: staleEvidence,
      conflicts: [],
      staleness_ms: now - staleEvidence[0].observed_at,
      reason: `All evidence is stale (>${staleThreshold}ms old)`,
    }
  }

  // Check for conflicts (same scope, different content hashes)
  const hashGroups = new Map<string, EvidenceItem[]>()
  for (const e of freshEvidence) {
    const key = `${e.claim_scopes.join(",")}:${e.content_hash}`
    if (!hashGroups.has(key)) hashGroups.set(key, [])
    hashGroups.get(key)!.push(e)
  }

  // Check for same claim scope with different content
  const scopeEvidence = freshEvidence.filter((e) =>
    e.claim_scopes.includes(claim_scope),
  )
  const uniqueHashes = new Set(scopeEvidence.map((e) => e.content_hash))

  if (uniqueHashes.size > 1) {
    // Multiple different values for the same claim scope
    const highestAuthority = scopeEvidence.sort(
      (a, b) => authorityRank(a.authority) - authorityRank(b.authority),
    )[0]

    // If highest authority evidence is live_runtime, use it
    if (highestAuthority.authority === "live_runtime") {
      return {
        authority: "SUPPORTED",
        claim_scope,
        evidence: [highestAuthority],
        conflicts: [],
        reason: "Live runtime evidence overrides conflicting lower-authority evidence",
      }
    }

    return {
      authority: "CONFLICTED",
      claim_scope,
      evidence: scopeEvidence,
      conflicts: scopeEvidence.map(
        (e) => `${e.source_type}:${e.source_id} (hash: ${e.content_hash.slice(0, 16)})`,
      ),
      reason: `Conflicting evidence for claim scope: ${claim_scope}`,
    }
  }

  return {
    authority: "SUPPORTED",
    claim_scope,
    evidence: freshEvidence,
    conflicts: [],
    reason: "Evidence supports claim at required authority level",
  }
}

// ---------------------------------------------------------------------------
// Claim extraction (simplified pattern matching)
// ---------------------------------------------------------------------------

const COMPLETION_PATTERNS = [
  /\b(?:is|are|was|been)\s+(DONE|COMPLETE|COMPLETED|FINISHED)\b/i,
  /\b(?:is|are|was|been)\s+(DEPLOYED|LIVE|IN\s+PRODUCTION)\b/i,
  /\b(?:is|are|was|been)\s+(CERTIFIED)\b/i,
  /\b(?:is|are|was|been)\s+(FIXED|RESOLVED|CLOSED)\b/i,
  /\b(?:is|are|was|been)\s+(RECOVERED)\b/i,
  /\b(?:is|are|was|been)\s+(MIGRATED)\b/i,
  /\b(?:is|are|was|been)\s+(PRODUCTION-READY|PROD-READY)\b/i,
  /\b(NO\s+DATA\s+LOSS|ZERO\s+DATA\s+LOSS)\b/i,
  /\b(ROOT\s+CAUSE\s+CLOSED)\b/i,
]

const STATUS_PATTERNS = [
  /\b(phase|Phase)\s+\d+(\.\d+)?\s+(is\s+)?(DONE|COMPLETE|PARTIAL|IMPLEMENTED|BLOCKED)/i,
  /\b(status|Status)\s*[:=]\s*(DONE|COMPLETE|PARTIAL|IMPLEMENTED|BLOCKED)/i,
  /\b(commit|Commit)\s+`?[a-f0-9]{7,}`?\b/i,
  /\b(tests?|Tests?)\s+\d+\s*(pass|fail|PASS|FAIL)/i,
]

export function extractClaims(text: string): string[] {
  const claims: string[] = []

  for (const pattern of COMPLETION_PATTERNS) {
    const matches = text.match(pattern)
    if (matches) {
      claims.push(matches[0])
    }
  }

  for (const pattern of STATUS_PATTERNS) {
    const matches = text.match(pattern)
    if (matches) {
      claims.push(matches[0])
    }
  }

  return [...new Set(claims)]
}

// ---------------------------------------------------------------------------
// Claim validator
// ---------------------------------------------------------------------------

export function validateClaim(input: {
  claim_text: string
  claim_scope: string
  evidence: EvidenceItem[]
  current_time?: number
}): ClaimValidation {
  const { claim_text, claim_scope, evidence } = input
  const claimId = createHash("sha256").update(claim_text).digest("hex").slice(0, 16)

  const evaluation = evaluateTruth({
    claim_scope,
    evidence,
    current_time: input.current_time,
  })

  let releaseVerdict: "release" | "rewrite" | "block" | "retrieve"
  let reason: string

  switch (evaluation.authority) {
    case "SUPPORTED":
      releaseVerdict = "release"
      reason = "Claim supported by evidence at required authority level"
      break
    case "RETRIEVAL_REQUIRED":
      releaseVerdict = "retrieve"
      reason = "Evidence retrieval required before claim can be released"
      break
    case "CONFLICTED":
      releaseVerdict = "block"
      reason = `Conflicting evidence: ${evaluation.conflicts.join(", ")}`
      break
    case "STALE":
      releaseVerdict = "retrieve"
      reason = `Evidence is stale (${evaluation.staleness_ms}ms old), refresh required`
      break
    case "UNSUPPORTED":
      releaseVerdict = "block"
      reason = "No supporting evidence at required authority level"
      break
  }

  // Hard completion gates
  const isCompletionClaim = COMPLETION_PATTERNS.some((p) => p.test(claim_text))
  if (isCompletionClaim && evaluation.authority !== "SUPPORTED") {
    releaseVerdict = "block"
    reason = `Completion claim requires SUPPORTED authority, got ${evaluation.authority}`
  }

  return {
    claim_id: claimId,
    claim_text,
    claim_scope,
    evidence_ids: evaluation.evidence.map((e) => e.evidence_id),
    authority_verdict: evaluation.authority,
    freshness_verdict:
      evaluation.authority === "STALE"
        ? "stale"
        : evaluation.authority === "SUPPORTED"
          ? "current"
          : "unknown",
    conflict_verdict:
      evaluation.conflicts.length > 0 ? "detected" : "none",
    release_verdict: releaseVerdict,
    reason,
  }
}
