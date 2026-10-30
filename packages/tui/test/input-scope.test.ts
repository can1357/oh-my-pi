import { describe, expect, it } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { type AutocompleteProvider, type Component, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import {
	bindInputScope,
	scopedAutocompleteProvider,
	type ToolRendererScope,
} from "@oh-my-pi/pi-tui/tools/renderer-scope";
import { VirtualTerminal } from "./virtual-terminal";

/**
 * A component an extension supplied that takes the user's keystrokes — a `custom` dialog, a
 * replaced editor — is registered with its session's scope (`bindInputScope`). The TUI hands it
 * input and focus inside that scope, and once the scope has gone takes it out of input through the
 * host's `retire` before anything of it runs: `capturesInput` and its focus flag included.
 */

interface OwnedScope {
	readonly scope: ToolRendererScope;
	inside(): boolean;
	retire(): void;
}

/** A scope like a session's admission: async work started inside it stays inside it. */
function ownedScope(): OwnedScope {
	let live = true;
	const context = new AsyncLocalStorage<true>();
	return {
		scope: {
			get live() {
				return live;
			},
			run<T>(call: () => T): T {
				if (!live) throw new Error("scope retired");
				return context.run(true, call);
			},
		},
		inside: () => context.getStore() === true,
		retire: () => {
			live = false;
		},
	};
}

/** The host's own input owner: what keeps the keys once a dialog closes. */
class HostInput implements Component {
	typed = "";
	render(): readonly string[] {
		return [`host ${this.typed}`];
	}
	invalidate(): void {}
	handleInput(data: string): void {
		this.typed += data;
	}
}

/** An extension's dialog that records each call into it, and whether it ran inside `owner`. */
class ExtensionDialog implements Component, Focusable {
	readonly calls: Array<[string, boolean]> = [];
	#focused = false;
	constructor(readonly owner: OwnedScope) {}
	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.calls.push([`focused=${value}`, this.owner.inside()]);
		this.#focused = value;
	}
	render(): readonly string[] {
		return ["dialog"];
	}
	invalidate(): void {}
	capturesInput(): boolean {
		this.calls.push(["capturesInput", this.owner.inside()]);
		return false;
	}
	handleInput(data: string): void {
		this.calls.push([`handleInput:${data}`, this.owner.inside()]);
	}
}

describe("TUI input dispatch to a component an extension supplied", () => {
	function setUp() {
		const tui = new TUI(new VirtualTerminal(80, 24));
		const host = new HostInput();
		tui.addChild(host);
		tui.setFocus(host);
		const owner = ownedScope();
		const dialog = new ExtensionDialog(owner);
		let retired = 0;
		bindInputScope(dialog, owner.scope, () => {
			retired++;
			handle.hide();
		});
		const handle = tui.showOverlay(dialog);
		return { tui, host, owner, dialog, retired: () => retired };
	}

	it("hands a live dialog focus and input inside its scope", () => {
		const { tui, dialog } = setUp();
		expect(tui.getFocused()).toBe(dialog);
		tui.injectDebugInput("x");
		expect(dialog.calls.map(([where]) => where)).toEqual(["focused=true", "capturesInput", "handleInput:x"]);
		expect(dialog.calls.filter(([, inside]) => !inside)).toEqual([]);
	});

	it("once the scope has gone, closes the dialog before capturesInput and gives the key to the host", () => {
		const { tui, host, owner, dialog, retired } = setUp();
		dialog.calls.length = 0;
		owner.retire();
		tui.injectDebugInput("y");
		expect(retired()).toBe(1);
		expect(dialog.calls).toEqual([]);
		expect(tui.getFocused()).toBe(host);
		expect(host.typed).toBe("y");
		tui.injectDebugInput("z");
		expect(retired()).toBe(1);
		expect(host.typed).toBe("yz");
	});

	it("once the scope has gone, a frame closes the dialog before drawing it", () => {
		const { tui, host, owner, dialog, retired } = setUp();
		dialog.calls.length = 0;
		owner.retire();
		tui.renderNow();
		expect(retired()).toBe(1);
		expect(dialog.calls).toEqual([]);
		expect(tui.getFocused()).toBe(host);
	});
});

describe("an extension's autocomplete provider, mounted through its scope", () => {
	function hostProvider(label: string): AutocompleteProvider {
		return {
			async getSuggestions() {
				return { items: [{ value: label, label }], prefix: "" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return { lines: [...lines, label], cursorLine, cursorCol };
			},
		};
	}

	it("runs each call inside the scope and copies what it answers there", async () => {
		const owner = ownedScope();
		const reads: boolean[] = [];
		let applied = 0;
		const extension: AutocompleteProvider = {
			async getSuggestions() {
				const item = {
					value: "ext",
					get label() {
						reads.push(owner.inside());
						return "ext";
					},
				};
				return { items: [item], prefix: "" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				return {
					lines: [...lines, "ext"],
					cursorLine,
					cursorCol,
					onApplied: () => {
						reads.push(owner.inside());
						applied++;
					},
				};
			},
		};
		const provider = scopedAutocompleteProvider(extension, hostProvider("host"), owner.scope, () => {});
		const suggestions = await provider.getSuggestions(["x"], 0, 1);
		expect(suggestions).toEqual({ items: [{ value: "ext", label: "ext" }], prefix: "" });
		const completion = provider.applyCompletion(["x"], 0, 1, { value: "ext", label: "ext" }, "");
		expect(completion.lines).toEqual(["x", "ext"]);
		completion.onApplied?.();
		expect(applied).toBe(1);
		expect(reads).toEqual([true, true]);

		owner.retire();
		completion.onApplied?.();
		expect(applied).toBe(1);
	});

	it("once the scope has gone, completes with the provider it wrapped and tells the host once", async () => {
		const owner = ownedScope();
		let asked = 0;
		let told = 0;
		const extension: AutocompleteProvider = {
			async getSuggestions() {
				asked++;
				return { items: [], prefix: "" };
			},
			applyCompletion(lines, cursorLine, cursorCol) {
				asked++;
				return { lines, cursorLine, cursorCol };
			},
		};
		const provider = scopedAutocompleteProvider(extension, hostProvider("host"), owner.scope, () => told++);
		owner.retire();
		expect(await provider.getSuggestions(["x"], 0, 1)).toEqual({
			items: [{ value: "host", label: "host" }],
			prefix: "",
		});
		expect(provider.applyCompletion(["x"], 0, 1, { value: "host", label: "host" }, "").lines).toEqual(["x", "host"]);
		expect(asked).toBe(0);
		expect(told).toBe(1);
	});
});
