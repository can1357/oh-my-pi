import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { APPROVE_ARM_MS } from "@oh-my-pi/pi-tui/overlays/approval-dialog";
import {
	type SandboxAccessDialogAnswer,
	SandboxAccessDialogComponent,
	type SandboxAccessView,
} from "@oh-my-pi/pi-tui/overlays/sandbox-access-dialog";
import { initTheme } from "@oh-my-pi/pi-tui/theme/theme";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { TspHarness } from "./native/tsp-harness";

const ENTER = "\r";
const DOWN = "\x1b[B";
const ESC = "\x1b";
const BACKSPACE = "\x7f";

const VIEW: SandboxAccessView = {
	kind: "write",
	target: "/work/out",
	intent: "Build into /work/out so the release script finds the bundle.",
	command: "make OUT=/work/out",
	alternative: "Build into the workspace instead.",
	effect: "Contained commands will be able to create, change and delete files under /work/out.",
	canAlways: true,
};

beforeAll(async () => {
	await initTheme(false);
});

/** What `performance.now()` returns: dialogs mount at 1 000 ms. */
let clock = 1_000;

beforeEach(() => {
	clock = 1_000;
	vi.spyOn(performance, "now").mockImplementation(() => clock);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function open(view: Partial<SandboxAccessView> = {}): {
	dialog: SandboxAccessDialogComponent;
	answers: SandboxAccessDialogAnswer[];
} {
	const answers: SandboxAccessDialogAnswer[] = [];
	clock = 1_000;
	const dialog = new SandboxAccessDialogComponent({ ...VIEW, ...view }, { onAnswer: answer => answers.push(answer) });
	// Past the arm delay, so Enter and clicks answer.
	clock = 1_000 + APPROVE_ARM_MS;
	return { dialog, answers };
}

function press(dialog: SandboxAccessDialogComponent, ...keys: string[]): void {
	for (const key of keys) dialog.handleInput(key);
}

function nodesOf(root: NativeNode, kind: string): NativeNode[] {
	const out: NativeNode[] = [];
	const visit = (n: NativeNode): void => {
		if (n.k === kind) out.push(n);
		for (const child of n.c ?? []) if ("k" in child) visit(child);
	};
	visit(root);
	return out;
}

/** The native view's button actions, in order (no choice list duplicates them). */
function actions(dialog: SandboxAccessDialogComponent): unknown[] {
	const root = dialog.describe();
	expect(nodesOf(root, "list")).toEqual([]);
	const bar = nodesOf(root, "row").find(n => n.p?.role === "omp.actions")!;
	return (bar.c ?? []).flatMap(child => ("k" in child && child.k !== "spacer" ? [child.key] : []));
}

describe("sandbox access dialog", () => {
	it("offers Always allow only when the list can be saved, as a button in Tern too", () => {
		expect(open().dialog.choices).toEqual(["session", "always", "deny", "instruct"]);
		expect(actions(open().dialog)).toEqual(["instruct", "always", "deny", "session"]);
		const locked = open({ canAlways: false }).dialog;
		expect(locked.choices).toEqual(["session", "deny", "instruct"]);
		expect(actions(locked)).toEqual(["instruct", "deny", "session"]);
	});

	it("answers each choice from the keyboard; Esc denies", () => {
		const cases: [string[], SandboxAccessDialogAnswer][] = [
			[[ENTER], { decision: "session" }],
			[[DOWN, ENTER], { decision: "always" }],
			[[DOWN, DOWN, ENTER], { decision: "deny" }],
			[[ESC], { decision: "deny" }],
		];
		for (const [keys, answer] of cases) {
			const { dialog, answers } = open();
			press(dialog, ...keys);
			expect(answers).toEqual([answer]);
		}
	});

	it("ignores Enter and granting buttons until the dialog is armed", () => {
		const answers: SandboxAccessDialogAnswer[] = [];
		const dialog = new SandboxAccessDialogComponent(VIEW, { onAnswer: answer => answers.push(answer) });
		press(dialog, ENTER);
		dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "session",
			mods: [],
		});
		dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "always",
			mods: [],
		});
		expect(answers).toEqual([]);
	});

	it("turns typing into a reply, so text meant for the composer plus Enter never grants", () => {
		const { dialog, answers } = open();
		press(dialog, "n", "o", ENTER);
		expect(answers).toEqual([{ decision: "instruct", instructions: "no" }]);
	});

	it("opens on the initial choice the host passes: over a draft, a bare Enter denies", () => {
		const answers: SandboxAccessDialogAnswer[] = [];
		clock = 1_000;
		const dialog = new SandboxAccessDialogComponent(VIEW, {
			onAnswer: answer => answers.push(answer),
			initialChoice: "deny",
		});
		clock = 1_000 + APPROVE_ARM_MS;
		press(dialog, ENTER);
		expect(answers).toEqual([{ decision: "deny" }]);
	});

	it("sends a reply as instructions; an empty reply or Esc goes back to the choices", () => {
		const { dialog, answers } = open({ canAlways: false });
		press(dialog, DOWN, DOWN, ENTER);
		expect(nodesOf(dialog.describe(), "col").some(n => n.p?.role === "omp.sandbox.access.reply")).toBe(true);
		// Empty: back to the choices, nothing answered.
		press(dialog, ENTER);
		expect(answers).toEqual([]);
		expect(actions(dialog)).toEqual(["instruct", "deny", "session"]);
		// Esc while replying: back, not deny.
		press(dialog, ENTER, "x", ESC);
		expect(answers).toEqual([]);
		expect(actions(dialog)).toHaveLength(3);
		press(dialog, ENTER, BACKSPACE);
		for (const ch of "  build in ./out  ") dialog.handleInput(ch);
		press(dialog, ENTER);
		expect(answers).toEqual([{ decision: "instruct", instructions: "build in ./out" }]);
	});

	it("answers native buttons and the reply's Send and Back like the keys", () => {
		const always = open();
		always.dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "always",
			mods: [],
		});
		expect(always.answers).toEqual([{ decision: "always" }]);

		// A stale Always click on a dialog that cannot save grants nothing.
		const locked = open({ canAlways: false });
		locked.dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "always",
			mods: [],
		});
		expect(locked.answers).toEqual([]);

		const deny = open();
		deny.dialog.handleNativeEvent({ type: "action", key: "", act: "deny", mods: [] });
		expect(deny.answers).toEqual([{ decision: "deny" }]);

		const reply = open();
		reply.dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "instruct",
			mods: [],
		});
		// The reply field takes the choices' place.
		expect(nodesOf(reply.dialog.describe(), "col").some(n => n.p?.role === "omp.sandbox.access.reply")).toBe(true);
		reply.dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "send",
			mods: [],
		});
		expect(reply.answers).toEqual([]);
		expect(actions(reply.dialog)).toHaveLength(4);
		reply.dialog.handleNativeEvent({
			type: "action",
			key: "",
			act: "instruct",
			mods: [],
		});
		for (const ch of "no") reply.dialog.handleInput(ch);
		reply.dialog.handleNativeEvent({ type: "action", key: "", act: "send", mods: [] });
		expect(reply.answers).toEqual([{ decision: "instruct", instructions: "no" }]);
	});

	it("keeps the agent's text clean and bounded in both renderings", () => {
		const intent = `Tab\there \x1b[31mred\x1b[0m ${"long ".repeat(200)}`;
		const { dialog } = open({
			target: "/work/out\t\x1b[31m",
			intent,
			command: `make\t${"x".repeat(300)}`,
			alternative: "fallback\x1b[31m",
		});
		const lines = dialog.render(50);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(50);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\x1b[31m");
		}
		const plain = lines.map(line => Bun.stripANSI(line));
		const at = (label: string) => plain.findIndex(line => line.includes(`│ ${label}`));
		// The intent wraps to a few rows; the command is one clipped row.
		expect(at("Command") - at("Intent") - 1).toBeLessThanOrEqual(6);
		expect(at("Effect") - at("Command") - 1).toBe(1);

		const described = JSON.stringify(dialog.describe());
		expect(described).not.toContain("\\t");
		expect(described).not.toContain("\\u001b");
	});
});

