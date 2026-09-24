/**
 * Interactive marketplace plugin selector.
 *
 * Shows available plugins from all configured marketplaces in a SelectList.
 * Selecting a plugin opens an interactive confirmation list. Esc cancels.
 */
import { type SelectItem, SelectList, type SgrMouseEvent } from "../index";
import { Text } from "../components/text";
import { getSelectListTheme } from "../theme/theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { routeSelectListMouseWithTopBorder } from "../chrome/select-list-mouse-routing";

export interface PluginSelectorCallbacks {
	onSelect: (pluginName: string, marketplace: string, scope?: "user" | "project") => void;
	onCancel: () => void;
}

export interface PluginItem {
	plugin: { name: string; version?: string; description?: string };
	marketplace: string;
	/** Scope of this entry. When set, appended to the label and forwarded to onSelect. */
	scope?: "user" | "project";
	/** Details shown in a separate interactive confirmation list before `onSelect`. */
	confirmation?: string;
}

export class PluginSelectorComponent extends OverlayPanel {
	#pluginList: SelectList;
	#selectList: SelectList;
	#callbacks: PluginSelectorCallbacks;
	#confirmationText: Text | undefined;
	#confirmationTextRows = 0;

	constructor(
		marketplaceCount: number,
		plugins: PluginItem[],
		installedRows: Set<string>,
		callbacks: PluginSelectorCallbacks,
	) {
		super("Plugins");
		this.#callbacks = callbacks;

		const confirmations = new Map<string, string>();
		const items: SelectItem[] = plugins.map(({ plugin, marketplace, scope, confirmation }) => {
			// Encode scope into the value so onSelect can recover it without a parallel Map.
			// Format: "name@marketplace" or "name@marketplace#scope"
			const id = scope ? `${plugin.name}@${marketplace}#${scope}` : `${plugin.name}@${marketplace}`;
			const installed = installedRows.has(id);
			const version = plugin.version ? `@${plugin.version}` : "";
			const status = installed ? " [installed]" : "";
			const scopeTag = scope ? ` [${scope}]` : "";

			if (confirmation) confirmations.set(id, confirmation);
			return {
				value: id,
				label: `${plugin.name}${version}${scopeTag}${status}`,
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
				disabled: true,
			});
		}

		this.#pluginList = new SelectList(items, Math.min(items.length, 20), getSelectListTheme());
		this.#selectList = this.#pluginList;
		this.#pluginList.onSelect = item => {
			const [name, marketplace, scope] = splitPluginId(item.value);
			if (!name || !marketplace) return;
			const confirmation = confirmations.get(item.value);
			if (confirmation) {
				this.#showConfirmation(confirmation, name, marketplace, scope);
				return;
			}
			callbacks.onSelect(name, marketplace, scope);
		};
		this.#pluginList.onCancel = () => callbacks.onCancel();
		this.addChild(this.#pluginList);
	}

	handleInput(keyData: string): void {
		this.#selectList.handleInput(keyData);
	}

	getSelectList(): SelectList {
		return this.#selectList;
	}
	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#confirmationText) {
			this.#selectList.routeMouse(event, line - 1 - this.#confirmationTextRows, col);
		} else {
			routeSelectListMouseWithTopBorder(this.#selectList, event, line, col);
		}
	}

	override render(width: number): readonly string[] {
		this.#confirmationTextRows = this.#confirmationText?.render(Math.max(1, width - 4)).length ?? 0;
		return super.render(width);
	}

	#showConfirmation(message: string, pluginName: string, marketplace: string, scope?: "user" | "project"): void {
		const uninstall = message.startsWith("Uninstall ");
		this.title = uninstall ? "Confirm plugin uninstall" : "Confirm plugin install";
		this.clear();
		this.#confirmationText = new Text(`${message}\n\n↑/↓ choose · Enter confirm · Esc back`, 0, 0);
		this.addChild(this.#confirmationText);

		const items: SelectItem[] = [
			{ value: "confirm", label: "Confirm" },
			{ value: "cancel", label: "Cancel" },
		];
		this.#selectList = new SelectList(items, items.length, getSelectListTheme());
		this.#selectList.onSelect = item => {
			if (item.value === "confirm") {
				this.#callbacks.onSelect(pluginName, marketplace, scope);
			} else {
				this.#showPluginList();
			}
		};
		this.#selectList.onCancel = () => this.#showPluginList();
		this.addChild(this.#selectList);
	}

	#showPluginList(): void {
		this.title = "Plugins";
		this.clear();
		this.#confirmationText = undefined;
		this.#confirmationTextRows = 0;
		this.#selectList = this.#pluginList;
		this.addChild(this.#pluginList);
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
