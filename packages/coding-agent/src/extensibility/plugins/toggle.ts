import type { PluginManager } from "./manager";
import type { MarketplaceManager } from "./marketplace/manager";

/** Toggle an installed marketplace or npm plugin using the same precedence as the CLI. */
export async function setInstalledPluginEnabled(
	name: string,
	options: {
		enabled: boolean;
		scope?: "user" | "project";
		marketplaceIds: ReadonlySet<string>;
		marketplace: MarketplaceManager;
		npm: PluginManager;
	},
): Promise<void> {
	if (options.marketplaceIds.has(name)) {
		await options.marketplace.setPluginEnabled(name, options.enabled, options.scope);
	} else {
		await options.npm.setEnabled(name, options.enabled);
	}
}
