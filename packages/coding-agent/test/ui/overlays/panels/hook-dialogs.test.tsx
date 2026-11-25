/** @jsxImportSource @oh-my-pi/pi-tui */
import { expect, test } from "bun:test";
import { signal } from "@oh-my-pi/pi-tui";
import type { HookEditorOptions } from "../../../../src/modes/view-model/overlays/hook-editor";
import {
	HookEditor,
	type HookEditorHandle,
	HookInput,
	type HookInputOptions,
} from "../../../../src/ui/overlays/panels/hook-dialogs";
import { nativeShell } from "../../../helpers/native-shell";
import { mountOverlay } from "../../../helpers/overlay-terminal";
import { type Driver, panelSuite } from "./harness";

const noop = (): void => {};
const action = (act: string) => (d: Driver) => void d.emit({ type: "action", key: "", act, mods: [] });

const INPUTS: Record<string, [string, string | undefined, HookInputOptions | undefined]> = {
	basic: ["Enter a name", "e.g. alice", undefined],
	"multiline-title": ["Pick a branch\nThe branch is created from main.\n\nKeep it short.", undefined, undefined],
	secret: ["API key", "  ", { secret: true }],
	timeout: ["Answer quickly\ndetail", "ph", { timeout: 30_000 }],
	"empty-title": ["", undefined, undefined],
	"long-title": [
		"A very long title that will not fit into the border of a narrow panel at all, ünïcödé 日本語",
		undefined,
		{ timeout: 9_000, secret: true },
	],
	"submit-empty-then-type": ["Q", undefined, undefined],
};

panelSuite({
	dir: "overlays/hook-input",
	mount(caseName) {
		const [title, placeholder, options] = INPUTS[caseName]!;
		return {
			view: () => (
				<HookInput title={title} placeholder={placeholder} options={options} onSubmit={noop} onCancel={noop} />
			),
			focus: d => d.find("input"),
			steps: {
				paste: d => d.paste("pasted ünïcödé text that is rather long and keeps going"),
				"time passes": noop,
				"native submit": action("submit"),
				"native cancel": action("cancel"),
				"native other": d => void d.emit({ type: "select", key: "", item: "x" }),
			},
		};
	},
});

test("Other answer: native Undo restores the replaced range and its caret, ignoring a later caret-only edit", async () => {
	await using ui = await nativeShell();
	ui.shell.overlays.show(() => (
		<HookEditor title="Other" options={{ promptStyle: true }} prefill="draft" onSubmit={noop} onCancel={noop} />
	));
	const { id } = ui.node("editor");
	const sf = ui.sf;
	ui.send({ ev: "edit", sf, id, from: 0, to: 0, text: "", len: 5, cursor: 2 });
	ui.send({ ev: "edit", sf, id, from: 1, to: 4, text: "one", len: 5, cursor: 4 });
	expect(ui.node("editor").p).toMatchObject({ text: "donet", cursor: 4 });
	ui.send({ ev: "edit", sf, id, from: 0, to: 0, text: "", len: 5, cursor: 0 });
	ui.send({ ev: "undo", sf, id });
	expect(ui.node("editor").p).toMatchObject({ text: "draft", cursor: 2 });
});

test("the terminal prompt undoes a typed word as one unit, then the preceding paste", () => {
	let submitted: string | undefined;
	const terminal = mountOverlay(
		() => (
			<HookEditor
				title="Other"
				options={{ promptStyle: true }}
				prefill="draft"
				onSubmit={answer => {
					submitted = answer;
				}}
				onCancel={noop}
			/>
		),
		{ focusKind: "editor" },
	);
	try {
		terminal.paste(" answer: ");
		terminal.type("hello");
		terminal.press("ctrl+-");
		expect(terminal.surface.focused()?.props()).toMatchObject({ text: "draft answer: " });
		terminal.press("ctrl+-");
		terminal.press("enter");
		expect(submitted).toBe("draft");
	} finally {
		terminal.dispose();
	}
});

const EDITORS: Record<string, [string, string | undefined, HookEditorOptions | undefined]> = {
	hook: ["Edit the message", "prefilled\ntext", undefined],
	"hook-multiline-title": [
		"Title line\ndetail one\ndetail two ünïcödé",
		undefined,
		{ externalEditor: async () => "ext" },
	],
	"prompt-style": ["Other", undefined, { promptStyle: true, acceptImages: true }],
	question: [
		"Custom answer",
		"",
		{
			promptStyle: true,
			question: "Which database should the service use for the long-term storage of events?\tAnd why?\r\nExplain.",
			externalEditor: async () => null,
		},
	],
	"max-height": ["Short", "1\n2\n3\n4\n5\n6\n7\n8\n9\n10", { maxHeight: 3 }],
	"empty-title": ["", undefined, undefined],
};

panelSuite({
	dir: "overlays/hook-editor",
	mount(caseName) {
		const [title, prefill, options] = EDITORS[caseName]!;
		const terminalCursor = signal(false);
		let handle!: HookEditorHandle;
		return {
			view: () => (
				<HookEditor
					title={title}
					prefill={prefill}
					options={options}
					terminalCursor={terminalCursor}
					onSubmit={noop}
					onCancel={noop}
					ref={h => void (handle = h)}
				/>
			),
			focus: d => d.find("editor"),
			steps: {
				paste: d => d.paste("pasted ünïcödé\nsecond line"),
				setText: () => handle.setText("replaced draft\n\tindented 日本語"),
				unfocus: noop,
				refocus: noop,
				"terminal cursor": () => terminalCursor.set(true),
				"native other": d => void d.emit({ type: "select", key: "", item: "x" }),
				"attach image": () => void handle.attachImage({ type: "image", data: "AA==", mimeType: "image/png" }),
				'key "\\u001b[200~bracketed paste\\u001b[201~"': d => d.paste("bracketed paste"),
			},
		};
	},
});
