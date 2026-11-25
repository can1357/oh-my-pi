/** @jsxImportSource @oh-my-pi/pi-tui */
/** The plugin selector capture builder (`settings-overlays/plugin-selector.ts`) on pi-tui. */
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import { batch, createRoot, type UiEvent, type UiNode } from "@oh-my-pi/pi-tui";
import type { PaintEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { type PluginItem, PluginSelector } from "../../../src/ui/overlays/plugins/selector";
import { type Driven, sendInput } from "../settings/harness";

const plugins: PluginItem[] = [
	{ plugin: { name: "alpha", version: "1.2.0", description: "First plugin" }, marketplace: "omp" },
	{ plugin: { name: "beta" }, marketplace: "omp", scope: "user" },
	{
		plugin: {
			name: "gamma-日本語-with-a-very-long-name",
			version: "0.0.1",
			description: "Ünïcode description that runs on and on and on past the column",
		},
		marketplace: "community",
		scope: "project",
	},
	...Array.from({ length: 25 }, (_, i) => ({ plugin: { name: `p${i}`, version: `${i}.0` }, marketplace: "bulk" })),
];

const CASES: Record<string, () => { count: number; list: PluginItem[]; installed: Set<string> }> = {
	"selector many": () => ({ count: 2, list: plugins, installed: new Set(["alpha@omp", "p3@bulk"]) }),
	"selector empty none": () => ({ count: 0, list: [], installed: new Set() }),
	"selector empty some": () => ({ count: 3, list: [], installed: new Set() }),
};

const MOUSE: Record<string, string> = {
	"mouse motion": "\x1b[<35;6;3M",
	"mouse click": "\x1b[<0;6;4M",
	"mouse release": "\x1b[<0;6;4m",
	"mouse wheel": "\x1b[<65;6;4M",
};

/** A selector case and its named steps. */
export function buildSelector(
	caseName: string,
	env: PaintEnvironment,
): { driven: Driven; step: (label: string) => boolean } {
	const spec = CASES[caseName]!();
	const root = createRoot(
		() =>
			(
				<PluginSelector
					marketplaceCount={spec.count}
					plugins={spec.list}
					installedIds={spec.installed}
					callbacks={{ onSelect: () => {}, onCancel: () => {} }}
				/>
			) as UiNode,
	);
	const picker = root.children()[0]!;
	const send = (event: UiEvent): void => batch(() => void bubbleEvent([root, picker], event));
	// The captured component took no keys (the overlay host routed them elsewhere).
	const driven: Driven = { root, key: () => {}, event: send };
	return {
		driven,
		step: label => {
			if (label === "native select") send({ type: "select", key: "picker", item: "beta@omp#user" });
			else if (label === "native activate") send({ type: "activate", key: "picker", item: "alpha@omp" });
			else if (label === "native query") send({ type: "change", key: "picker", item: "", value: "gam" });
			else if (label === "select list direct") send({ type: "select", key: "picker", item: "p2@bulk" });
			else if (MOUSE[label]) {
				// Pointer reports were routed into the component at its own coordinates.
				sendInput(env, { root }, MOUSE[label]!, 80);
			} else return false;
			return true;
		},
	};
}
