/**
 * Participation in the harness's shared computer-use capability.
 *
 * The harness owns a `computerUse` service that reserves one exclusive provider
 * slot and reports which provider holds it. This plugin drives the machine
 * through its own engine rather than through a provider package, so without
 * this module the capability reports no provider while the tools are plainly
 * mounted — the one piece of the harness's computer-use story this package did
 * not take part in.
 *
 * **Registration is optional, and the service is reached rather than injected.**
 * `inject: ['computerUse']` would make the plugin fail to load wherever the
 * service is not mounted, which is most compositions. A deployment without it
 * gets exactly the behaviour it had before this module existed.
 *
 * The capability is mirrored locally for the same reason {@link
 * import('./approval.ts').requireWriteApproval} mirrors the approval service:
 * this package must not gain a hard dependency on a harness package it may be
 * installed without. Only `register` is ever called, and the registry rejects a
 * second registration by throwing, which Cordis turns into a failed load — the
 * same fail-loud behaviour the built-in providers get.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * The provider name this package claims.
 *
 * Fixed rather than configurable: the registry's message for a duplicate
 * registration names the existing provider, and a stable name is what makes
 * that message useful.
 */
export const PROVIDER_NAME = 'cua'

/**
 * The slice of the computer-use service this plugin calls.
 *
 * The parameter is typed as a plain string even though the real signature takes
 * a branded name: a brand declared in another package is not assignable to one
 * declared here, and the brand is what makes the registry's parameter
 * *narrower*, never wider, so a string is safe to pass.
 */
interface ComputerUseCapability {
  register(name: string): () => Promise<void>
}

/**
 * Claim the computer-use provider slot, when the capability is mounted.
 *
 * @param ctx - plugin context; the service is looked up, not injected.
 * @returns `true` when the slot was claimed, `false` when nothing was mounted.
 * @throws Error when another provider already holds the slot. That is
 * deliberate: two providers would put two catalogs in front of a model, and
 * silent coexistence is the failure this registration exists to prevent.
 */
export function registerComputerUse(ctx: Context): boolean {
  const computerUse = ctx.get('computerUse') as ComputerUseCapability | undefined
  if (computerUse === undefined) return false

  // Tied to the plugin's own lifetime, so unloading the plugin releases the
  // slot instead of leaving a name reserved by nothing.
  ctx.effect(() => {
    const release = computerUse.register(PROVIDER_NAME)
    return () => { void release() }
  }, 'cua.computerUse.register()')
  return true
}
