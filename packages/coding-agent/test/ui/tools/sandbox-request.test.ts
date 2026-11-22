import { describe, expect, it } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { TspTone } from "@oh-my-pi/pi-wire";
import type { SandboxRequestToolDetails } from "../../../src/tools/sandbox-request";
import { type SandboxRequestArgs, sandboxRequestPresenter } from "../../../src/ui/tools/sandbox-request";
import { type Presented, present, spanText, theme } from "./sandbox-paint";

const ARGS: SandboxRequestArgs = {
	kind: "write",
	target: "/work/out",
	intent: "Build into /work/out so the release script finds the bundle.",
};
const ASKED = { kind: "write" as const, intent: ARGS.intent };

function call(args: SandboxRequestArgs): Presented {
	return present("sandbox_request", sandboxRequestPresenter, args);
}

function answered(details: SandboxRequestToolDetails | undefined, isError = false, args = ARGS): Presented {
	return present("sandbox_request", sandboxRequestPresenter, args, {
		content: [{ type: "text", text: details ? "" : "Invalid arguments" }],
		details,
		isError,
	});
}

function texts(presented: Presented): string[] {
	return presented.body.map(spanText);
}

/** The terminal head row (the frame's top edge). */
function headRow(presented: Presented): string {
	return presented.rows(80).find(row => row.includes("Sandbox request")) ?? "";
}

describe("sandbox_request tool card", () => {
	it("names only the target when streamed args carry an unknown kind", () => {
		for (const kind of ["delete", "constructor", "toString"]) {
			const args = { kind, target: "/work/out" } as unknown as SandboxRequestArgs;
			expect([kind, call(args).view.head?.target]).toEqual([kind, "/work/out"]);
		}
	});

	it("names host and exec targets as given, with their verbs", () => {
		expect(call({ kind: "host", target: "registry.npmjs.org" }).view.head?.target).toBe(
			"connect to registry.npmjs.org",
		);
		expect(call({ kind: "exec", target: "git commit" }).view.head?.target).toBe("perform git commit");
	});

	it("shows the request waiting while the user decides", () => {
		const card = call(ARGS);
		expect(card.view.head).toMatchObject({
			title: "Sandbox request",
			target: "write to /work/out",
			note: "waiting for your answer",
		});
		expect(card.view.head?.badges).toBeUndefined();
		expect(card.view.tone).toBeUndefined();
		expect(texts(card)).toEqual([ARGS.intent!]);
		const text = card.rows().join("\n");
		expect(text).toContain("write to /work/out");
		expect(text).toContain("waiting for your answer");
		expect(text).toContain("Build into /work/out");
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
			const card = answered(details);
			expect([details.status, card.view.head?.badges]).toEqual([details.status, [{ text: label, tone }]]);
			expect([details.status, card.view.head?.note]).toEqual([details.status, undefined]);
			expect(texts(card)).toEqual(note ? [ARGS.intent!, note] : [ARGS.intent!]);
			const text = card.rows().join("\n");
			expect(text).toContain(label);
			expect(text).not.toContain("waiting for your answer");
			if (note) {
				expect(text).toContain(note.slice(0, note.indexOf(":")));
				expect(text).toContain(note.slice(note.indexOf(": ") + 2));
			}
		}
	});

	it("marks the card with the decision's icon and tone: refused and instructed warn, denied errors, allowed succeeds", () => {
		const cases: [SandboxRequestToolDetails, string, TspTone | undefined][] = [
			[{ ...ASKED, status: "granted", scope: "session", target: "/work/out" }, "status.success", undefined],
			[{ ...ASKED, status: "already-allowed", target: "/work/out" }, "status.success", undefined],
			[{ ...ASKED, status: "denied", target: "/work/out" }, "status.error", "error"],
			[
				{ ...ASKED, status: "instructed", target: "/work/out", instructions: "Use ./build." },
				"status.warning",
				"warning",
			],
			[{ ...ASKED, status: "refused", reason: "protected path" }, "status.warning", "warning"],
		];
		for (const [details, icon, tone] of cases) {
			const card = answered(details);
			expect([details.status, headRow(card)]).toEqual([
				details.status,
				expect.stringContaining(`${theme.symbols.symbol(icon)} Sandbox request`),
			]);
			expect([details.status, card.view.tone]).toEqual([details.status, tone]);
		}
	});

	it("marks a thrown tool (isError, no details) as an error, not as the refusal fallback's warning", () => {
		const thrown = answered(undefined, true);
		expect(headRow(thrown)).toContain(`${theme.symbols.symbol("status.error")} Sandbox request`);
		expect(thrown.view.tone).toBe("error");
		expect(texts(thrown)).toContain("Reason: Invalid arguments");
		// The same fallback without the error flag stays a refusal: a warning.
		expect(answered(undefined, false).view.tone).toBe("warning");
	});

	it("cleans and bounds the agent's and the user's text", () => {
		const hostile: SandboxRequestToolDetails = {
			kind: "write",
			intent: `tab\there \x1b[31mred ${"long ".repeat(200)}`,
			status: "instructed",
			target: "/work/out\t\x1b[31m",
			instructions: "do\tthis\rnow\x1b[31m",
		};
		const card = answered(hostile);
		const raw = card.rows(40, true);
		for (const row of raw) {
			expect(visibleWidth(row)).toBeLessThanOrEqual(40);
			expect(row).not.toContain("\t");
			expect(row).not.toContain("\x1b[31m");
		}
		// The intent is bounded: the card stays short however long it is.
		expect(raw.length).toBeLessThan(15);
		expect(card.rows(40).join("\n")).toContain("…");
		expect(card.view.head?.target).toBe("write to /work/out");
		expect(texts(card)[1]).toBe("Instructions: do this now");
		const intent = texts(card)[0]!;
		expect(intent.startsWith("tab here red long")).toBe(true);
		expect(intent.length).toBeLessThanOrEqual(1000);
		for (const text of texts(card)) {
			expect(text).not.toContain("\t");
			expect(text).not.toContain("\x1b");
			expect(text).not.toContain("\r");
		}
	});
});
