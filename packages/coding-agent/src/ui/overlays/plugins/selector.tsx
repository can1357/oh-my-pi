/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The marketplace plugin selector: every plugin the configured marketplaces
 * offer (version, install state and scope as badges), picking one installs
 * it. A Tern terminal draws the picker sheet; the terminal draws the
 * `plugins` look.
 */
import { type JSXNode, signal, type UiEvent } from "@oh-my-pi/pi-tui";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import "../../styles/settings/plugin-selector";
import { closeAction, pickerAction } from "../pickers/select-sheet";
import { confirmKbd } from "../../keys/hints";

/** A plugin a marketplace offers. */
export interface PluginItem {
	readonly plugin: { readonly name: string; readonly version?: string; readonly description?: string };
	readonly marketplace: string;
	/** The install scope this entry stands for (appended to its label, passed to `onSelect`). */
	readonly scope?: "user" | "project";
}

export interface PluginSelectorCallbacks {
	onSelect(pluginName: string, marketplace: string, scope?: "user" | "project"): void;
	onCancel(): void;
}

const EMPTY = "__empty__";

/** `name@marketplace[#scope]` → its parts. */
function splitPluginId(id: string): [string, string, "user" | "project" | undefined] | undefined {
	const hash = id.indexOf("#");
	const base = hash >= 0 ? id.slice(0, hash) : id;
	const scope = hash >= 0 ? (id.slice(hash + 1) as "user" | "project") : undefined;
	const at = base.lastIndexOf("@");
	if (at <= 0) return undefined;
	return [base.slice(0, at), base.slice(at + 1), scope];
}

export function PluginSelector(props: {
	marketplaceCount: number;
	plugins: readonly PluginItem[];
	installedIds: ReadonlySet<string>;
	callbacks: PluginSelectorCallbacks;
}): JSXNode {
	const items: TspPickerItem[] = [];
	const labels: Record<string, { label: string; detail?: string }> = {};
	for (const { plugin, marketplace, scope } of props.plugins) {
		const id = scope ? `${plugin.name}@${marketplace}#${scope}` : `${plugin.name}@${marketplace}`;
		const installed = props.installedIds.has(`${plugin.name}@${marketplace}`);
		const badges: NonNullable<TspPickerItem["badges"]> = [
			...(plugin.version ? [{ text: plugin.version }] : []),
			...(installed ? [{ text: "installed", tone: "success" as const }] : []),
			...(scope ? [{ text: scope, tone: "accent" as const }] : []),
		];
		items.push({
			id,
			label: plugin.name,
			...(plugin.description ? { detail: plugin.description } : {}),
			badges,
			facts: { marketplace },
		});
		labels[id] = {
			label: `${plugin.name}${plugin.version ? `@${plugin.version}` : ""}${installed ? " [installed]" : ""}${scope ? ` [${scope}]` : ""}`,
			detail: plugin.description,
		};
	}
	if (items.length === 0) {
		const detail =
			props.marketplaceCount === 0
				? "Add a marketplace first: /marketplace add <source>"
				: "Configured marketplaces have no plugins";
		items.push({ id: EMPTY, label: "No plugins available", detail, disabled: true });
		labels[EMPTY] = { label: "No plugins available", detail };
	}
	const selected = signal(items[0]!.id);
	const pick = (id: string): void => {
		const parts = splitPluginId(id);
		if (parts) props.callbacks.onSelect(parts[0], parts[1], parts[2]);
	};
	const onEvent = (event: UiEvent): void => {
		if (event.type === "select" && items.some(item => item.id === event.item)) selected.set(event.item);
		else if (event.type === "activate" && items.some(item => item.id === event.item)) {
			selected.set(event.item);
			if (event.item !== EMPTY) pick(event.item);
		} else if (event.type === "action" && event.act === "close") props.callbacks.onCancel();
		else if (event.type === "action" && event.act === "confirm" && selected() !== EMPTY) pick(selected());
	};
	return (
		<col>
			<picker
				key="picker"
				title="Plugins"
				icon="plus"
				noun="plugins"
				size="md"
				layout="rows"
				preview="none"
				query={null}
				selected={selected}
				confirm={null}
				items={items}
				columns={[{ id: "marketplace", format: "dim" }]}
				actions={[pickerAction("confirm", "Install", confirmKbd(), { primary: true }), closeAction()]}
				term={{ look: "plugins", labels }}
				onEvent={onEvent}
			/>
		</col>
	);
}
