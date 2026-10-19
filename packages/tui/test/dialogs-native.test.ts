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
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-tui/theme";
import { TspHarness } from "./native/tsp-harness";

const ENTER = "\n";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
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

	it("approval: Enter and the follow-up chord are ignored until armed; then Enter takes the highlighted choice", () => {
		const prompt = "Allow tool: write\nPath: /tmp/out.txt";
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const keyed = { onApprove: vi.fn(), onDeny: vi.fn() };
			const dialog = new ApprovalDialogComponent(prompt, keyed);
			// An Enter typed for the composer, and a follow-up (Ctrl+Enter, Ctrl+Q) sent as the prompt mounts.
			for (const key of [ENTER, "\r", "\x1b[13;5u", "\x11"]) dialog.handleInput(key);
			now.mockReturnValue(1_000 + APPROVE_ARM_MS - 1);
			dialog.handleInput("\x1b[13;5u");
			dialog.handleInput(ENTER);
			expect(keyed.onApprove).not.toHaveBeenCalled();
			expect(keyed.onDeny).not.toHaveBeenCalled();
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			dialog.handleInput("\x1b[13;5u");
			// Settled once: a later Esc does not also deny.
			dialog.handleInput("\x1b");
			expect(keyed.onApprove).toHaveBeenCalledTimes(1);
			expect(keyed.onDeny).not.toHaveBeenCalled();

			// The arrows wrap between Approve and Deny; Enter takes the highlighted one.
			const listed = { onApprove: vi.fn(), onDeny: vi.fn() };
			const list = new ApprovalDialogComponent(prompt, listed);
			now.mockReturnValue(1_000 + 2 * APPROVE_ARM_MS);
			list.handleInput(UP);
			expect(stripVTControlCharacters(list.render(60).join("\n"))).toMatch(/\S Deny/);
			list.handleInput(ENTER);
			expect(listed.onDeny).toHaveBeenCalledTimes(1);
			expect(listed.onApprove).not.toHaveBeenCalled();
			const defaulted = { onApprove: vi.fn(), onDeny: vi.fn() };
			const approveFirst = new ApprovalDialogComponent(prompt, defaulted);
			now.mockReturnValue(1_000 + 3 * APPROVE_ARM_MS);
			approveFirst.handleInput(ENTER);
			expect(defaulted.onApprove).toHaveBeenCalledTimes(1);
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

	it("approval: the session row sits between Approve and Deny; the arrows reach it, Enter or a Tern click takes it", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
			const onSession = vi.fn();
			const dialog = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", callbacks, {
				session: { label: "Approve bash for this session", onApprove: onSession },
			});
			const rows = () =>
				stripVTControlCharacters(dialog.render(80).join("\n"))
					.split("\n")
					.filter(line => /Approve|Deny/.test(line));
			const choices = () => find(dialog.describe(), node => node.p?.role === "omp.approval.choices")!;
			const selected = () => {
				const props = choices().node.p;
				return props && "selected" in props ? props.selected : undefined;
			};
			expect(rows().map(line => line.replace(/[│❯>\s]+/g, " ").trim())).toEqual([
				"Approve",
				"Approve bash for this session",
				"Deny",
			]);
			dialog.handleInput(DOWN);
			// Tern's list shows the same highlight the arrows moved.
			expect(selected()).toBe("session");
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			dialog.handleInput(ENTER);
			expect(onSession).toHaveBeenCalledTimes(1);
			expect(callbacks.onApprove).not.toHaveBeenCalled();

			const clicked = { onApprove: vi.fn(), onDeny: vi.fn() };
			const pointed = new ApprovalDialogComponent("Allow tool: bash\nCommand: ls", clicked);
			const list = find(pointed.describe(), node => node.p?.role === "omp.approval.choices")!;
			pointed.handleNativeEvent({ type: "select", key: list.path, item: "deny" });
			expect(clicked.onDeny).toHaveBeenCalledTimes(1);
		} finally {
			now.mockRestore();
		}
	});

	it("approval: grants sit above Approve Once, the toggle keeps them across sessions, Enter or a Tern click takes one", () => {
		const now = vi.spyOn(performance, "now").mockReturnValue(1_000);
		try {
			const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
			const onGrant = vi.fn();
			const folder = { label: "Approve Directory: ~/src", alwaysLabel: "Always Approve Directory: ~/src" };
			const file = { label: "Approve File", alwaysLabel: "Always Approve File" };
			const dialog = new ApprovalDialogComponent("Allow tool: write\nPath: a.ts", callbacks, {
				grants: [folder, file],
				onGrant,
			});
			const rows = () =>
				stripVTControlCharacters(dialog.render(80).join("\n"))
					.split("\n")
					.filter(line => /Approve|Deny|Remember/.test(line))
					.map(line => line.replace(/[│❯>\s]+/g, " ").trim());
			expect(rows().slice(1)).toEqual(["Approve Directory: ~/src", "Approve File", "Approve Once", "Deny"]);
			now.mockReturnValue(1_000 + APPROVE_ARM_MS);
			// Approve Once is highlighted on mount: the least the call can be granted.
			for (let step = 0; step < 3; step++) dialog.handleInput(UP);
			dialog.handleInput(ENTER);
			expect(rows().slice(1, 3)).toEqual(["Always Approve Directory: ~/src", "Always Approve File"]);
			dialog.handleInput(DOWN);
			dialog.handleInput(DOWN);
			dialog.handleInput(ENTER);
			expect(onGrant).toHaveBeenCalledWith(file, true);
			expect(callbacks.onApprove).not.toHaveBeenCalled();

			const clicked = vi.fn();
			const pointed = new ApprovalDialogComponent("Allow tool: write\nPath: a.ts", callbacks, {
				grants: [folder, file],
				onGrant: clicked,
			});
			const list = find(pointed.describe(), node => node.p?.role === "omp.approval.choices")!;
			pointed.handleNativeEvent({ type: "select", key: list.path, item: "grant0" });
			expect(clicked).toHaveBeenCalledWith(folder, false);
		} finally {
			now.mockRestore();
		}
	});

	it("approval: while a draft holds Enter, the highlight sits on Deny, relabeled to say Enter sends, and returns once cleared", () => {
		let draft = "";
		const dialog = new ApprovalDialogComponent(
			"Allow tool: bash\nCommand: ls",
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{
				draft: { hasDraft: () => draft.length > 0, handleInput: key => (draft += key) },
			},
		);
		const highlighted = () =>
			stripVTControlCharacters(dialog.render(80).join("\n"))
				.split("\n")
				.find(line => line.includes("❯"));
		expect(highlighted()).toContain("Approve");
		dialog.handleInput("k");
		expect(highlighted()).toContain("Deny and send message");
		const choices = find(dialog.describe(), node => node.p?.role === "omp.approval.choices")!;
		expect(choices.node.p && "selected" in choices.node.p ? choices.node.p.selected : undefined).toBe("deny");
		draft = "";
		expect(highlighted()).toContain("Approve");
		expect(highlighted()).not.toContain("Deny");
	});

	it("approval: with a composer draft, typing edits it; once it holds text, the arrows and Enter edit and send it", () => {
		let draft = "";
		const routed: string[] = [];
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const details = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
		const dialog = new ApprovalDialogComponent(`Allow tool: bash\n${details}`, callbacks, {
			draft: {
				hasDraft: () => draft.length > 0,
				handleInput: key => {
					routed.push(key);
					if (key.length === 1 && key >= " ") draft += key;
				},
			},
		});
		// Empty composer: Enter (before the dialog arms) neither submits nor interrupts, and Page Down scrolls the details.
		dialog.handleInput(ENTER);
		dialog.handleInput("\x1b[6~");
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
		expect(routed).toHaveLength(5);
		expect(callbacks.onApprove).not.toHaveBeenCalled();
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
