/**
 * Process-wide unpaused-provider overrides for paused OAuth providers.
 *
 * Kept separate from the full OAuth provider registry so settings modules can
 * wire `setUnpausedProviders` without importing provider login engines.
 */
import { providerDisabledReason } from "@oh-my-pi/pi-catalog/compat/auth";

/** Paused provider ids the end user turned back on (see {@link setUnpausedProviders}). */
let unpausedProviders: ReadonlySet<string> = new Set();

/** Bumped whenever {@link providerPauseReason} may answer differently for some id. */
let pauseRevision = 0;

/**
 * Counter that moves whenever which providers are paused may have changed: the
 * unpaused list, or an extension login taking or releasing a paused id. Caches
 * that filter on {@link providerPauseReason} compare it to know when to refilter.
 */
export function providerPauseRevision(): number {
	return pauseRevision;
}

/** Bumps {@link pauseRevision} when `provider` is one the auth rules pause. */
export function notePauseOverride(provider: string): void {
	if (providerDisabledReason(provider) !== undefined) pauseRevision++;
}

/** Whether `provider` was explicitly unpaused via {@link setUnpausedProviders}. */
export function isProviderUnpaused(provider: string): boolean {
	return unpausedProviders.has(provider);
}

/**
 * Turns paused providers back on: each listed id ignores its `disabled "<reason>"`
 * auth rule, so it is a login choice again and its stored or env credentials resolve.
 * Replaces the previous list; ids that are not paused are ignored. Loaded credential
 * pools pick the change up on their next read.
 */
export function setUnpausedProviders(providers: Iterable<string>): void {
	const next = new Set(providers);
	if (next.size === unpausedProviders.size && [...next].every(provider => unpausedProviders.has(provider))) return;
	unpausedProviders = next;
	pauseRevision++;
}
