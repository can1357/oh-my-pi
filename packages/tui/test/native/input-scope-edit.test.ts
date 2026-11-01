import { afterEach, describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Container } from "@oh-my-pi/pi-tui";
import { Editor } from "@oh-my-pi/pi-tui/components/editor";
import { bindInputScope, type ToolRendererScope } from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { defaultEditorTheme } from "../test-themes";
import { TspHarness } from "./tsp-harness";

/**
 * A native terminal sends the user's typing as `edit` events addressed to the editor that described
 * the node. An extension's replaced editor whose session has gone in that moment is taken out of
 * input first; the event reaches what the host put in its place — its own editor, holding the same
 * text — so the character is not lost, and nothing of the extension's runs.
 */

let harness: TspHarness | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
});

function ownedScope() {
	let live = true;
	const context = new AsyncLocalStorage<true>();
	const scope: ToolRendererScope = {
		get live() {
			return live;
		},
		run<T>(call: () => T): T {
			if (!live) throw new Error("scope retired");
			return context.run(true, call);
		},
	};
	return { scope, inside: () => context.getStore() === true, retire: () => (live = false) };
}

describe("a native edit addressed to a retired extension editor", () => {
	it("reaches the host editor that replaced it, with the same text, and runs nothing of the extension's", async () => {
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		class ExtensionEditor extends Editor {
			override handleNativeEvent(...args: Parameters<Editor["handleNativeEvent"]>): void {
				calls.push(["handleNativeEvent", owner.inside()]);
				super.handleNativeEvent(...args);
			}
		}
		const extension = new ExtensionEditor(defaultEditorTheme);
		extension.setText("draft");
		const slot = new Container();
		slot.addChild(extension);
		const host = new Editor(defaultEditorTheme);
		harness = await TspHarness.start(tui => {
			tui.addChild(slot);
			bindInputScope(extension, owner.scope, () => {
				host.setText(Editor.prototype.getText.call(extension));
				slot.clear();
				slot.addChild(host);
				tui.setFocus(host);
				return host;
			});
			tui.setFocus(extension);
		});
		const h = harness;
		const node = h.find(n => n.k === "editor")!;
		const sf = h.terminal.surface!;
		h.event({ ev: "edit", sf, id: node.id, from: 5, to: 5, text: "!", cursor: 6, len: 5 });
		expect(Editor.prototype.getText.call(extension)).toBe("draft!");
		expect(calls).toEqual([["handleNativeEvent", true]]);

		calls.length = 0;
		owner.retire();
		h.event({ ev: "edit", sf, id: node.id, from: 6, to: 6, text: "?", cursor: 7, len: 6 });
		expect(calls).toEqual([]);
		expect(host.getText()).toBe("draft!?");
	});

	it("reaches the host editor after a frame has dropped the retired one's node", async () => {
		const owner = ownedScope();
		const calls: Array<[string, boolean]> = [];
		class ExtensionEditor extends Editor {
			override handleNativeEvent(...args: Parameters<Editor["handleNativeEvent"]>): void {
				calls.push(["handleNativeEvent", owner.inside()]);
				super.handleNativeEvent(...args);
			}
		}
		const extension = new ExtensionEditor(defaultEditorTheme);
		extension.setText("draft");
		const slot = new Container();
		slot.addChild(extension);
		const host = new Editor(defaultEditorTheme);
		harness = await TspHarness.start(tui => {
			tui.addChild(slot);
			bindInputScope(extension, owner.scope, () => {
				host.setText(Editor.prototype.getText.call(extension));
				slot.clear();
				slot.addChild(host);
				tui.setFocus(host);
				return host;
			});
			tui.setFocus(extension);
		});
		const h = harness;
		const sf = h.terminal.surface!;
		const oldId = h.find(n => n.k === "editor")!.id;
		owner.retire();
		// The frame that swaps the host's editor in drops the old node before the terminal's
		// edit, typed against what it last showed, arrives.
		await h.render();
		const currentId = h.find(n => n.k === "editor")!.id;
		expect(currentId).not.toBe(oldId);
		expect(h.byId(oldId)).toBeFalsy();

		h.event({ ev: "edit", sf, id: oldId, from: 5, to: 5, text: "!", cursor: 6, len: 5 });
		expect(calls).toEqual([]);
		expect(host.getText()).toBe("draft!");
	});
});
