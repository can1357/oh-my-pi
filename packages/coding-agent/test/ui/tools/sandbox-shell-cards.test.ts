import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { SandboxResultMeta } from "../../../src/sandbox/types";
import type { BashToolDetails } from "../../../src/tools/details/bash";
import type { EvalToolDetails } from "../../../src/tools/details/eval";
import { type BashArgs, bashPresenter } from "../../../src/ui/tools/bash";
import { type EvalArgs, evalPresenter } from "../../../src/ui/tools/eval";
import { SANDBOX_NOTE_ROLE } from "../../../src/ui/tools/sandbox-meta";
import { type Presented, present, spanText } from "./sandbox-paint";

const SANDBOX: SandboxResultMeta = {
	backend: "seatbelt",
	mode: "workspace-write",
	network: "allowlist",
	blockedHosts: ["example.com", "evil.test"],
	denied: true,
};
const BADGE = { text: "sandboxed", tone: "info" as const, title: "seatbelt · workspace-write · network allowlist" };
const NOTES = ["blocked by sandbox: hosts example.com, evil.test", "possible sandbox denial"];
const BASH_ARGS: BashArgs = { command: "touch /etc/x" };

function bash(sandbox: SandboxResultMeta | undefined): Presented {
	const details: BashToolDetails = { exitCode: 1, ...(sandbox ? { sandbox } : {}) };
	return present("bash", bashPresenter, BASH_ARGS, {
		content: [{ type: "text", text: "touch: /etc/x: Operation not permitted" }],
		details,
		isError: true,
	});
}

function evalCells(sandbox: SandboxResultMeta | undefined): Presented {
	const details: EvalToolDetails = {
		cells: [
			{
				index: 0,
				code: "open('/etc/x', 'w')",
				language: "python",
				output: "PermissionError",
				status: "error",
			},
		],
		...(sandbox ? { sandbox } : {}),
	};
	return present("eval", evalPresenter, {} as EvalArgs, {
		content: [{ type: "text", text: "PermissionError" }],
		details,
		isError: true,
	});
}

/** Eval without per-cell details: the call's cells and one output. */
function evalOutput(sandbox: SandboxResultMeta | undefined): Presented {
	const details: EvalToolDetails = { language: "python", ...(sandbox ? { sandbox } : {}) };
	return present(
		"eval",
		evalPresenter,
		{ cells: [{ language: "python", code: "open('/etc/x', 'w')" }] },
		{
			content: [{ type: "text", text: "PermissionError" }],
			details,
			isError: true,
		},
	);
}

/** The sandbox notes of a body: their texts, all warning-toned. */
function notes(presented: Presented): string[] {
	const found = presented.body.filter(node => (node.props() as { role?: string }).role === SANDBOX_NOTE_ROLE);
	for (const node of found)
		expect((node.props() as { spans: { s?: string }[] }).spans.map(span => span.s)).toEqual(["warning"]);
	return found.map(spanText);
}

describe("bash results run in the sandbox", () => {
	it("carry the sandboxed badge and warning notes after the run box", () => {
		const card = bash(SANDBOX);
		expect(card.view.head?.badges).toEqual([BADGE]);
		expect(notes(card)).toEqual(NOTES);
		expect(card.body.map(node => (node.props() as { role?: string }).role)).toEqual([
			"omp.run",
			SANDBOX_NOTE_ROLE,
			SANDBOX_NOTE_ROLE,
		]);
	});

	it("draw a dim sandboxed head and the same warnings in a plain terminal", () => {
		const rows = bash(SANDBOX).rows();
		expect(rows[0]).toContain("sandboxed");
		const text = rows.join("\n");
		for (const note of NOTES) expect(text).toContain(note);
	});

	it("tell a program that cannot start in the Windows sandbox apart from a denial", () => {
		const startFailed: SandboxResultMeta = {
			...SANDBOX,
			blockedHosts: undefined,
			denied: undefined,
			startFailed: true,
		};
		expect(notes(bash(startFailed))).toEqual(["cannot start in the Windows sandbox"]);
	});

	it("name a single refused host as a host", () => {
		expect(notes(bash({ ...SANDBOX, blockedHosts: ["example.com"], denied: undefined }))).toEqual([
			"blocked by sandbox: host example.com",
		]);
	});

	it("clean hostile host names and wrap the warning within a narrow card", () => {
		const hostile: SandboxResultMeta = {
			...SANDBOX,
			backend: "seat\tbelt\x1b[31m",
			blockedHosts: ["a\tb\x1b[31m.test", "second-very-long-host-name.example.org"],
		};
		const card = bash(hostile);
		expect(notes(card)[0]).toBe("blocked by sandbox: hosts a b.test, second-very-long-host-name.example.org");
		expect(card.view.head?.badges?.[0]?.title).toBe("seat belt · workspace-write · network allowlist");
		const raw = card.rows(30, true);
		for (const row of raw) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(30);
			expect(row).not.toContain("\t");
			expect(row).not.toContain("\x1b[31m");
		}
		// Wrapped, not cut: the second host is whole across the rows.
		expect(card.rows(30).join("")).toContain("example.org");
	});

	it("leave uncontained runs unmarked", () => {
		const card = bash(undefined);
		expect(card.view.head?.badges).toBeUndefined();
		expect(notes(card)).toEqual([]);
		expect(card.rows().join("\n")).not.toContain("sandbox");
	});
});

describe("eval results run in the sandbox", () => {
	it("carry the sandboxed badge beside the language and the warning notes after the cells", () => {
		const card = evalCells(SANDBOX);
		expect(card.view.head?.badges).toEqual([{ text: "python" }, BADGE]);
		expect(notes(card)).toEqual(NOTES);
		expect(card.body.map(node => (node.props() as { role?: string }).role)).toEqual([
			"omp.run",
			SANDBOX_NOTE_ROLE,
			SANDBOX_NOTE_ROLE,
		]);
	});

	it("mark the run and show the warnings in a plain terminal, per cell or as one output", () => {
		for (const card of [evalCells(SANDBOX), evalOutput(SANDBOX)]) {
			const text = card.rows().join("\n");
			expect(text).toContain("sandboxed");
			for (const note of NOTES) expect(text).toContain(note);
			expect(notes(card)).toEqual(NOTES);
		}
	});

	it("stay unmarked uncontained", () => {
		for (const card of [evalCells(undefined), evalOutput(undefined)]) {
			expect(card.view.head?.badges).toEqual([{ text: "python" }]);
			expect(notes(card)).toEqual([]);
			expect(card.rows().join("\n")).not.toContain("sandbox");
		}
	});
});
