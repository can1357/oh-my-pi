import { getProjectDir, logger } from "@oh-my-pi/pi-utils";

type MarketplaceAutoUpdateMode = "off" | "notify" | "auto";

interface MarketplaceAutoUpdateOptions {
	autoUpdate: MarketplaceAutoUpdateMode;
	resolveActiveProjectRegistryPath: (cwd: string) => Promise<string | null>;
	clearPluginRootsCache: () => void;
}

export function scheduleMarketplaceAutoUpdate(options: MarketplaceAutoUpdateOptions): void {
	if (options.autoUpdate === "off") {
		return;
	}

	void runMarketplaceAutoUpdate(options);
}

async function runMarketplaceAutoUpdate(options: MarketplaceAutoUpdateOptions): Promise<void> {
	try {
		// Startup perf: marketplace manager pulls scraper/fetch/cache code; keep it out of the initial TUI graph.
		const {
			MarketplaceManager,
			getInstalledPluginsRegistryPath,
			getMarketplacesCacheDir,
			getMarketplacesRegistryPath,
			getPluginsCacheDir,
		} = await import("./marketplace");
		const mgr = new MarketplaceManager({
			marketplacesRegistryPath: getMarketplacesRegistryPath(),
			installedRegistryPath: getInstalledPluginsRegistryPath(),
			projectInstalledRegistryPath: (await options.resolveActiveProjectRegistryPath(getProjectDir())) ?? undefined,
			marketplacesCacheDir: getMarketplacesCacheDir(),
			pluginsCacheDir: getPluginsCacheDir(),
			clearPluginRootsCache: options.clearPluginRootsCache,
		});
		await mgr.refreshStaleMarketplaces();
		const updates = await mgr.checkForUpdates();
		if (updates.length === 0) return;
		if (options.autoUpdate === "auto") {
			await mgr.upgradeAllPlugins();
			logger.debug(`Auto-upgraded ${updates.length} marketplace plugin(s)`);
		} else {
			logger.debug(`${updates.length} marketplace plugin update(s) available — /marketplace upgrade`);
		}
	} catch {
		// Silently ignore — network failure, corrupt data, offline.
	}
}
