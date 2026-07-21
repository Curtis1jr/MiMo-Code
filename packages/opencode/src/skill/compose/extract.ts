import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Path as GlobalPath } from "@/global"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { Log } from "@/util"
import { loadComposeBundle } from "./bundle.macro" with { type: "macro" }
import { loadComposeBundle as loadComposeBundleDev } from "./bundle.macro"

/// Bun macros only resolve in the static import graph of an entry point.
/// In dynamic import() chains (e.g. plugin tests), the macro is unavailable —
/// fall back to a normal runtime import of the same function.
/// `typeof loadComposeBundle` is always "undefined" even after macro expansion
/// (Bun replaces the call site, not the binding), so use try/catch instead.
function safeLoadComposeBundle() {
  try {
    return loadComposeBundle()
  } catch(e) {
    if (e instanceof ReferenceError) {
      return loadComposeBundleDev()
    }
    throw e
  }
}
const COMPOSE_BUNDLE = safeLoadComposeBundle()

const log = Log.create({ service: "skill.compose" })

export const extractComposeBundle = Effect.fn("Skill.extractComposeBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const root = path.join(GlobalPath.data, "compose", InstallationVersion)
  const skillsRoot = path.join(root, "skills")
  const marker = path.join(root, ".extracted")

  if (!InstallationLocal && (yield* fsys.existsSafe(marker))) return root

  // Local dev channel re-extracts every start (no marker gate). Wipe first
  // so orphans from previous bundle layouts (skills renamed, split, or
  // removed — e.g. this branch's 14→3 collapse plus grill/docs/dev →
  // compose-grill/compose-spec/compose-dev rename) don't linger.
  //
  // Known dev-only edge case: two mimo dev processes starting within the
  // same tens-of-ms window can transiently see a partial skill set (one
  // process wipes while the other reads). Accepted — bundle bytes are
  // built into the binary so any final state converges, and the next
  // startup self-heals. Not worth a flock for a channel release builds
  // never touch.
  if (InstallationLocal && (yield* fsys.existsSafe(skillsRoot))) {
    yield* fsys.remove(skillsRoot, { recursive: true, force: true })
  }

  for (const [skillName, files] of Object.entries(COMPOSE_BUNDLE)) {
    const skillDir = path.join(skillsRoot, skillName)
    for (const [relPath, content] of Object.entries(files)) {
      yield* fsys.writeWithDirs(path.join(skillDir, relPath), content)
    }
  }
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted compose skills", { root })
  return root
})

