/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * The sandbox access dialog in a plain terminal (keys, the list and buttons'
 * UI events, the painted rows) and in Tern (the native tree and its events).
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { UiEvent, UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent, pathTo } from "@oh-my-pi/pi-tui/dispatch";
import type { TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { APPROVE_ARM_MS } from "../../../../src/modes/view-model/overlays/approval-dialog";
import type {
	SandboxAccessChoice,
	SandboxAccessView,
} from "../../../../src/modes/view-model/overlays/sandbox-access-dialog";
import type { SandboxAccessAnswer } from "../../../../src/sandbox/types";
import { SandboxAccessDialog } from "../../../../src/ui/overlays/panels/sandbox-access-dialog";
import { nativeShell } from "../../../helpers/native-shell";
import { mountOverlay } from "../../../helpers/overlay-terminal";

const VIEW: SandboxAccessView = {
	kind: "write",
	target: "/work/out",
	intent: "Build into /work/out so the release script finds the bundle.",
	command: "make OUT=/work/out",
	alternative: "Build into the workspace instead.",
	effect: "Contained commands will be able to create, change and delete files under /work/out.",
	canAlways: true,
};

interface Opened {
	readonly term: TestTerminal;
	readonly answers: SandboxAccessAnswer[];
	/** The dialog's root node. */
	root(): UiNode;
	/** Deliver a UI event to the root's child keyed `key` (the root itself when empty), bubbling. */
	emit(key: string, event: UiEvent): void;
	/** The choice ids the list offers, in order; empty while the reply is open. */
	choices(): string[];
	replying(): boolean;
}

const open_: TestTerminal[] = [];
afterEach(() => {
	for (const term of open_.splice(0)) term.dispose();
});

/** Mount the dialog; `armed` (default) moves the clock past the arm delay. */
function open(
	view: Partial<SandboxAccessView> = {},
	options: { armed?: boolean; initialChoice?: SandboxAccessChoice; columns?: number } = {},
): Opened {
	let clock = 1_000;
	const answers: SandboxAccessAnswer[] = [];
	const term = mountOverlay(
		() => (
			<SandboxAccessDialog
				view={{ ...VIEW, ...view }}
				now={() => clock}
				initialChoice={options.initialChoice}
				onAnswer={answer => void answers.push(answer)}
			/>
		),
		{ columns: options.columns ?? 80 },
	);
	open_.push(term);
	if (options.armed !== false) clock += APPROVE_ARM_MS;
	const root = () => term.surface.layer()[0]!;
	const child = (key: string) =>
		root()
			.children()
			.find(node => node.key() === key);
	return {
		term,
		answers,
		root,
		emit(key, event) {
			const target = key === "" ? root() : child(key);
			if (!target) throw new Error(`no node ${key}`);
			bubbleEvent(pathTo([root()], target), event);
			term.render();
		},
		choices: () =>
			child("choices")
				?.children()
				.map(node => node.key()!) ?? [],
		replying: () => child("reply") !== undefined,
	};
}

const action = (act: string): UiEvent => ({ type: "action", key: "", act, mods: [] });

describe("sandbox access dialog", () => {
	it("offers Always allow only when the list can be saved", () => {
		expect(open().choices()).toEqual(["session", "always", "deny", "instruct"]);
		expect(open({ canAlways: false }).choices()).toEqual(["session", "deny", "instruct"]);
	});

	it("answers each choice from the keyboard; Esc denies", () => {
		const cases: [string[], SandboxAccessAnswer][] = [
			[["enter"], { decision: "session" }],
			[["down", "enter"], { decision: "always" }],
			[["down", "down", "enter"], { decision: "deny" }],
			[["escape"], { decision: "deny" }],
		];
		for (const [keys, answer] of cases) {
			const dialog = open();
			for (const key of keys) dialog.term.press(key);
			expect(dialog.answers).toEqual([answer]);
		}
		// Without Always allow the second row is Deny; Up from the first row wraps to Reply, which opens the field.
		const locked = open({ canAlways: false });
		locked.term.press("down");
		locked.term.press("enter");
		expect(locked.answers).toEqual([{ decision: "deny" }]);
		const wrapped = open({ canAlways: false });
		wrapped.term.press("up");
		wrapped.term.press("enter");
		expect(wrapped.answers).toEqual([]);
		expect(wrapped.replying()).toBe(true);
	});

	it("opens on the initial choice: over a composer draft a bare Enter denies", () => {
		const dialog = open({}, { initialChoice: "deny" });
		dialog.term.press("enter");
		expect(dialog.answers).toEqual([{ decision: "deny" }]);
	});

	it("ignores Enter and granting choices until the dialog is armed", () => {
		const dialog = open({}, { armed: false });
		dialog.term.press("enter");
		dialog.emit("choices", { type: "select", key: "choices", item: "session" });
		dialog.emit("choices", { type: "activate", key: "choices", item: "always" });
		dialog.emit("", action("session"));
		expect(dialog.answers).toEqual([]);
		// Deny is never held back.
		dialog.emit("", action("deny"));
		expect(dialog.answers).toEqual([{ decision: "deny" }]);
	});

	it("turns typing into a reply, so text meant for the composer plus Enter never grants", () => {
		const dialog = open();
		dialog.term.type("no");
		dialog.term.press("enter");
		expect(dialog.answers).toEqual([{ decision: "instruct", instructions: "no" }]);
	});

	it("sends a reply as instructions; an empty reply or Esc goes back to the choices", () => {
		const dialog = open({ canAlways: false });
		dialog.term.press("down");
		dialog.term.press("down");
		dialog.term.press("enter");
		expect(dialog.replying()).toBe(true);
		// Empty: back to the choices, nothing answered.
		dialog.term.press("enter");
		expect(dialog.answers).toEqual([]);
		expect(dialog.choices()).toEqual(["session", "deny", "instruct"]);
		// Esc while replying: back, not deny.
		dialog.term.press("enter");
		dialog.term.type("x");
		dialog.term.press("escape");
		expect(dialog.answers).toEqual([]);
		expect(dialog.replying()).toBe(false);
		// The highlight stayed on Reply: Enter opens a fresh field.
		dialog.term.press("enter");
		dialog.term.type("  build in ./out  ");
		dialog.term.press("enter");
		expect(dialog.answers).toEqual([{ decision: "instruct", instructions: "build in ./out" }]);
	});

	it("takes a paste as a reply, flattened to one line, and into an open reply", () => {
		const dialog = open();
		dialog.term.paste("use\n./dist");
		expect(dialog.replying()).toBe(true);
		dialog.term.paste(" instead");
		dialog.term.press("enter");
		expect(dialog.answers).toEqual([{ decision: "instruct", instructions: "use ./dist instead" }]);
	});

	it("answers the list and the buttons like the keys; the reply's Back returns to the choices", () => {
		const always = open();
		always.emit("choices", { type: "activate", key: "choices", item: "always" });
		expect(always.answers).toEqual([{ decision: "always" }]);

		const session = open();
		session.emit("", action("session"));
		expect(session.answers).toEqual([{ decision: "session" }]);

		// A stale Always on a dialog that cannot save grants nothing.
		const locked = open({ canAlways: false });
		locked.emit("choices", { type: "select", key: "choices", item: "always" });
		locked.emit("", action("always"));
		expect(locked.answers).toEqual([]);

		const deny = open();
		deny.emit("", action("deny"));
		expect(deny.answers).toEqual([{ decision: "deny" }]);

		const reply = open();
		reply.emit("choices", { type: "select", key: "choices", item: "instruct" });
		expect(reply.replying()).toBe(true);
		reply.emit("", action("back"));
		expect(reply.answers).toEqual([]);
		expect(reply.choices()).toHaveLength(4);
		reply.emit("choices", { type: "select", key: "choices", item: "instruct" });
		reply.term.type("skip it");
		reply.emit("", action("send"));
		expect(reply.answers).toEqual([{ decision: "instruct", instructions: "skip it" }]);
	});

	it("answers once", () => {
		const dialog = open();
		dialog.term.press("escape");
		dialog.emit("", action("session"));
		expect(dialog.answers).toEqual([{ decision: "deny" }]);
	});

	it("paints the request with its labeled fields and the choices", () => {
		const dialog = open({}, { columns: 100 });
		dialog.term.render();
		const screen = dialog.term.screen().join("\n");
		expect(screen).toContain("Sandbox request: write to /work/out");
		for (const text of [
			"Intent",
			"Build into /work/out so the release script finds the bundle.",
			"Command",
			"make OUT=/work/out",
			"Effect",
			"If denied",
			"Build into the workspace instead.",
			"❯ Allow for this session",
			"Always allow (saved to global config)",
			"Reply with instructions…",
		])
			expect(screen).toContain(text);
		dialog.term.type("hi");
		expect(dialog.term.screen().join("\n")).toContain("> hi");
	});

	it("keeps the agent's text clean and bounded in both renderings", () => {
		const intent = `Tab\there \x1b[31mred\x1b[0m ${"long ".repeat(200)}`;
		const dialog = open(
			{
				target: "/work/out\t\x1b[31m",
				intent,
				command: `make\t${"x".repeat(300)}`,
				alternative: "fallback\x1b[31m",
			},
			{ columns: 50 },
		);
		dialog.term.render();
		const rows = dialog.term.rows();
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
		const plain = dialog.term.screen();
		for (const line of plain) {
			expect(line).not.toContain("\t");
			expect(line).not.toContain("[31m");
		}
		const at = (label: string) => plain.findIndex(line => line.includes(`│ ${label}`));
		// The intent wraps to a few rows; the command is one clipped row.
		expect(at("Intent")).toBeGreaterThanOrEqual(0);
		expect(at("Command") - at("Intent") - 1).toBe(6);
		expect(at("Effect") - at("Command") - 1).toBe(1);

		const described = JSON.stringify(serialize(dialog.root()));
		expect(described).not.toContain("\\t");
		expect(described).not.toContain("\\u001b");
	});
});

/** The props of every node under `node`, for checks over the whole tree. */
function serialize(node: UiNode): unknown {
	return { k: node.kind, p: node.props(), c: node.children().map(serialize) };
}

describe("sandbox access dialog in Tern", () => {
	it("sends the request, the choices and the reply field, and answers the terminal's events", async () => {
		await using ui = await nativeShell();
		const answers: SandboxAccessAnswer[] = [];
		let clock = 0;
		ui.shell.dock
			.slot("ask")
			.set(() => (
				<SandboxAccessDialog view={VIEW} now={() => clock} onAnswer={answer => void answers.push(answer)} />
			));
		clock = APPROVE_ARM_MS;
		expect(ui.node("col", "intent").p.role).toBe("omp.sandbox.access.intent");
		for (const field of ["command", "effect", "alternative"])
			expect(ui.node("col", field).p.role).toBe(`omp.sandbox.access.${field}`);
		const list = ui.node("list", "choices");
		expect(ui.children(list).map(item => item.p.label)).toEqual([
			"Allow for this session",
			"Always allow (saved to global config)",
			"Deny",
			"Reply with instructions…",
		]);
		ui.send({ ev: "select", sf: ui.sf, id: list.id, item: "instruct" });
		const input = ui.node("input");
		ui.send({ ev: "edit", sf: ui.sf, id: input.id, from: 0, to: 0, text: "skip it", cursor: 7, len: 0 });
		expect(ui.node("input").p).toMatchObject({ text: "skip it" });
		ui.click("button", "send");
		expect(answers).toEqual([{ decision: "instruct", instructions: "skip it" }]);
	});

	it("grants from the Allow button once armed", async () => {
		await using ui = await nativeShell();
		const answers: SandboxAccessAnswer[] = [];
		let clock = 0;
		ui.shell.dock
			.slot("ask")
			.set(() => (
				<SandboxAccessDialog view={VIEW} now={() => clock} onAnswer={answer => void answers.push(answer)} />
			));
		ui.click("button", "session");
		expect(answers).toEqual([]);
		clock = APPROVE_ARM_MS;
		ui.click("button", "session");
		expect(answers).toEqual([{ decision: "session" }]);
	});
});
