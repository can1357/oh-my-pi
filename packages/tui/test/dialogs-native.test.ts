import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { setKeybindings, type Component, type TerminalFrameProvider, type TUI } from "@oh-my-pi/pi-tui";
import { stripVTControlCharacters } from "node:util";
import { md } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeSurfaceProvider } from "@oh-my-pi/pi-tui/native/node";
import { AskDialogComponent, type ExtensionAskDialogQuestion } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import { APPROVE_ARM_MS, ApprovalDialogComponent } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import { LoginDialogComponent } from "@oh-my-pi/pi-tui/overlays/login-dialog";
import { PlanReviewOverlay } from "@oh-my-pi/pi-tui/overlays/plan-review-overlay";
import { setNativeRendering } from "@oh-my-pi/pi-tui/native/state";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

const ENTER = "\n";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const PAGE_DOWN = "\x1b[6~";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const SHIFT_RIGHT = "\x1b[1;2C";
const SHIFT_LEFT = "\x1b[1;2D";

/** A terminal that draws every kind (`meter` included). */
const CX: DescribeContext = { cols: 100, reduceMotion: false, dark: true, supports: () => true, feature: () => true };

function isNode(child: NativeChild): child is NativeNode {
	return "k" in child && typeof child.k === "string";
}

/** Depth-first search over described nodes, with the keypath the reconciler reports (hoisted overlays get `^`). */
function find(
	root: NativeNode,
	predicate: (node: NativeNode) => boolean,
	path = "",
): { node: NativeNode; path: string } | undefined {
	for (const [index, child] of (root.c ?? []).entries()) {
		if (!isNode(child)) continue;
		const segment = child.k === "overlay" ? `^${child.key ?? index}` : `${child.key ?? index}`;
		const childPath = path ? `${path}/${segment}` : segment;
		if (predicate(child)) return { node: child, path: childPath };
		const found = find(child, predicate, childPath);
		if (found) return found;
	}
	return undefined;
}

const QUESTIONS: ExtensionAskDialogQuestion[] = [
	{
		id: "policy",
		question: "How should frames without credits be handled?",
		options: [{ label: "Drop them" }, { label: "Park them" }, { label: "Block" }],
		recommended: 1,
	},
	{ id: "flag", question: "Ship behind a flag?", options: [{ label: "Yes" }, { label: "No" }] },
];

function ask(onSubmit = vi.fn(), onCancel = vi.fn()): AskDialogComponent {
	return new AskDialogComponent(QUESTIONS, { onSubmit, onCancel, onPrompt: async () => undefined });
}

