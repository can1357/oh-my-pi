import { beforeAll, describe, expect, it } from "bun:test";
import type { NativeChild, NativeNode } from "@oh-my-pi/pi-tui/native/node";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { toolRenderers } from "@oh-my-pi/pi-tui/tools";
import type { RenderResultOptions } from "@oh-my-pi/pi-tui/tools/renderer";
import {
	type SandboxRequestRenderArgs,
	type SandboxRequestToolDetails,
	sandboxRequestToolRenderer,
} from "@oh-my-pi/pi-tui/tools/sandbox-request";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";

const done: RenderResultOptions = { expanded: false, isPartial: false };
const ARGS: SandboxRequestRenderArgs = {
	kind: "write",
	target: "/work/out",
	intent: "Build into /work/out so the release script finds the bundle.",
};
const ASKED = { kind: "write" as const, intent: ARGS.intent };

let uiTheme: Theme;
beforeAll(async () => {
	const dark = await getThemeByName("dark");
	if (!dark) throw new Error("Expected dark theme");
	uiTheme = dark;
	setThemeInstance(dark);
});

function texts(body: readonly NativeChild[] | undefined): string[] {
	return (body ?? [])
		.filter((child): child is NativeNode => "k" in child && child.k === "text")
		.map(child => ((child.p as { spans?: TspSpan[] } | undefined)?.spans ?? []).map(s => s.t).join(""));
}

function result(details: SandboxRequestToolDetails) {
	return { content: [{ type: "text", text: "" }], details };
}

function ansi(details: SandboxRequestToolDetails, width = 80): string[] {
	return sandboxRequestToolRenderer.renderResult(result(details), done, uiTheme, ARGS).render(width) as string[];
}

describe("sandbox_request tool card", () => {
	it("is the registered renderer for the tool", () => {
		expect(toolRenderers.sandbox_request).toBe(sandboxRequestToolRenderer);
	});

	it("names only the target when streamed args carry an unknown kind", () => {
		const args = { kind: "delete", target: "/work/out" } as unknown as SandboxRequestRenderArgs;
		expect(sandboxRequestToolRenderer.describeCall(args).tool?.target).toBe("/work/out");
	});

	it("shows the request pending while the user decides", () => {
		const view = sandboxRequestToolRenderer.describeCall(ARGS);
		expect(view.tool).toMatchObject({ title: "Sandbox request", target: "write to /work/out" });
		expect(view.tool?.badges).toBeUndefined();
		expect(view.tool?.note).toBeDefined();
		expect(texts(view.body)).toEqual([ARGS.intent!]);
		const call = sandboxRequestToolRenderer
			.renderCall(ARGS, done, uiTheme)
			.render(80)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(call).toContain("write to /work/out");
		expect(call).toContain("Build into /work/out");
	});

	it("badges each decision, with the user's instructions or the refusal reason", () => {
		const cases: [SandboxRequestToolDetails, string, TspTone, string | undefined][] = [
			[
				{ ...ASKED, status: "granted", scope: "session", target: "/work/out" },
				"allowed this session",
				"success",
				undefined,
			],
			[
				{ ...ASKED, status: "granted", scope: "always", target: "/work/out" },
				"always allowed",
				"success",
				undefined,
			],
			[{ ...ASKED, status: "already-allowed", target: "/work/out" }, "already allowed", "muted", undefined],
			[{ ...ASKED, status: "denied", target: "/work/out" }, "denied", "error", undefined],
			[
				{ ...ASKED, status: "instructed", target: "/work/out", instructions: "Use ./build instead." },
				"instructed",
				"warning",
				"Instructions: Use ./build instead.",
			],
			[{ ...ASKED, status: "refused", reason: "protected path" }, "refused", "warning", "Reason: protected path"],
		];
		for (const [details, label, tone, note] of cases) {
			const view = sandboxRequestToolRenderer.describeResult(result(details), done, ARGS);
			expect([details.status, view.tool?.badges]).toEqual([details.status, [{ text: label, tone }]]);
			expect(texts(view.body)).toEqual(note ? [ARGS.intent!, note] : [ARGS.intent!]);
			const card = ansi(details)
				.map(line => Bun.stripANSI(line))
				.join("\n");
			expect(card).toContain(label);
			if (note) expect(card).toContain(note.slice(note.indexOf(": ") + 2));
		}
	});

	it("cleans and bounds the agent's and the user's text", () => {
		const hostile: SandboxRequestToolDetails = {
			kind: "write",
			intent: `tab\there \x1b[31mred ${"long ".repeat(200)}`,
			status: "instructed",
			target: "/work/out\t\x1b[31m",
			instructions: "do\tthis\x1b[31m",
		};
		const lines = ansi(hostile, 40);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(40);
			expect(line).not.toContain("\t");
			expect(line).not.toContain("\x1b[31m");
		}
		// The intent is bounded: the card stays short however long it is.
		expect(lines.length).toBeLessThan(15);
		const described = JSON.stringify(sandboxRequestToolRenderer.describeResult(result(hostile), done));
		expect(described).not.toContain("\\t");
		expect(described).not.toContain("\\u001b");
	});
});
