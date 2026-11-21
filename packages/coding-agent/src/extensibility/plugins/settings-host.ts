import type { PluginSettingsHost } from "@oh-my-pi/pi-tui/overlays/plugin-settings";
import { clearPluginRootsAndCaches, resolveOrDefaultProjectRegistryPath } from "../../discovery/helpers";
import { PluginManager } from "./manager";
import {
	getInstalledPluginsRegistryPath,
	getMarketplacesCacheDir,
	getMarketplacesRegistryPath,
	getPluginsCacheDir,
	MarketplaceManager,
	parsePluginId,
} from "./marketplace";

/** Creates host-owned plugin managers for the settings overlay. */
export function createPluginSettingsHost(cwd: string): PluginSettingsHost {
	return {
		manager: new PluginManager(cwd),
		async createMarketplaceManager() {
			return new MarketplaceManager({
				marketplacesRegistryPath: getMarketplacesRegistryPath(),
				installedRegistryPath: getInstalledPluginsRegistryPath(),
				projectInstalledRegistryPath: await resolveOrDefaultProjectRegistryPath(cwd),
				marketplacesCacheDir: getMarketplacesCacheDir(),
				pluginsCacheDir: getPluginsCacheDir(),
				clearPluginRootsCache: clearPluginRootsAndCaches,
			});
		},
		parsePluginId,
	};
}
