import { beforeAll, describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { type BashToolDetails, bashToolRenderer } from "@oh-my-pi/pi-tui/tools/bash";
import { evalToolRenderer } from "@oh-my-pi/pi-tui/tools/eval";
import type { RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import type { ToolSandboxMeta } from "@oh-my-pi/pi-tui/tools/sandbox-meta";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { TspSpan } from "@oh-my-pi/pi-wire";

const done: RenderResultOptions = { expanded: false, isPartial: false };
const SANDBOX: ToolSandboxMeta = {
	backend: "seatbelt",
	mode: "workspace-write",
	network: "allowlist",
	blockedHosts: ["example.com", "evil.test"],
	denied: true,
};

let uiTheme: Theme;
beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Expected dark theme");
	uiTheme = dark;
	setThemeInstance(dark);
});

function bashResult(sandbox: ToolSandboxMeta | undefined) {
	return {
		content: [{ type: "text", text: "touch: /etc/x: Operation not permitted" }],
		details: { exitCode: 1, sandbox } satisfies BashToolDetails,
		isError: true,
	};
}

function evalResult(sandbox: ToolSandboxMeta | undefined) {
	return {
		content: [{ type: "text", text: "PermissionError" }],
		details: {
			cells: [
				{
					index: 0,
					code: "open('/etc/x', 'w')",
					language: "python" as const,
					output: "PermissionError",
					status: "error" as const,
				},
			],
			sandbox,
		},
		isError: true,
	};
}

/** Warning-toned text in a native body (the sandbox notes). */
function warnings(body: readonly NativeChild[] | undefined): string[] {
	return (body ?? [])
		.filter((child): child is NativeNode => "k" in child && child.k === "text")
		.map(child => (child.p as { spans?: TspSpan[] } | undefined)?.spans ?? [])
		.filter(spans => spans.some(s => s.s === "warning"))
		.map(spans => spans.map(s => s.t).join(""));
}

function bashLines(sandbox: ToolSandboxMeta | undefined, width = 100): string[] {
	return bashToolRenderer
		.renderResult(bashResult(sandbox), done, uiTheme, { command: "touch /etc/x" })
		.render(width) as string[];
}

describe("bash results run in the sandbox", () => {
	it("carry a sandboxed badge and warning notes for blocked hosts and a likely denial natively", () => {
		const view = bashToolRenderer.describeResult(bashResult(SANDBOX), done, { command: "touch /etc/x" });
		expect(view.tool?.badges).toEqual([
			{ text: "sandboxed", tone: "info", title: "seatbelt · workspace-write · network allowlist" },
		]);
		expect(warnings(view.body)).toEqual([
			"blocked by sandbox: hosts example.com, evil.test",
			"possible sandbox denial",
		]);
	});

	it("draw a dim sandboxed suffix in the card header and the same warnings in a plain terminal", () => {
		const lines = bashLines(SANDBOX).map(line => Bun.stripANSI(line));
		expect(lines[0]).toContain("sandboxed");
		const body = lines.join("\n");
		expect(body).toContain("blocked by sandbox: hosts example.com, evil.test");
		expect(body).toContain("possible sandbox denial");
	});

	it("name a single blocked host, or only the denial, without the other note", () => {
		const single = { ...SANDBOX, blockedHosts: ["one.test"], denied: undefined };
		expect(warnings(bashToolRenderer.describeResult(bashResult(single), done).body)).toEqual([
			"blocked by sandbox: host one.test",
		]);
		const denial = { ...SANDBOX, blockedHosts: undefined };
		expect(warnings(bashToolRenderer.describeResult(bashResult(denial), done).body)).toEqual([
			"possible sandbox denial",
		]);
	});

	it("tell a program that cannot start in the Windows sandbox apart from a denial", () => {
		const startFailed = { ...SANDBOX, blockedHosts: undefined, denied: undefined, startFailed: true };
		expect(warnings(bashToolRenderer.describeResult(bashResult(startFailed), done).body)).toEqual([
			"cannot start in the Windows sandbox (0xC0000142)",
		]);
	});

	it("clean hostile host names and wrap the warning within a narrow card", () => {
		const hostile = { ...SANDBOX, blockedHosts: ["a\tb\x1b[31m.test", "second-very-long-host-name.example.org"] };
		const notes = warnings(bashToolRenderer.describeResult(bashResult(hostile), done).body);
		expect(notes[0]).toBe("blocked by sandbox: hosts a b.test, second-very-long-host-name.example.org");
		const lines = bashLines(hostile, 30);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(30);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\x1b[31m");
		}
		// Wrapped, not cut: the second host is whole across the lines.
		expect(lines.map(line => Bun.stripANSI(line)).join("")).toContain("example.org");
	});

	it("leave uncontained runs unmarked", () => {
		const view = bashToolRenderer.describeResult(bashResult(undefined), done, { command: "touch /etc/x" });
		expect(view.tool?.badges).toBeUndefined();
		expect(warnings(view.body)).toEqual([]);
		expect(bashLines(undefined).join("\n")).not.toContain("sandbox");
	});

	describe("while the command still runs", () => {
		const running: RenderResultOptions = { expanded: false, isPartial: true };
		const live = { backend: "seatbelt", mode: "workspace-write", network: "deny" } satisfies ToolSandboxMeta;
		const partial = (sandbox: ToolSandboxMeta | undefined) => ({
			content: [{ type: "text", text: "building…" }],
			details: { sandbox } satisfies BashToolDetails,
		});

		it("show the same sandboxed badge natively and in a plain terminal", () => {
			const view = bashToolRenderer.describeResult(partial(live), running, { command: "make" });
			expect(view.tool?.badges).toEqual([
				{ text: "sandboxed", tone: "info", title: "seatbelt · workspace-write · network deny" },
			]);
			expect(warnings(view.body)).toEqual([]);
			const lines = bashToolRenderer
				.renderResult(partial(live), running, uiTheme, { command: "make" })
				.render(100) as string[];
			expect(Bun.stripANSI(lines[0])).toContain("sandboxed");
		});

		it("stay unmarked for an uncontained run", () => {
			const view = bashToolRenderer.describeResult(partial(undefined), running, { command: "make" });
			expect(view.tool?.badges).toBeUndefined();
			const lines = bashToolRenderer
				.renderResult(partial(undefined), running, uiTheme, { command: "make" })
				.render(100) as string[];
			expect(lines.join("\n")).not.toContain("sandbox");
		});
	});
});

describe("eval results run in the sandbox", () => {
	it("carry the sandboxed badge beside the language and the warning notes natively", () => {
		const view = evalToolRenderer.describeResult(evalResult(SANDBOX), done);
		expect(view.tool?.badges).toEqual([
			{ text: "python" },
			{ text: "sandboxed", tone: "info", title: "seatbelt · workspace-write · network allowlist" },
		]);
		expect(warnings(view.body)).toEqual([
			"blocked by sandbox: hosts example.com, evil.test",
			"possible sandbox denial",
		]);
	});

	it("mark the run and show the warnings in a plain terminal, and stay unmarked uncontained", () => {
		const text = (sandbox: ToolSandboxMeta | undefined) =>
			evalToolRenderer
				.renderResult(evalResult(sandbox), done, uiTheme)
				.render(100)
				.map(line => Bun.stripANSI(line))
				.join("\n");
		const contained = text(SANDBOX);
		expect(contained).toContain("sandboxed");
		expect(contained).toContain("blocked by sandbox: hosts example.com, evil.test");
		expect(contained).toContain("possible sandbox denial");
		expect(text(undefined)).not.toContain("sandbox");
	});
});
