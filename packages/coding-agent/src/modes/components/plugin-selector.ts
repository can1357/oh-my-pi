/**
 * Interactive marketplace plugin selector.
 *
 * Shows available plugins from all configured marketplaces in a SelectList.
 * Selecting a plugin triggers installation. Esc cancels.
 */
import { type SelectItem, SelectList, type SgrMouseEvent } from "@oh-my-pi/pi-tui";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "./overlay-box";
import { routeSelectListMouseWithTopBorder } from "./select-list-mouse-routing";

export interface PluginSelectorCallbacks {
	onSelect: (pluginName: string, marketplace: string, scope?: "user" | "project") => void;
	onCancel: () => void;
}

export interface PluginItem {
	plugin: { name: string; version?: string; description?: string };
	marketplace: string;
	/** Scope of this entry. When set, appended to the label and forwarded to onSelect. */
	scope?: "user" | "project";
}

export class PluginSelectorComponent extends OverlayPanel {
	#selectList: SelectList;

	constructor(
		marketplaceCount: number,
		plugins: PluginItem[],
		installedIds: Set<string>,
		callbacks: PluginSelectorCallbacks,
	) {
		super("Plugins");

		const items: SelectItem[] = plugins.map(({ plugin, marketplace, scope }) => {
			// Encode scope into the value so onSelect can recover it without a parallel Map.
			// Format: "name@marketplace" or "name@marketplace#scope"
			const id = scope ? `${plugin.name}@${marketplace}#${scope}` : `${plugin.name}@${marketplace}`;
			const installed = installedIds.has(`${plugin.name}@${marketplace}`);
			const version = plugin.version ? `@${plugin.version}` : "";
			const status = installed ? " [installed]" : "";
			const scopeTag = scope ? ` [${scope}]` : "";

			return {
				value: id,
				label: `${plugin.name}${version}${status}${scopeTag}`,
				description: plugin.description,
				hint: marketplace,
			};
		});

		if (items.length === 0) {
			items.push({
				value: "__empty__",
				label: "No plugins available",
				description:
					marketplaceCount === 0
						? "Add a marketplace first: /marketplace add <source>"
						: "Configured marketplaces have no plugins",
			});
		}

		this.#selectList = new SelectList(items, Math.min(items.length, 20), getSelectListTheme());

		this.#selectList.onSelect = item => {
			if (item.value === "__empty__") return;
			const [name, marketplace, scope] = splitPluginId(item.value);
			if (name && marketplace) {
				callbacks.onSelect(name, marketplace, scope);
			}
		};

		this.#selectList.onCancel = () => {
			callbacks.onCancel();
		};

		this.addChild(this.#selectList);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
	}
}

function splitPluginId(id: string): [string, string, "user" | "project" | undefined] | [null, null, null] {
	// value format: "name@marketplace" or "name@marketplace#scope"
	const hashIdx = id.indexOf("#");
	const base = hashIdx >= 0 ? id.slice(0, hashIdx) : id;
	const scope = hashIdx >= 0 ? (id.slice(hashIdx + 1) as "user" | "project") : undefined;
	const atIdx = base.lastIndexOf("@");
	if (atIdx <= 0) return [null, null, null];
	return [base.slice(0, atIdx), base.slice(atIdx + 1), scope];
}
