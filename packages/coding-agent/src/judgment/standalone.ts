/**
 * Judge for commands that run outside an agent session (`omp find`, `omp stats`,
 * the git TUI's AI staging): project settings, a fresh auth store, the model
 * registry, and CLI extension providers, resolved the same way everywhere.
 */
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { type ChainJudge, type JudgeDeps, resolveJudge, sharedJudgmentCache } from ".";

export interface StandaloneJudge {
	judge: ChainJudge;
	/** The project settings the judge was resolved from, for the command's own options. */
	settings: Settings;
	/** Another judge over the same registry, session, and cache that tries `leadModel` first. */
	leadJudge(leadModel: string): ChainJudge;
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
		const deps: JudgeDeps = {
			settings,
			registry,
			sessionId: Bun.randomUUIDv7(),
			purpose,
			cache: sharedJudgmentCache(),
		};
		return {
			judge: resolveJudge(deps),
			settings,
			leadJudge: leadModel => resolveJudge({ ...deps, leadModel }),
			close: () => authStorage.close(),
		};
	} catch (error) {
		authStorage.close();
		throw error;
	}
}
