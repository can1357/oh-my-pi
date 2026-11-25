import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { SandboxResultMeta } from "../../../src/sandbox/types";
import type { BashToolDetails } from "../../../src/tools/details/bash";
import type { EvalToolDetails } from "../../../src/tools/details/eval";
import { type BashArgs, bashPresenter } from "../../../src/ui/tools/bash";
import { type EvalArgs, evalPresenter } from "../../../src/ui/tools/eval";
import { SANDBOX_NOTE_ROLE } from "../../../src/ui/tools/sandbox-meta";
import { type Presented, present, spanText } from "./sandbox-paint";

const OS_NOTICE =
	"[OS sandbox: Network access to blocked.test was refused by the sandbox's allowlist. Expected behaviour: NEVER retry or work around it.]";

/** Every text a node tree carries (output `text`, note spans), in order. */
function allText(nodes: readonly UiNode[]): string {
	const parts: string[] = [];
	const walk = (node: UiNode): void => {
		const props = node.props() as { text?: unknown; spans?: readonly { t: string }[] };
		if (typeof props.text === "string") parts.push(props.text);
		if (props.spans) parts.push(props.spans.map(span => span.t).join(""));
		for (const child of node.children()) walk(child);
	};
	for (const node of nodes) walk(node);
	return parts.join("\n");
}

function bashText(text: string, details: BashToolDetails, isError = false): Presented {
	return present("bash", bashPresenter, { command: "curl blocked.test" } satisfies BashArgs, {
		content: [{ type: "text", text }],
		details,
		isError,
	});
}

function evalText(text: string, details: EvalToolDetails, isError = false): Presented {
	return present(
		"eval",
		evalPresenter,
		{ cells: [{ language: "python", code: "1" }] },
		{ content: [{ type: "text", text }], details, isError },
	);
}

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

describe("bash results run in the sandbox: notices and failure", () => {
	it("strips the trailing OS sandbox notice, so the raw-output footer before it is still found", () => {
		const text = `filtered\n[raw output: local://13.log]\n\nWall time: 0.08 seconds\n\n${OS_NOTICE}\n\nCommand exited with code 1`;
		const card = bashText(text, { exitCode: 1, wallTimeMs: 80, wallTimeNoticeEmitted: true, sandbox: SANDBOX }, true);
		expect(allText(card.body)).toContain("filtered");
		expect(allText(card.body)).not.toContain("OS sandbox");
		expect(allText(card.body)).not.toContain("raw output");
		expect(JSON.stringify(card.view.term)).toContain("local://13.log");
		const rows = card.rows().join("\n");
		expect(rows).not.toContain("OS sandbox");
		expect(rows).not.toContain("raw output:");
	});

	it("keeps a sandbox-looking last line the command printed itself when the run was not sandboxed", () => {
		const text = `ok\n${OS_NOTICE}`;
		expect(allText(bashText(text, {}).body)).toContain("OS sandbox");
		expect(allText(bashText(text, { sandbox: SANDBOX }).body)).not.toContain("OS sandbox");
		expect(bashText(text, {}).rows().join("\n")).toContain("OS sandbox");
		expect(bashText(text, { sandbox: SANDBOX }).rows().join("\n")).not.toContain("OS sandbox");
	});

	it("names the call's own refused hosts and a network that is off, but time-attributed hosts only when it failed", () => {
		const meta: SandboxResultMeta = {
			...SANDBOX,
			denied: undefined,
			blockedHosts: ["other.test", "mine.test"],
			ownBlockedHosts: ["mine.test"],
			networkOff: true,
		};
		const succeeded = bashText("ok", { sandbox: meta });
		expect(notes(succeeded)).toEqual([
			"blocked by sandbox: host mine.test",
			"network is off in the sandbox: this failure likely comes from it",
		]);
		expect(notes(bashText("ok", { exitCode: 1, sandbox: meta }, true))).toEqual([
			"blocked by sandbox: hosts mine.test, other.test",
			"network is off in the sandbox: this failure likely comes from it",
		]);
		const rows = succeeded.rows().join("\n");
		expect(rows).toContain("blocked by sandbox: host mine.test");
		expect(rows).not.toContain("other.test");
	});

	it("decides failure from the exit code, not from the error flag", () => {
		const meta: SandboxResultMeta = { ...SANDBOX, denied: undefined, blockedHosts: ["other.test"] };
		// A timeout is an error result without an exit code: it did not fail the command.
		expect(notes(bashText("ok", { sandbox: meta }, true))).toEqual([]);
		expect(notes(bashText("ok", { exitCode: 0, sandbox: meta }))).toEqual([]);
	});
});

describe("eval results run in the sandbox: notices and failure", () => {
	it("strips the OS sandbox notice and the exit line from output without per-cell results, as bash does", () => {
		const card = evalText(
			`PermissionError\n\n${OS_NOTICE}\n\nCommand exited with code 1`,
			{ language: "python", sandbox: SANDBOX },
			true,
		);
		const view = allText(card.body);
		expect(view).toContain("PermissionError");
		expect(view).not.toContain("OS sandbox");
		expect(view).not.toContain("Command exited");
		const rows = card.rows().join("\n");
		expect(rows).toContain("PermissionError");
		expect(rows).not.toContain("OS sandbox");
	});

	it("keeps a sandbox-looking last line the eval printed itself when the run was not sandboxed", () => {
		const text = `ok\n${OS_NOTICE}`;
		expect(allText(evalText(text, { language: "python" }).body)).toContain("OS sandbox");
		expect(allText(evalText(text, { language: "python", sandbox: SANDBOX }).body)).not.toContain("OS sandbox");
		expect(evalText(text, { language: "python" }).rows().join("\n")).toContain("OS sandbox");
		expect(evalText(text, { language: "python", sandbox: SANDBOX }).rows().join("\n")).not.toContain("OS sandbox");
	});

	it("keeps an exit line the program printed itself on a successful eval, and strips it on a failure", () => {
		const text = "done\nCommand exited with code 1";
		const details: EvalToolDetails = { language: "python", sandbox: SANDBOX };
		expect(allText(evalText(text, details, false).body)).toContain("Command exited with code 1");
		expect(allText(evalText(text, details, true).body)).not.toContain("Command exited");
		expect(allText(evalText(text, details, true).body)).toContain("done");
		expect(allText(evalText(text, { ...details, isError: true }, false).body)).not.toContain("Command exited");
	});

	it("names refused hosts per the call's outcome in a multi-cell run, with one sandboxed marker clipped to the width", () => {
		const meta: SandboxResultMeta = {
			...SANDBOX,
			denied: undefined,
			blockedHosts: ["other.test"],
			ownBlockedHosts: ["mine.test"],
		};
		const cell = (index: number) => ({
			index,
			code: "1",
			language: "python" as const,
			output: "ok",
			status: "complete" as const,
		});
		const run = (isError: boolean): Presented => evalCells2({ cells: [cell(0), cell(1)], sandbox: meta }, isError);
		expect(notes(run(false))).toEqual(["blocked by sandbox: host mine.test"]);
		expect(notes(run(true))).toEqual(["blocked by sandbox: hosts mine.test, other.test"]);
		const wide = run(false).rows(100);
		expect(wide.filter(row => row.includes("sandboxed"))).toHaveLength(1);
		for (const row of run(false).rows(6, true)) expect(visibleWidth(row)).toBeLessThanOrEqual(6);
	});
});

function evalCells2(details: EvalToolDetails, isError: boolean): Presented {
	return present("eval", evalPresenter, {} as EvalArgs, {
		content: [{ type: "text", text: "ok" }],
		details,
		isError,
	});
}
