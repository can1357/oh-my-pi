/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * Vim in the hook editor's box (upstream's HookEditorComponent `vimMode`): Escape leaves Insert
 * mode before it cancels the dialog, Normal-mode commands edit the box, `u` and Ctrl+R step its
 * own undo history, and the box opens in the start mode.
 */
import { describe, expect, test } from "bun:test";
import { createRoot, resolveChildren, type UiNode } from "@oh-my-pi/pi-tui";
import { decodeInput } from "@oh-my-pi/pi-tui/driver/input/decoder";
import type { DialogVim } from "../../../../src/ui/composer/vim-editor";
import { HookEditor } from "../../../../src/ui/overlays/panels/hook-dialogs";
import { sendKey } from "../../composer/harness";

function findKind(root: UiNode, kind: string): UiNode | undefined {
	if (root.kind === kind) return root;
	for (const child of root.children()) {
		const hit = findKind(child, kind);
		if (hit) return hit;
	}
	return undefined;
}

function hookEditor(prefill: string, vim: DialogVim | undefined) {
	const cancelled: string[] = [];
	const submitted: string[] = [];
	const root = createRoot(
		() =>
			resolveChildren(() => (
				<HookEditor
					title="Edit the message"
					prefill={prefill}
					vim={vim}
					onSubmit={text => submitted.push(text)}
					onCancel={text => cancelled.push(text)}
				/>
			))()[0]!,
	);
	const field = findKind(root, "editor")!;
	return {
		cancelled,
		submitted,
		press(raw: string) {
			for (const event of decodeInput(raw, { kitty: true }))
				if (event.type === "key") sendKey(root, field, event.key);
		},
		text: (): string => {
			const props = field.props();
			return "text" in props && typeof props.text === "string" ? props.text : "";
		},
		mode: (): string | undefined => {
			const props = field.props();
			return "mode" in props && typeof props.mode === "string" ? props.mode : undefined;
		},
	};
}

describe("hook editor Vim mode", () => {
	test("Escape leaves Insert mode first; only a quiet Normal mode cancels", () => {
		const box = hookEditor("draft", {});
		box.press("\x1b");
		expect(box.mode()).toBe("NORMAL");
		expect(box.cancelled).toEqual([]);
		box.press("d");
		box.press("\x1b");
		// The second Escape only cancelled the half-typed `d`.
		expect(box.cancelled).toEqual([]);
		box.press("\x1b");
		expect(box.cancelled).toEqual(["draft"]);
	});

	test("Normal-mode commands edit the box; u and Ctrl+R step its undo history", () => {
		const box = hookEditor("alpha beta", { startMode: () => "normal" });
		expect(box.mode()).toBe("NORMAL");
		box.press("0dw");
		expect(box.text()).toBe("beta");
		box.press("u");
		expect(box.text()).toBe("alpha beta");
		box.press("\x12");
		expect(box.text()).toBe("beta");
		// No command menu here: `:` leaves the box alone.
		box.press(":");
		expect(box.text()).toBe("beta");
	});

	test("yanks reach the app's clipboard hook", () => {
		const yanked: string[] = [];
		const box = hookEditor("one", { startMode: () => "normal", onYank: text => yanked.push(text) });
		box.press("yy");
		expect(yanked).toEqual(["one\n"]);
	});

	test("without Vim, Escape cancels at once", () => {
		const box = hookEditor("draft", undefined);
		box.press("\x1b");
		expect(box.cancelled).toEqual(["draft"]);
		expect(box.mode()).toBeUndefined();
	});
});
