/**
 * Plugin configuration.
 *
 * @module
 */

import z from '@deepseek-ai/schemastery'

/** How a write action is authorized before it reaches the operating system. */
export type WriteApprovalMode =
  /** Ask the user for every write call. */
  | 'always'
  /** Ask once per session and per tool, then stop asking. */
  | 'session'
  /** Never ask; the session's own permission preset is the only gate. */
  | 'never'

/** Configuration for the Computer Use plugin. */
export interface Config {
  /**
   * Absolute path to the `cua-engine` executable. Omit to use the binary
   * shipped beside this package, which is what `pnpm run build` produces.
   */
  enginePath?: string
  /**
   * How long an idle engine process stays alive, in milliseconds. `0` keeps one
   * engine for the whole host lifetime. The engine is cheap to start but the
   * first accessibility query is not, so the default favors reuse.
   */
  idleShutdownMs?: number
  /**
   * Authorization required for input synthesis and other state-changing
   * actions. Reads (status, app and window listing, UI trees, screenshots) are
   * never gated here: they are already gated by macOS, and asking on every read
   * would make the loop unusable.
   */
  writeApproval?: WriteApprovalMode
  /**
   * Directory for screenshot files. Omit for the operating system's temporary
   * directory; a project directory keeps captures beside the work that made
   * them.
   */
  screenshotDir?: string
  /**
   * Maximum accepted capture size in pixels per side, handed to the engine.
   * Larger values cost model tokens; smaller values lose detail.
   */
  maxCaptureDimension?: number
}

/** Runtime configuration schema for the Computer Use plugin. */
export const Config: z<Config> = z.object({
  enginePath: z.string(),
  idleShutdownMs: z.natural().default(600_000),
  writeApproval: z.union(['always', 'session', 'never'] as const).default('always'),
  screenshotDir: z.string(),
  maxCaptureDimension: z.natural().min(64).max(8192).default(1568),
})
