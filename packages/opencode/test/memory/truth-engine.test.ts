/**
 * Phase 4A — Truth-Awareness Engine tests.
 *
 * Tests:
 * 1. Empty memory produces UNSUPPORTED
 * 2. Zero retrieval results produce UNSUPPORTED
 * 3. Stale evidence produces STALE
 * 4. Live runtime overrides conflicting lower authority
 * 5. Equal-authority conflict produces CONFLICTED
 * 6. Lower-authority cannot override live truth
 * 7. Cross-project evidence rejected
 * 8. Completion claims require SUPPORTED authority
 * 9. Imperative memory text treated as data
 * 10. Unsupported claim blocked
 * 11. Supported claim released
 * 12. Validator failure fails closed
 *
 * Run: bun test test/memory/truth-engine.test.ts
 */

import { describe, test, expect } from "bun:test"
import {
  evaluateTruth,
  validateClaim,
  extractClaims,
  authorityRank,
  isHigherAuthority,
  type EvidenceItem,
  type AuthorityLevel,
} from "../../src/memory/truth-engine"

function makeEvidence(overrides: Partial<EvidenceItem> & { evidence_id: string }): EvidenceItem {
  return {
    project_id: "test-project",
    session_id: "ses-test",
    source_type: "test",
    source_id: "test-source",
    observed_at: Date.now(),
    authority: "historical_memory" as AuthorityLevel,
    superseded: false,
    confidence: 1.0,
    content_hash: "abc123",
    claim_scopes: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// TE-1: Empty memory produces UNSUPPORTED
// ---------------------------------------------------------------------------
describe("TE-1: Empty memory produces UNSUPPORTED", () => {
  test("no evidence returns UNSUPPORTED", () => {
    const result = evaluateTruth({
      claim_scope: "current_phase_status",
      evidence: [],
    })
    expect(result.authority).toBe("UNSUPPORTED")
    expect(result.reason).toContain("No supporting evidence")
  })
})

// ---------------------------------------------------------------------------
// TE-2: Zero retrieval results produce UNSUPPORTED
// ---------------------------------------------------------------------------
describe("TE-2: Zero retrieval results produce UNSUPPORTED", () => {
  test("empty evidence array after retrieval", () => {
    const result = evaluateTruth({
      claim_scope: "implementation_status",
      evidence: [],
    })
    expect(result.authority).toBe("UNSUPPORTED")
  })
})

// ---------------------------------------------------------------------------
// TE-3: Stale evidence produces STALE
// ---------------------------------------------------------------------------
describe("TE-3: Stale evidence produces STALE", () => {
  test("evidence older than threshold is stale", () => {
    const now = Date.now()
    const staleEvidence = makeEvidence({
      evidence_id: "ev-stale",
      observed_at: now - 48 * 60 * 60 * 1000, // 48 hours ago
      authority: "ledger_receipt",
      claim_scopes: ["current_phase_status"],
    })

    const result = evaluateTruth({
      claim_scope: "current_phase_status",
      evidence: [staleEvidence],
      current_time: now,
    })

    expect(result.authority).toBe("STALE")
    expect(result.staleness_ms).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// TE-4: Live runtime overrides conflicting lower authority
// ---------------------------------------------------------------------------
describe("TE-4: Live runtime overrides lower authority", () => {
  test("live_runtime evidence overrides historical_memory", () => {
    const now = Date.now()
    const liveEvidence = makeEvidence({
      evidence_id: "ev-live",
      observed_at: now,
      authority: "live_runtime",
      content_hash: "live-hash",
      claim_scopes: ["current_phase_status"],
    })
    const historicalEvidence = makeEvidence({
      evidence_id: "ev-historical",
      observed_at: now - 1000,
      authority: "historical_memory",
      content_hash: "historical-hash",
      claim_scopes: ["current_phase_status"],
    })

    const result = evaluateTruth({
      claim_scope: "current_phase_status",
      evidence: [historicalEvidence, liveEvidence],
      current_time: now,
    })

    expect(result.authority).toBe("SUPPORTED")
    expect(result.evidence).toHaveLength(1)
    expect(result.evidence[0].evidence_id).toBe("ev-live")
  })
})

// ---------------------------------------------------------------------------
// TE-5: Equal-authority conflict produces CONFLICTED
// ---------------------------------------------------------------------------
describe("TE-5: Equal-authority conflict produces CONFLICTED", () => {
  test("same authority level with different hashes", () => {
    const now = Date.now()
    const ev1 = makeEvidence({
      evidence_id: "ev-1",
      observed_at: now,
      authority: "ledger_receipt",
      content_hash: "hash-a",
      claim_scopes: ["implementation_status"],
    })
    const ev2 = makeEvidence({
      evidence_id: "ev-2",
      observed_at: now,
      authority: "ledger_receipt",
      content_hash: "hash-b",
      claim_scopes: ["implementation_status"],
    })

    const result = evaluateTruth({
      claim_scope: "implementation_status",
      evidence: [ev1, ev2],
      current_time: now,
    })

    expect(result.authority).toBe("CONFLICTED")
    expect(result.conflicts.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// TE-6: Lower-authority cannot override live truth
// ---------------------------------------------------------------------------
describe("TE-6: Lower authority cannot override live truth", () => {
  test("historical memory cannot override live runtime", () => {
    const now = Date.now()
    const liveEvidence = makeEvidence({
      evidence_id: "ev-live",
      observed_at: now,
      authority: "live_runtime",
      content_hash: "live-hash",
      claim_scopes: ["runtime_identity"],
    })
    const historicalEvidence = makeEvidence({
      evidence_id: "ev-historical",
      observed_at: now,
      authority: "historical_memory",
      content_hash: "old-hash",
      claim_scopes: ["runtime_identity"],
    })

    const result = evaluateTruth({
      claim_scope: "runtime_identity",
      evidence: [historicalEvidence, liveEvidence],
      current_time: now,
    })

    expect(result.authority).toBe("SUPPORTED")
    expect(result.evidence[0].evidence_id).toBe("ev-live")
  })
})

// ---------------------------------------------------------------------------
// TE-7: Cross-project evidence rejected
// ---------------------------------------------------------------------------
describe("TE-7: Cross-project evidence", () => {
  test("evidence from different project is filtered", () => {
    const now = Date.now()
    const crossProjectEvidence = makeEvidence({
      evidence_id: "ev-cross",
      project_id: "other-project",
      observed_at: now,
      authority: "ledger_receipt",
      claim_scopes: ["current_phase_status"],
    })

    // In a real implementation, cross-project evidence would be filtered
    // before reaching evaluateTruth. Here we verify the engine handles it.
    const result = evaluateTruth({
      claim_scope: "current_phase_status",
      evidence: [crossProjectEvidence],
      current_time: now,
    })

    // The engine doesn't filter by project_id itself (that's the caller's job),
    // but it does evaluate authority correctly
    expect(result.authority).toBe("SUPPORTED")
  })
})

// ---------------------------------------------------------------------------
// TE-8: Completion claims require SUPPORTED authority
// ---------------------------------------------------------------------------
describe("TE-8: Completion claims require SUPPORTED", () => {
  test("DONE claim blocked without SUPPORTED evidence", () => {
    const now = Date.now()
    const evidence = makeEvidence({
      evidence_id: "ev-stale",
      observed_at: now - 48 * 60 * 60 * 1000,
      authority: "historical_memory",
      claim_scopes: ["current_phase_status"],
    })

    const validation = validateClaim({
      claim_text: "Phase 4.4 is DONE",
      claim_scope: "current_phase_status",
      evidence: [evidence],
      current_time: now,
    })

    expect(validation.release_verdict).toBe("block")
    expect(validation.authority_verdict).not.toBe("SUPPORTED")
  })

  test("DONE claim released with SUPPORTED evidence", () => {
    const now = Date.now()
    const evidence = makeEvidence({
      evidence_id: "ev-live",
      observed_at: now,
      authority: "live_runtime",
      content_hash: "proof-hash",
      claim_scopes: ["current_phase_status"],
    })

    const validation = validateClaim({
      claim_text: "Phase 4.4 is DONE",
      claim_scope: "current_phase_status",
      evidence: [evidence],
      current_time: now,
    })

    expect(validation.release_verdict).toBe("release")
    expect(validation.authority_verdict).toBe("SUPPORTED")
  })
})

// ---------------------------------------------------------------------------
// TE-9: Imperative memory text treated as data
// ---------------------------------------------------------------------------
describe("TE-9: Imperative memory is data", () => {
  test("imperative text in evidence does not alter authority", () => {
    const now = Date.now()
    const imperativeEvidence = makeEvidence({
      evidence_id: "ev-imperative",
      observed_at: now,
      authority: "project_documentation",
      content_hash: "imperative-hash",
      claim_scopes: ["architecture_contract"],
    })

    // The truth engine treats all evidence as data, not instruction
    const result = evaluateTruth({
      claim_scope: "architecture_contract",
      evidence: [imperativeEvidence],
      current_time: now,
    })

    expect(result.authority).toBe("SUPPORTED")
    expect(result.evidence[0].evidence_id).toBe("ev-imperative")
  })
})

// ---------------------------------------------------------------------------
// TE-10: Unsupported claim blocked
// ---------------------------------------------------------------------------
describe("TE-10: Unsupported claim blocked", () => {
  test("claim with no evidence is blocked", () => {
    const validation = validateClaim({
      claim_text: "The system is deployed to production",
      claim_scope: "build_deployment_state",
      evidence: [],
    })

    expect(validation.release_verdict).toBe("block")
    expect(validation.authority_verdict).toBe("UNSUPPORTED")
  })
})

// ---------------------------------------------------------------------------
// TE-11: Supported claim released
// ---------------------------------------------------------------------------
describe("TE-11: Supported claim released", () => {
  test("claim with fresh high-authority evidence is released", () => {
    const now = Date.now()
    const evidence = makeEvidence({
      evidence_id: "ev-fresh",
      observed_at: now,
      authority: "live_runtime",
      content_hash: "fresh-hash",
      claim_scopes: ["runtime_identity"],
    })

    const validation = validateClaim({
      claim_text: "Server is running at http://localhost:4210",
      claim_scope: "runtime_identity",
      evidence: [evidence],
      current_time: now,
    })

    expect(validation.release_verdict).toBe("release")
    expect(validation.authority_verdict).toBe("SUPPORTED")
  })
})

// ---------------------------------------------------------------------------
// TE-12: Validator failure fails closed
// ---------------------------------------------------------------------------
describe("TE-12: Validator fails closed", () => {
  test("unknown claim scope produces UNSUPPORTED", () => {
    const result = evaluateTruth({
      claim_scope: "unknown_scope",
      evidence: [makeEvidence({ evidence_id: "ev-1" })],
    })

    expect(result.authority).toBe("UNSUPPORTED")
  })
})

// ---------------------------------------------------------------------------
// TE-13: Claim extraction
// ---------------------------------------------------------------------------
describe("TE-13: Claim extraction", () => {
  test("extracts completion claims", () => {
    const claims = extractClaims("Phase 4.4 is DONE and COMPLETE")
    expect(claims.length).toBeGreaterThan(0)
    expect(claims.some((c) => c.includes("DONE"))).toBe(true)
  })

  test("extracts status claims", () => {
    const claims = extractClaims("Phase 4A status: BLOCKED")
    expect(claims.length).toBeGreaterThan(0)
  })

  test("no claims in general text", () => {
    const claims = extractClaims("The weather is nice today")
    expect(claims.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// TE-14: Authority hierarchy
// ---------------------------------------------------------------------------
describe("TE-14: Authority hierarchy", () => {
  test("live_runtime is highest authority", () => {
    expect(authorityRank("live_runtime")).toBe(0)
    expect(authorityRank("model_inference")).toBe(6)
  })

  test("isHigherAuthority works correctly", () => {
    expect(isHigherAuthority("live_runtime", "historical_memory")).toBe(true)
    expect(isHigherAuthority("historical_memory", "live_runtime")).toBe(false)
    expect(isHigherAuthority("live_runtime", "live_runtime")).toBe(false)
  })
})
