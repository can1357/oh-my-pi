import { expect, test } from "bun:test";
import type { TspPickerAction, TspPickerItem } from "@oh-my-pi/pi-wire";
import { nativeShell } from "../../helpers/native-shell";
import { isUiNode, type UiNode } from "@oh-my-pi/pi-tui";
import { firstOfKind } from "../../../src/modes/controllers/selector-views";
import {
	StandaloneSelect,
	StandaloneSelectModel,
	StandaloneText,
	type StandaloneItem,
	standaloneTextModel,
} from "../../../src/ui/apps";
import { type AppDriver, appSuite } from "./harness";

interface PickerInputs {
	readonly title: string;
	readonly items?: readonly StandaloneItem[];
	readonly options?: { currentValue?: string; maxVisible?: number; picker?: { noun?: string } };
}

const pickerNode = (d: AppDriver): UiNode | undefined => d.root.children().find(child => child.kind === "picker");

test("the standalone sheet recovers from an empty search and selects only a visible choice", async () => {
	await using ui = await nativeShell();
	const picked: string[] = [];
	const model = new StandaloneSelectModel(
		[
			{ label: "Alpha", value: "a" },
			{ label: "Beta", value: "b" },
		],
		{ maxVisible: 1, onPick: value => picked.push(value) },
	);
	const slot = ui.shell.dock.slot("composer");
	slot.set(() => StandaloneSelect({ title: "Pick", model }));
	const root = slot.view();
	if (!isUiNode(root)) throw new Error("Expected a mounted standalone prompt");
	ui.shell.focus(firstOfKind(root, "picker"));
	const picker = ui.node("picker");
	ui.type("zzz");
	expect(ui.node("picker").p.items).toEqual([]);
	ui.send({ ev: "activate", sf: ui.sf, id: picker.id, item: "b" });
	expect(picked).toEqual([]);

	// Tern adds “Clear search” to its empty result state; it's not part of the app's action bar.
	ui.send({ ev: "action", sf: ui.sf, id: picker.id, act: "clear" });
	const shown = ui.node("picker");
	expect(shown.p.query).toBe("");
	const beta = (shown.p.items as TspPickerItem[]).find(item => item.label === "Beta")!;
	ui.send({ ev: "select", sf: ui.sf, id: shown.id, item: beta.id });
	expect(picked).toEqual([]);
	const confirm = (shown.p.actions as TspPickerAction[]).find(action => action.primary)!;
	ui.send({ ev: "action", sf: ui.sf, id: shown.id, act: confirm.id });
	expect(picked).toEqual(["b"]);
});

appSuite({
	dir: "apps/standalone-picker",
	mount(caseName, corpusCase) {
		const inputs = corpusCase.inputs as PickerInputs;
		if (caseName === "text-prompt") {
			const model = standaloneTextModel({});
			return { view: () => StandaloneText({ model }) };
		}
		const model = new StandaloneSelectModel(inputs.items ?? [], {
			currentValue: inputs.options?.currentValue,
			maxVisible: inputs.options?.maxVisible,
			noun: inputs.options?.picker?.noun,
		});
		return {
			view: () => StandaloneSelect({ title: inputs.title, model }),
			focus: pickerNode,
			steps: {
				"native select v5": d => void d.emit({ type: "select", key: "", item: "v5" }),
				"native query 'Item 1'": d => void d.emit({ type: "change", key: "", item: "query", value: "Item 1" }),
				// Unfocusing only changes what the old list drew; keys still reach it.
				unfocused: d => d.env.setFocus(null),
			},
		};
	},
});