describe("dialogs under a native surface", () => {
	beforeAll(async () => {
		const dark = await getThemeByName("dark");
		if (!dark) throw new Error("dark theme unavailable");
		setThemeInstance(dark);
	});

	beforeEach(() => {
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.cancel": "escape" }));
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
	});

	it("ask: the action bar's Submit answers exactly as Enter does, question by question", () => {
		const viaKeys = vi.fn();
		const keyed = ask(viaKeys);
		keyed.handleInput(ENTER);
		keyed.handleInput(DOWN);
		keyed.handleInput(ENTER);
		keyed.handleInput(ENTER);

		const viaPointer = vi.fn();
		const pointed = ask(viaPointer);
		const press = (act: string) => {
			const button = find(pointed.describe(CX), node => node.p?.role === "omp.btn" && node.key === act);
			if (!button) throw new Error(`no ${act} button`);
			pointed.handleNativeEvent({ type: "action", key: button.path, act, mods: [] });
		};
		press("submit");
		pointed.handleInput(DOWN);
		press("submit");
		// Review tab: Submit sends the answers.
		press("submit");

		expect(viaKeys).toHaveBeenCalledTimes(1);
		expect(viaPointer.mock.calls).toEqual(viaKeys.mock.calls);
		expect(
			viaPointer.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions),
		).toEqual([["Park them"], ["No"]]);
	});

	it("ask: tab and option events reach the dialog through its described keypaths", () => {
		const onSubmit = vi.fn();
		const dialog = ask(onSubmit);
		const tabs = find(dialog.describe(CX), node => node.k === "tabs");
		dialog.handleNativeEvent({ type: "select", key: tabs!.path, item: "1" });
		const options = find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		expect(options?.node.key).toBe("q1");
		dialog.handleNativeEvent({ type: "activate", key: options!.path, item: "option:0" });
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		expect(onSubmit.mock.calls[0]?.[0].results[1].selectedOptions).toEqual(["Yes"]);
	});

	it("ask: docks in place of the composer instead of a modal sheet over the transcript", async () => {
		// A modal bottom sheet hid the transcript rows explaining the question and blocked scrolling.
		const transcript: Component = { render: () => [], invalidate: () => {}, describe: () => md("Why this decision") };
		const dialog = ask();
		const provider: TerminalFrameProvider & NativeSurfaceProvider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript], dock: [dialog] }),
		};
		const harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(dialog);
		});
		try {
			expect(harness.errors).toEqual([]);
			expect(harness.region("layer")?.c ?? []).toEqual([]);
			const dock = harness.region("dock")!;
			// Framed as the prompt composer (an `omp.editor.*` root role), so Tern draws the composer's shell.
			const root = dock.c?.find(node => node.p?.role === "omp.editor.ask");
			expect(root?.c?.some(node => node.p?.role === "omp.ask.options")).toBe(true);
			expect(harness.findAll(node => node.k === "overlay")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("ask: a chosen answer is marked apart from the highlighted row; answered tabs and the review say what was chosen", () => {
		const dialog = ask();
		const item = (key: string) => find(dialog.describe(CX), node => node.k === "item" && node.key === key)?.node.p;
		// The highlighted (recommended) row is not chosen until Enter.
		expect(item("option:1")?.tone).toBeUndefined();
		dialog.handleInput(ENTER);
		dialog.handleInput(LEFT);
		expect(item("option:1")?.tone).toBe("accent");
		expect(item("option:0")?.tone).toBeUndefined();
		const items = (kind: string) =>
			(find(dialog.describe(CX), node => node.k === kind)?.node.p as { items?: unknown } | undefined)?.items;
		const tabs = items("tabs") as { label: { t: string }[] }[];
		expect(tabs.map(tab => tab.label.map(part => part.t).join(""))).toEqual(["✓ policy", "flag", "Review"]);
		dialog.handleInput(RIGHT);
		dialog.handleInput(RIGHT);
		const answers = items("kv") as { k: string; v: { t: string }[] }[];
		expect(answers.map(entry => [entry.k, entry.v.map(part => part.t).join("")])).toEqual([
			["policy", "Park them"],
			["flag", "Unanswered"],
		]);
	});

	it("ask: Skip cancels like Esc; the recommended option loses its suffix for the badge", () => {
		const onCancel = vi.fn();
		const dialog = ask(vi.fn(), onCancel);
		const recommended = find(dialog.describe(CX), node => node.k === "item" && node.key === "option:1");
		expect(recommended?.node.p).toMatchObject({ label: [{ t: "Park them" }], value: [{ t: "Recommended" }] });
		dialog.handleNativeEvent({ type: "action", key: "x", act: "cancel", mods: [] });
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("ask: hiding (Alt+H or Hide) never answers; Enter or Show restores the same pending question", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const dialog = ask(onSubmit, onCancel);
		const options = () => find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		const press = (act: string) => {
			const button = find(dialog.describe(CX), node => node.p?.role === "omp.btn" && node.key === act);
			if (!button) throw new Error(`no ${act} button`);
			dialog.handleNativeEvent({ type: "action", key: button.path, act, mods: [] });
		};

		press("hide");
		expect(options()).toBeUndefined();
		expect(dialog.render(80)).toHaveLength(1);
		// A Submit click left over from the expanded bar must not answer the hidden question.
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		dialog.handleInput(ENTER);
		expect(options()).toBeDefined();

		dialog.handleInput("\x1bh");
		expect(dialog.render(80)).toHaveLength(1);
		press("show");
		expect(onSubmit).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();

		dialog.handleInput(ENTER);
		dialog.handleInput(ENTER);
		dialog.handleInput(ENTER);
		expect(onSubmit.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions)).toEqual([
			["Park them"],
			["Yes"],
		]);
	});

	it("ask: hidden while a draft owns input, Enter stays with the draft and only the hide key restores", () => {
		let draft = "half-typed";
		const routed: string[] = [];
		const dialog = new AskDialogComponent(
			QUESTIONS,
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: async () => undefined },
			{
				inputGuard: {
					isBlocked: () => draft.length > 0,
					handleInput: key => routed.push(key),
					hint: "Finish or clear the current prompt to answer",
				},
			},
		);
		const line = () => stripVTControlCharacters(dialog.render(200).join("\n"));

		dialog.handleInput("\x1bh");
		expect(line()).toContain("Finish or clear the current prompt to answer");
		expect(line()).not.toContain("/⏎ show");
		dialog.handleInput(ENTER);
		expect(routed).toEqual([ENTER]);
		expect(dialog.render(200)).toHaveLength(1);

		draft = "";
		expect(line()).toContain("/⏎ show");
		dialog.handleInput("\x1bh");
		expect(dialog.render(200).length).toBeGreaterThan(1);
	});

	it("approval: Enter confirms only after arming; Esc denies, clicks are deliberate", () => {
		const prompt = "Allow tool: write\nPath: /tmp/out.txt";
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const keyed = { onApprove: vi.fn(), onDeny: vi.fn() };
			const dialog = new ApprovalDialogComponent(prompt, keyed);
			// Enter typed for the composer, a follow-up (Ctrl+Enter, Ctrl+Q), and any other key
			// sent as the prompt mounts are ignored: only the confirm after arming answers.
			for (const key of [ENTER, "\r", "\x1b[13;5u", "\x11"]) dialog.handleInput(key);
			now.mockReturnValue(1_000 + APPROVE_ARM_MS - 1);
			dialog.handleInput(ENTER);
			expect(keyed.onApprove).not.toHaveBeenCalled();
			expect(keyed.onDeny).not.toHaveBeenCalled();
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			dialog.handleInput(ENTER);
			// Settled once: a later Esc does not also deny.
			dialog.handleInput("\x1b");
			expect(keyed.onApprove).toHaveBeenCalledTimes(1);
			expect(keyed.onDeny).not.toHaveBeenCalled();

			// Denying and clicking Approve are deliberate, so neither waits to arm.
			const denied = { onApprove: vi.fn(), onDeny: vi.fn() };
			new ApprovalDialogComponent(prompt, denied).handleInput("\x1b");
			expect(denied.onDeny).toHaveBeenCalledTimes(1);
			const pointed = { onApprove: vi.fn(), onDeny: vi.fn() };
			const clicked = new ApprovalDialogComponent(prompt, pointed);
			const approve = find(clicked.describe(), node => node.p?.role === "omp.btn" && node.key === "approve");
			clicked.handleNativeEvent({ type: "action", key: approve!.path, act: "approve", mods: [] });
			expect(pointed.onApprove).toHaveBeenCalledTimes(1);
		} finally {
			now.mockRestore();
		}
	});

	it("approval: the grants fire from their menu rows and buttons, with the remember checkbox naming the mode", () => {
		const root = "/tmp/project";
		const directoryKey = process.platform === "win32" ? root.toLowerCase() : root;
		const prompt = "Allow tool: write\nPath: /tmp/project/out.txt";
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			// The answers are chosen with the arrows and confirmed with Enter: the directory row
			// answers with the folder, and after the checkbox row toggles, the same answer grants
			// it for every session. Nothing else is bound — F6 and F7 press unbound keys.
			const callbacks = { onApprove: vi.fn(), onApproveFolder: vi.fn(), onDeny: vi.fn() };
			now.mockReturnValue(1_000);
			const dialog = new ApprovalDialogComponent(prompt, callbacks, { folderLabel: directoryKey, exactGrant: true });
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			dialog.handleInput(DOWN); // the checkbox row → Approve Directory
			dialog.handleInput(ENTER);
			expect(callbacks.onApproveFolder).toHaveBeenCalledWith(false);
			const toggled = { onApprove: vi.fn(), onApproveFolder: vi.fn(), onDeny: vi.fn() };
			now.mockReturnValue(1_000);
			const flipped = new ApprovalDialogComponent(prompt, toggled, { folderLabel: directoryKey, exactGrant: true });
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			flipped.handleInput(ENTER); // the highlighted checkbox row toggles in place
			expect(toggled.onApprove).not.toHaveBeenCalled();
			expect(toggled.onApproveFolder).not.toHaveBeenCalled();
			flipped.handleInput(DOWN);
			flipped.handleInput(ENTER); // now for every session
			expect(toggled.onApproveFolder).toHaveBeenCalledWith(true);
			const untouched = { onApprove: vi.fn(), onApproveFolder: vi.fn(), onDeny: vi.fn() };
			const unbound = new ApprovalDialogComponent(prompt, untouched, {
				folderLabel: directoryKey,
				exactGrant: true,
			});
			unbound.handleInput("\x1b[17~"); // F6: not bound to an answer
			unbound.handleInput("\x1b[18~"); // F7: not bound either
			expect(untouched.onApprove).not.toHaveBeenCalled();
			expect(untouched.onApproveFolder).not.toHaveBeenCalled();
			expect(untouched.onDeny).not.toHaveBeenCalled();

			// The native bar carries a button per offered answer, every approval one styled like
			// the primary Approve (accent); Deny keeps the destructive tone, the checkbox none.
			const granted = { onApprove: vi.fn(), onDeny: vi.fn() };
			const buttons = new ApprovalDialogComponent(prompt, granted, {
				folderLabel: directoryKey,
				exactGrant: true,
			});
			const button = (key: string) =>
				find(buttons.describe(), node => node.p?.role === "omp.btn" && node.key === key)?.node;
			for (const key of ["remember", "folder", "approve", "deny"]) {
				expect(button(key)).toBeDefined();
			}
			for (const key of ["folder", "approve"]) {
				expect(button(key)?.p?.tone).toBe("accent");
			}
			expect(button("deny")?.p?.tone).toBe("error");
			expect(button("remember")?.p?.tone).toBeUndefined();
			// The answers keep the menu's order: the checkbox, Approve Directory, Approve File, Deny.
			const keys: string[] = [];
			const collect = (node: NativeNode): void => {
				if (node.p?.role === "omp.btn" && typeof node.key === "string") keys.push(node.key);
				for (const child of node.c ?? []) if (isNode(child)) collect(child);
			};
			collect(buttons.describe());
			expect(keys).toEqual(["remember", "folder", "approve", "once", "deny"]);
			// Clicking the checkbox flips it; the next click on Approve then carries that mode.
			const remember = find(buttons.describe(), node => node.p?.role === "omp.btn" && node.key === "remember");
			expect(remember?.node.p?.title).toContain("every session");
			buttons.handleNativeEvent({ type: "action", key: remember!.path, act: "remember", mods: [] });
			expect(button("remember")?.p?.title).toContain("this session only");
			const approve = find(buttons.describe(), node => node.p?.role === "omp.btn" && node.key === "approve");
			buttons.handleNativeEvent({ type: "action", key: approve!.path, act: "approve", mods: [] });
			expect(granted.onApprove).toHaveBeenCalledWith(true);
		} finally {
			now.mockRestore();
		}

		// Without a file target or a folder there is nothing to remember: the checkbox is not
		// rendered, and its would-be key is unbound, leaving the prompt untouched.
		const clicked = { onApprove: vi.fn(), onDeny: vi.fn() };
		const armed = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const plain = new ApprovalDialogComponent("Allow tool: eval", clicked);
			expect(find(plain.describe(), node => node.p?.role === "omp.btn" && node.key === "remember")).toBeUndefined();
			plain.handleInput("\x1b[18~"); // F7: unbound on this prompt
			expect(clicked.onApprove).not.toHaveBeenCalled();
			expect(clicked.onDeny).not.toHaveBeenCalled();
			armed.mockReturnValue(1_000 + APPROVE_ARM_MS);
			plain.handleInput(ENTER); // the highlighted Approve row still answers
			expect(clicked.onApprove).toHaveBeenCalledTimes(1);
		} finally {
			armed.mockRestore();
		}
	});

	it("approval: with a composer draft, typing edits it, and the answer menu answers only an empty composer", () => {
		let draft = "";
		const routed: string[] = [];
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const details = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const dialog = new ApprovalDialogComponent(`Allow tool: bash\n${details}`, callbacks, {
				draft: {
					hasDraft: () => draft.length > 0,
					handleInput: key => {
						routed.push(key);
						if (key.length === 1 && key >= " ") draft += key;
					},
				},
			});
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			// The arrows drive the answer menu (Deny highlighted), never the composer's history,
			// while page keys scroll the details behind it.
			dialog.handleInput(DOWN);
			dialog.handleInput(PAGE_DOWN);
			expect(routed).toEqual([]);
			expect(stripVTControlCharacters(dialog.render(60).join("\n"))).not.toContain("Line 0");
			// Typing reaches the composer; once it holds text, arrows and Enter edit and send it.
			dialog.handleInput("n");
			dialog.handleInput("o");
			dialog.handleInput(UP);
			dialog.handleInput(ENTER);
			// Ctrl+C is both a cancel key and the composer's clear key: with a draft it clears, never denies.
			dialog.handleInput("\x03");
			expect(routed).toEqual(["n", "o", UP, ENTER, "\x03"]);
			expect(callbacks.onDeny).not.toHaveBeenCalled();
			// Esc stays the dialog's: it denies without touching the draft.
			dialog.handleInput("\x1b");
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
			expect(routed).toEqual(["n", "o", UP, ENTER, "\x03"]);
		} finally {
			now.mockRestore();
		}
	});

	it("approval: the answer menu moves with the arrows, confirms with Enter, and toggles its checkbox", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = { onApprove: vi.fn(), onApproveFolder: vi.fn(), onDeny: vi.fn() };
			const dialog = new ApprovalDialogComponent("Allow tool: write\nPath: /tmp/project/out.txt", callbacks, {
				folderLabel: "/tmp/project",
				exactGrant: true,
			});
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			// Every offered control is listed, with the cursor (theme.nav.cursor) on the first row.
			const lines = () =>
				stripVTControlCharacters(dialog.render(80).join("\n"))
					.split("\n")
					.map(line => line.replace(/^[│╭╰─\s]+/, "").trimEnd());
			const cursorRow = () => lines().find(line => line.startsWith(theme.nav.cursor));
			const text = () => lines().join("\n");
			for (const label of [
				`${theme.checkbox.unchecked} Remember: This Session`,
				"Approve Directory (/tmp/project)",
				"Approve File",
				"Deny",
			]) {
				expect(text()).toContain(label);
			}
			expect(text()).not.toContain("Always");
			expect(cursorRow()).toContain("Remember: This Session");
			// The checkbox toggles in place, and the answers below it keep their rows.
			dialog.handleInput(ENTER);
			expect(text()).toContain(`${theme.checkbox.checked} Remember: Always`);
			expect(text()).not.toContain("This Session");
			expect(callbacks.onApprove).not.toHaveBeenCalled();
			expect(callbacks.onDeny).not.toHaveBeenCalled();
			// Two rows down is Approve File; Enter confirms it with the checkbox as it stands.
			dialog.handleInput(DOWN);
			dialog.handleInput(DOWN);
			expect(cursorRow()).toContain("Approve File");
			expect(cursorRow()).not.toContain("Directory");
			dialog.handleInput(ENTER);
			expect(callbacks.onApprove).toHaveBeenCalledWith(true);
			// A fresh prompt starts unchecked, and its directory row answers for this session.
			const fresh = { onApprove: vi.fn(), onApproveFolder: vi.fn(), onDeny: vi.fn() };
			const reopenedAt = 2_000;
			now.mockReturnValue(reopenedAt);
			const reopen = new ApprovalDialogComponent("Allow tool: write\nPath: /tmp/project/out.txt", fresh, {
				folderLabel: "/tmp/project",
				exactGrant: true,
			});
			now.mockReturnValue(reopenedAt + APPROVE_ARM_MS);
			reopen.handleInput(DOWN);
			reopen.handleInput(ENTER);
			expect(fresh.onApproveFolder).toHaveBeenCalledWith(false);
		} finally {
			now.mockRestore();
		}
	});

	it("approval: the by-name tool answer approves the whole tool for the session", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = {
				onApprove: vi.fn(),
				onApproveFolder: vi.fn(),
				onApproveTool: vi.fn(),
				onDeny: vi.fn(),
			};
			const prompt = "Allow tool: bash\nCommand: ls -la";
			const dialog = new ApprovalDialogComponent(prompt, callbacks, {
				folderLabel: "/tmp/project",
				toolName: "bash",
			});
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			const lines = () =>
				stripVTControlCharacters(dialog.render(80).join("\n"))
					.split("\n")
					.map(line => line.replace(/^[│╭╰─\s]+/, "").trimEnd());
			const cursorRow = () => lines().find(line => line.startsWith(theme.nav.cursor));
			// It sits between the directory answer and the plain one, and the checkbox never
			// rewrites it: the grant is session-scoped by name, so there is no "Always" form.
			expect(lines().join("\n")).toContain("Approve bash for session");
			dialog.handleInput(DOWN);
			dialog.handleInput(DOWN);
			expect(cursorRow()).toContain("Approve bash for session");
			dialog.handleInput(ENTER);
			expect(callbacks.onApproveTool).toHaveBeenCalledTimes(1);
			expect(callbacks.onApprove).not.toHaveBeenCalled();
			expect(callbacks.onDeny).not.toHaveBeenCalled();

			// The native bar carries it as its own button, not as an Approve variant.
			const bar = new ApprovalDialogComponent(
				prompt,
				{ onApprove: vi.fn(), onApproveFolder: vi.fn(), onApproveTool: vi.fn(), onDeny: vi.fn() },
				{ folderLabel: "/tmp/project", toolName: "bash" },
			);
			const button = find(bar.describe(), node => node.p?.role === "omp.btn" && node.key === "tool")?.node;
			expect(button?.p?.tone).toBe("accent");
			expect(button?.p?.title).toBe("Approve every bash call for the rest of this session");
		} finally {
			now.mockRestore();
		}
	});

	it("approval: the exact answer is named for its target, with approve-once beside it", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = { onApprove: vi.fn(), onApproveOnce: vi.fn(), onDeny: vi.fn() };
			// A directory target (fileTarget false) keeps the plain name.
			const dialog = new ApprovalDialogComponent("Allow tool: read\nPath: /tmp/project", callbacks, {
				exactGrant: true,
				fileTarget: false,
			});
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			const lines = () =>
				stripVTControlCharacters(dialog.render(80).join("\n"))
					.split("\n")
					.map(line => line.replace(/^[│╭╰─\s]+/, "").trimEnd());
			const text = () => lines().join("\n");
			const cursorRow = () => lines().find(line => line.startsWith(theme.nav.cursor));
			expect(text()).toContain("Approve");
			expect(text()).not.toContain("Approve File");
			expect(text()).toContain("Approve Once");
			// Approve Once sits below the exact answer; Enter on it approves without a grant.
			dialog.handleInput(DOWN);
			dialog.handleInput(DOWN);
			expect(cursorRow()).toContain("Approve Once");
			dialog.handleInput(ENTER);
			expect(callbacks.onApproveOnce).toHaveBeenCalledTimes(1);
			expect(callbacks.onApprove).not.toHaveBeenCalled();

			// The native bar carries both, and the exact button keeps the target's name.
			const bar = new ApprovalDialogComponent(
				"Allow tool: read\nPath: /tmp/project",
				{ onApprove: vi.fn(), onApproveOnce: vi.fn(), onDeny: vi.fn() },
				{ exactGrant: true, fileTarget: false },
			);
			const button = (key: string) =>
				find(bar.describe(), node => node.p?.role === "omp.btn" && node.key === key)?.node;
			expect(button("approve")).toBeDefined();
			expect(button("once")?.p?.title).toBe("Approve this call without remembering it");
		} finally {
			now.mockRestore();
		}
	});

	it("approval: a directory-only call offers the directory answer and approve-once alone", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = {
				onApprove: vi.fn(),
				onApproveFolder: vi.fn(),
				onApproveOnce: vi.fn(),
				onDeny: vi.fn(),
			};
			const prompt = "Allow tool: read\nPath: /tmp/project";
			const options = { exactGrant: true, fileTarget: false, exactAnswer: false, folderLabel: "/tmp/project" };
			const dialog = new ApprovalDialogComponent(prompt, callbacks, options);
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			const lines = () =>
				stripVTControlCharacters(dialog.render(80).join("\n"))
					.split("\n")
					.map(line => line.replace(/^[│╭╰─\s]+/, "").trimEnd());
			const text = () => lines().join("\n");
			expect(text()).toContain("Approve Directory (/tmp/project)");
			expect(text()).toContain("Approve Once");
			expect(text()).not.toContain("Approve File");
			// No bare exact row: the directory answer carries the whole grant.
			expect(lines().some(line => line.trim() === "Approve")).toBe(false);
			dialog.handleInput(DOWN);
			dialog.handleInput(DOWN);
			expect(lines().find(line => line.startsWith(theme.nav.cursor))).toContain("Approve Once");
			dialog.handleInput(ENTER);
			expect(callbacks.onApproveOnce).toHaveBeenCalledTimes(1);
			expect(callbacks.onApproveFolder).not.toHaveBeenCalled();

			// The native bar mirrors it: folder and once buttons, no exact one.
			const bar = new ApprovalDialogComponent(
				prompt,
				{ onApprove: vi.fn(), onApproveFolder: vi.fn(), onApproveOnce: vi.fn(), onDeny: vi.fn() },
				options,
			);
			const button = (key: string) =>
				find(bar.describe(), node => node.p?.role === "omp.btn" && node.key === key)?.node;
			expect(button("folder")).toBeDefined();
			expect(button("once")).toBeDefined();
			expect(button("approve")).toBeUndefined();
		} finally {
			now.mockRestore();
		}
	});

	it("approval: the arrow menu is classic-terminal only; a native surface keeps its buttons", () => {
		setNativeRendering(true);
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = { onApprove: vi.fn(), onApproveFolder: vi.fn(), onDeny: vi.fn() };
			const dialog = new ApprovalDialogComponent("Allow tool: write\nPath: /tmp/project/out.txt", callbacks, {
				folderLabel: "/tmp/project",
				exactGrant: true,
			});
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			// No list rows: the surface shows the buttons from describe() instead.
			expect(stripVTControlCharacters(dialog.render(80).join("\n"))).not.toContain(
				"Approve Directory (/tmp/project)",
			);
			for (const key of ["remember", "folder", "approve", "deny"]) {
				expect(find(dialog.describe(), node => node.p?.role === "omp.btn" && node.key === key)).toBeDefined();
			}
			// Enter must not answer from an invisible selection, and no key approves outright:
			// only the buttons answer, so an Enter aimed at the composer can never approve a call.
			dialog.handleInput(ENTER);
			dialog.handleInput(DOWN);
			dialog.handleInput(ENTER);
			dialog.handleInput("\x1b[18~"); // F7: not bound to anything
			dialog.handleInput("\x1b[17~"); // F6: not bound either
			expect(callbacks.onApprove).not.toHaveBeenCalled();
			expect(callbacks.onApproveFolder).not.toHaveBeenCalled();
			expect(callbacks.onDeny).not.toHaveBeenCalled();
			const folder = find(dialog.describe(), node => node.p?.role === "omp.btn" && node.key === "folder");
			dialog.handleNativeEvent({ type: "action", key: folder!.path, act: "folder", mods: [] });
			expect(callbacks.onApproveFolder).toHaveBeenCalledWith(false);
		} finally {
			now.mockRestore();
			setNativeRendering(false);
		}
	});

	it("approval: any key restarts the timeout (reporting start and reset), so a scroll before the deadline keeps it open", () => {
		vi.useFakeTimers();
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const onTimeout = vi.fn();
		const onTimeoutStart = vi.fn();
		const onTimeoutReset = vi.fn();
		const dialog = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", callbacks, {
			timeout: 1_000,
			onTimeout,
			onTimeoutStart,
			onTimeoutReset,
		});
		try {
			expect(onTimeoutStart).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(900);
			dialog.handleInput(DOWN);
			expect(onTimeoutReset).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(200);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(callbacks.onDeny).not.toHaveBeenCalled();
			vi.advanceTimersByTime(800);
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
		} finally {
			dialog.dispose();
			vi.useRealTimers();
		}
	});

	it("approval: expanding the details from the host's key or Details restarts the timeout too", () => {
		vi.useFakeTimers();
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const onTimeoutReset = vi.fn();
		const dialog = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls …", callbacks, {
			fullPrompt: "Allow tool: bash\nCommand: ls\n-la",
			timeout: 1_000,
			onTimeoutReset,
		});
		try {
			vi.advanceTimersByTime(900);
			expect(dialog.toggleDetails()).toBe(true);
			vi.advanceTimersByTime(900);
			const expand = find(dialog.describe(), node => node.p?.role === "omp.btn" && node.key === "expand");
			dialog.handleNativeEvent({ type: "action", key: expand!.path, act: "expand", mods: [] });
			vi.advanceTimersByTime(900);
			expect(onTimeoutReset).toHaveBeenCalledTimes(2);
			expect(callbacks.onDeny).not.toHaveBeenCalled();
		} finally {
			dialog.dispose();
			vi.useRealTimers();
		}
	});

	it("approval: an expired timeout denies (never approves) and reports the timeout", async () => {
		const denied = Promise.withResolvers<void>();
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn(() => denied.resolve()) };
		const onTimeout = vi.fn();
		const dialog = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", callbacks, { timeout: 1, onTimeout });
		try {
			await denied.promise;
			expect(onTimeout).toHaveBeenCalledTimes(1);
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
			expect(callbacks.onApprove).not.toHaveBeenCalled();
		} finally {
			dialog.dispose();
		}
	});

	it("approval: the expand key or Details swaps the one-row summary for every detail, wrapped, even mid-draft", () => {
		const command = `Command: echo ok && ${"x".repeat(120)} && rm -rf ~\nsecond line`;
		const routed: string[] = [];
		const dialog = new ApprovalDialogComponent(
			"Allow tool: bash\nCommand: echo ok …",
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{
				fullPrompt: `Allow tool: bash\n${command}`,
				draft: { hasDraft: () => true, handleInput: key => routed.push(key) },
			},
		);
		const body = () => stripVTControlCharacters(dialog.render(60).join("\n")).replace(/[│\s]+/g, "");
		expect(body()).not.toContain("rm-rf~");
		// Ctrl+O belongs to the dialog, not the draft that holds the other keys.
		dialog.handleInput("\x0f");
		expect(routed).toEqual([]);
		expect(body()).toContain("rm-rf~");
		expect(body()).toContain("secondline");
		const row = find(dialog.describe(), node => node.p?.role === "omp.approval.details")?.node.c?.[0];
		expect((row as NativeNode).p).not.toHaveProperty("truncate");
		const expand = find(dialog.describe(), node => node.p?.role === "omp.btn" && node.key === "expand");
		dialog.handleNativeEvent({ type: "action", key: expand!.path, act: "expand", mods: [] });
		expect(body()).not.toContain("rm-rf~");
		// Without a full prompt there is nothing to expand, so no Details button.
		const plain = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", {
			onApprove: vi.fn(),
			onDeny: vi.fn(),
		});
		expect(find(plain.describe(), node => node.key === "expand")).toBeUndefined();
	});

	it("approval: docks in place of the composer with its details, not a card over the transcript", async () => {
		const transcript: Component = { render: () => [], invalidate: () => {}, describe: () => md("Why this write") };
		const dialog = new ApprovalDialogComponent("Allow tool: write\nPath: /tmp/out.txt", {
			onApprove: vi.fn(),
			onDeny: vi.fn(),
		});
		const provider: TerminalFrameProvider & NativeSurfaceProvider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript], dock: [dialog] }),
		};
		const harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(dialog);
		});
		try {
			expect(harness.errors).toEqual([]);
			const root = harness.region("dock")!.c?.find(node => node.p?.role === "omp.editor.ask.approval");
			const details = root?.c?.find(node => node.p?.role === "omp.approval.details");
			expect(details?.c?.map(node => node.p)).toEqual([
				expect.objectContaining({ text: "Path: /tmp/out.txt", truncate: "end" }),
			]);
			expect(harness.findAll(node => node.k === "overlay" || node.k === "card")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("plan review: the title heading titles the sheet and is not repeated in the body; Copy copies what `c` does", () => {
		const viaKey = vi.fn();
		const viaButton = vi.fn();
		const plan = "# Ship credits\n\nintro\n\n## Alpha\n\na\n\n## Beta\n\nb\n";
		const keyed = new PlanReviewOverlay(
			plan,
			{ options: ["Approve"] },
			{ onPick: vi.fn(), onCancel: vi.fn(), onCopyPlan: viaKey },
		);
		keyed.handleInput("c");
		const pointed = new PlanReviewOverlay(
			plan,
			{ options: ["Approve"] },
			{ onPick: vi.fn(), onCancel: vi.fn(), onCopyPlan: viaButton },
		);
		expect(pointed.nativeOverlay.head).toBe("Ship credits");
		const body = pointed.describe();
		expect(JSON.stringify(find(body, node => node.p?.role === "omp.plan.body")?.node)).not.toContain(
			"# Ship credits",
		);
		pointed.handleNativeEvent({ type: "action", key: "tools/copyPlan", act: "copyPlan", mods: [] });
		expect(viaButton.mock.calls).toEqual(viaKey.mock.calls);
		expect(viaKey).toHaveBeenCalledTimes(1);
	});

	it("plan review: ←/→ walk the horizontal decision bar, Shift+←/→ step the model slider, ↑ leaves it", () => {
		const onPick = vi.fn();
		const onChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			"# Plan\n\nbody\n",
			{
				options: ["Approve", "Refine", "Stay"],
				slider: { segments: [{ label: "Fast" }, { label: "Smart" }], index: 0, onChange },
			},
			{ onPick, onCancel: vi.fn() },
		);
		setNativeRendering(true);
		try {
			// → → ← lands on the middle option; Shift+→ then Shift+← round-trips the slider.
			overlay.handleInput(RIGHT);
			overlay.handleInput(RIGHT);
			overlay.handleInput(LEFT);
			overlay.handleInput(SHIFT_RIGHT);
			overlay.handleInput(SHIFT_LEFT);
			// ↓ has nothing below the bar: the selection stays put.
			overlay.handleInput(DOWN);
			// ↑ hands focus to the body, where Enter returns to the bar instead of confirming.
			overlay.handleInput(UP);
			overlay.handleInput(ENTER);
			expect(onPick).not.toHaveBeenCalled();
			overlay.handleInput(ENTER);
		} finally {
			setNativeRendering(false);
		}
		expect(onChange.mock.calls).toEqual([[1], [0]]);
		expect(onPick).toHaveBeenCalledWith("Refine");
	});

	it("login: Cancel runs Esc's path and Continue submits the pasted code", async () => {
		const tui = { requestRender() {}, setFocus() {} } as unknown as TUI;
		const onComplete = vi.fn();
		const dialog = new LoginDialogComponent(tui, "openai-codex", onComplete, () => {});
		dialog.showAuth("https://auth.example.com/authorize?x=1", "Enter code: ABCD-1234");
		const waiting = dialog.describe();
		// The device code copies itself; with nothing to answer, opening the page is the primary action.
		expect(find(waiting, node => node.p?.role === "omp.login.code")?.node.p).toMatchObject({
			actions: { click: "copy" },
			href: "ABCD-1234",
		});
		expect(find(waiting, node => node.p?.actions?.click === "open")?.node.p).toMatchObject({
			href: "https://auth.example.com/authorize?x=1",
			tone: "accent",
		});
		expect(find(waiting, node => node.p?.actions?.click === "submit")).toBeUndefined();

		const pending = dialog.showManualInput("Paste the authorization code:");
		const described = dialog.describe();
		// A field waiting for an answer takes the primary action; Open stays as a plain button.
		expect(find(described, node => node.p?.actions?.click === "submit")?.node.p).toMatchObject({ tone: "accent" });
		expect(find(described, node => node.p?.actions?.click === "open")?.node.p?.tone).toBeUndefined();
		dialog.pasteText("code-123");
		dialog.handleNativeEvent({ type: "action", key: "x", act: "submit", mods: [] });
		expect(await pending).toBe("code-123");

		const cancelled = dialog.showManualInput("Paste the authorization code:");
		dialog.handleNativeEvent({ type: "action", key: "x", act: "cancel", mods: [] });
		await expect(cancelled).rejects.toThrow("Login cancelled");
		expect(onComplete).toHaveBeenCalledWith(false, "Login cancelled");
	});
});
