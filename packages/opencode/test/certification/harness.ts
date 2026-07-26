/**
 * Certification Harness — Governed test infrastructure
 *
 * Provides isolated fixtures, disposable runtime roots, evidence collection,
 * and deterministic PASS/FAIL verdicts for all certification gates.
 *
 * Design principles:
 * - Never run destructive tests against production stores
 * - Unique certification run IDs
 * - SHA-256 evidence manifests
 * - Preservation of failed-run evidence
 */

import { createHash, randomBytes } from "crypto"
import { mkdtemp, rm, writeFile, readFile, mkdir } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"

export interface CertificationRun {
  readonly runId: string
  readonly startedAt: number
  readonly tempRoot: string
  readonly evidenceRoot: string
  readonly manifest: EvidenceManifest
}

export interface EvidenceManifest {
  runId: string
  startedAt: number
  completedAt?: number
  gates: GateResult[]
  sha256?: string
}

export interface GateResult {
  readonly gate: string
  readonly verdict: "PASS" | "FAIL" | "PARTIAL" | "NOT_IMPLEMENTED" | "NOT_PROVEN"
  readonly startedAt: number
  readonly completedAt?: number
  readonly evidence: EvidenceEntry[]
  readonly reason?: string
}

export interface EvidenceEntry {
  readonly key: string
  readonly path?: string
  readonly sha256?: string
  readonly content?: string
  readonly timestamp: number
}

export async function createCertificationRun(): Promise<CertificationRun> {
  const runId = `cert-${Date.now()}-${randomBytes(8).toString("hex")}`
  const tempRoot = await mkdtemp(join(tmpdir(), `mimo-cert-${runId}-`))
  const evidenceRoot = join(tempRoot, "evidence")
  await mkdir(evidenceRoot, { recursive: true })

  const manifest: EvidenceManifest = {
    runId,
    startedAt: Date.now(),
    gates: [],
  }

  return { runId, startedAt: Date.now(), tempRoot, evidenceRoot, manifest }
}

export async function recordGate(
  run: CertificationRun,
  gate: string,
  verdict: GateResult["verdict"],
  evidence: EvidenceEntry[],
  reason?: string,
): Promise<GateResult> {
  const result: GateResult = {
    gate,
    verdict,
    startedAt: Date.now(),
    completedAt: Date.now(),
    evidence,
    reason,
  }
  run.manifest.gates.push(result)
  return result
}

export async function writeEvidence(
  run: CertificationRun,
  key: string,
  content: string,
): Promise<EvidenceEntry> {
  const sha256 = createHash("sha256").update(content).digest("hex")
  const filename = `${key}-${sha256.slice(0, 12)}.txt`
  const path = join(run.evidenceRoot, filename)
  await writeFile(path, content, "utf-8")
  return { key, path, sha256, content, timestamp: Date.now() }
}

export async function finalizeRun(run: CertificationRun): Promise<string> {
  run.manifest.completedAt = Date.now()
  const manifestJson = JSON.stringify(run.manifest, null, 2)
  const sha256 = createHash("sha256").update(manifestJson).digest("hex")
  run.manifest.sha256 = sha256

  const manifestPath = join(run.evidenceRoot, `manifest-${run.runId}.json`)
  await writeFile(manifestPath, JSON.stringify(run.manifest, null, 2), "utf-8")
  return manifestPath
}

export async function cleanupRun(run: CertificationRun): Promise<void> {
  await rm(run.tempRoot, { recursive: true, force: true })
}

export function computeHash(content: string): string {
  return createHash("sha256").update(content).digest("hex")
}

export function generateTestId(): string {
  return randomBytes(8).toString("hex")
}
