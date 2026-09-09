import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
} from "../../extensibility/plugins/marketplace";
import type { SlashCommandRuntime } from "../types";

/**
 * Build a `MarketplaceManager` wired up with the active project's registry
 * paths and the shared plugin-root cache invalidator. Reused by both `/plugins`
 * and `/marketplace` handlers so cache invalidation stays consistent.
 */
export async function createMarketplaceManager(runtime: SlashCommandRuntime): Promise<MarketplaceManager> {
	return new MarketplaceManager({
		marketplacesRegistryPath: getMarketplacesRegistryPath(),
		installedRegistryPath: getInstalledPluginsRegistryPath(),
		projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(runtime.cwd),
		marketplacesCacheDir: getMarketplacesCacheDir(),
		pluginsCacheDir: getPluginsCacheDir(),
		clearPluginRootsCache: clearPluginRootsAndCaches,
	});
}
