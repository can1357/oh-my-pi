/**
 * Judge for commands that run outside an agent session (`omp find`, `omp stats`,
 * the git TUI's AI staging): project settings, a fresh auth store, the model
 * registry, and CLI extension providers, resolved the same way everywhere.
 */
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { type ChainJudge, resolveJudge, sharedJudgmentCache } from ".";

export interface StandaloneJudge {
	judge: ChainJudge;
	/** Release the auth store; the judge must not be used afterwards. */
	close(): void;
}

/**
 * Resolve the `judge` role chain for `cwd`'s project settings and extensions.
 * No session ledger exists here, so `purpose` only labels telemetry; native
 * answers still go through the shared answer cache.
 */
export async function openStandaloneJudge(cwd: string, purpose: string): Promise<StandaloneJudge> {
	const settings = await Settings.init({ cwd });
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		const registry = new ModelRegistry(authStorage);
		await registry.refresh();
		await loadCliExtensionProviders(registry, settings, cwd);
		return {
			judge: resolveJudge({
				settings,
				registry,
				sessionId: Bun.randomUUIDv7(),
				purpose,
				cache: sharedJudgmentCache(),
			}),
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