describe("sandbox access dialog in Tern", () => {
	it("draws the request with its buttons and the reply field, and answers the terminal's events", async () => {
		const { dialog, answers } = open();
		const h = await TspHarness.start(tui => {
			tui.addChild(dialog);
			tui.setFocus(dialog);
		});
		try {
			expect(h.find(node => node.p?.role === "omp.editor.ask.approval")).toBeDefined();
			for (const field of ["intent", "command", "effect", "alternative"]) {
				expect(h.find(node => node.p?.role === `omp.sandbox.access.${field}`)).toBeDefined();
			}
			expect(h.find(node => node.k === "list")).toBeUndefined();
			const instruct = h.find(node => node.p?.actions?.click === "instruct")!;
			h.event({
				ev: "action",
				sf: h.terminal.surface!,
				id: instruct.id,
				act: "instruct",
			});
			expect(h.find(node => node.k === "input")).toBeDefined();
			for (const ch of "skip it") h.terminal.send(ch);
			h.flush();
			const send = h.find(node => node.p?.actions?.click === "send")!;
			h.event({ ev: "action", sf: h.terminal.surface!, id: send.id, act: "send" });
			expect(answers).toEqual([{ decision: "instruct", instructions: "skip it" }]);
			expect(h.errors).toEqual([]);
		} finally {
			h.stop();
		}
	});
});
