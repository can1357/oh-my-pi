import { describe, expect, it } from "bun:test";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { type TtsrTool, TtsrToolInspector } from "@oh-my-pi/pi-coding-agent/session/ttsr-outputs";

function rule(name: string, condition: string): Rule {
	return {
		name,
		path: `${name}.md`,
		content: "reminder",
		condition: [condition],
		scope: ["text"],
		_source: { provider: "test", providerName: "test", path: `${name}.md`, level: "project" },
	};
}

const TEXT: TtsrMatchContext = { source: "text" };
/** Many complete lines: past the size where every check rescans the whole buffer. */
const FILLER = "const value = compute(input);\n".repeat(2_000);

function names(rules: Rule[]): string[] {
	return rules.map(match => match.name);
}

describe("TTSR incremental stream matching", () => {
	it("matches a single-line condition split across deltas deep into a long stream", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("forbidden", "FORBIDDEN_\\w+\\("));
		expect(manager.checkDelta(FILLER, TEXT)).toEqual([]);
		expect(manager.checkDelta("call FORBID", TEXT)).toEqual([]);
		expect(manager.checkDelta("DEN_api", TEXT)).toEqual([]);
		expect(names(manager.checkDelta("(1);\nnext", TEXT))).toEqual(["forbidden"]);
		// A match on a completed line stays reported as the stream grows.
		expect(names(manager.checkDelta(" line\n", TEXT))).toEqual(["forbidden"]);
	});

	it("finds a condition spanning lines on the final check of a long stream", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("begin-end", "BEGIN\\s+END"));
		manager.checkDelta(FILLER, TEXT);
		manager.checkDelta("BEGIN\n", TEXT);
		manager.checkDelta("END\n", TEXT);
		expect(names(manager.checkDelta("", TEXT, { final: true }))).toEqual(["begin-end"]);
	});

	it("scans growing snapshots incrementally and fully once final", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("forbidden", "FORBIDDEN"));
		manager.addRule(rule("begin-end", "BEGIN\\s+END"));
		let snapshot = FILLER;
		expect(manager.checkSnapshot(snapshot, TEXT, { final: false })).toEqual([]);
		snapshot += "BEGIN\nEND\nFORB";
		manager.checkSnapshot(snapshot, TEXT, { final: false });
		snapshot += "IDDEN";
		expect(names(manager.checkSnapshot(snapshot, TEXT, { final: false }))).toContain("forbidden");
		expect(names(manager.checkSnapshot(snapshot, TEXT)).sort()).toEqual(["begin-end", "forbidden"]);
		// A rewritten (non-extending) snapshot drops what the old one matched.
		expect(manager.checkSnapshot("clean", TEXT)).toEqual([]);
	});

	it("matches a condition that arrives late in a snapshot growing in small chunks, with linear cost", () => {
		const chunk = "const value = compute(input);\n";
		const run = (chunks: number): number => {
			const manager = new TtsrManager({ enabled: true });
			manager.addRule(rule("forbidden", "FORBIDDEN_\\w+\\("));
			let snapshot = "";
			const start = Bun.nanoseconds();
			for (let index = 0; index < chunks; index++) {
				snapshot += chunk;
				expect(manager.checkSnapshot(snapshot, TEXT, { final: false })).toEqual([]);
			}
			snapshot += "FORBIDDEN_api(1);\n";
			expect(names(manager.checkSnapshot(snapshot, TEXT))).toEqual(["forbidden"]);
			return Bun.nanoseconds() - start;
		};
		const smallNs = Math.min(run(250), run(250), run(250));
		// 8 times the chunks: a full regex rescan per update would take ~64 times as long.
		let largeNs = Number.POSITIVE_INFINITY;
		for (let attempt = 0; attempt < 3 && largeNs >= 32 * smallNs; attempt++) largeNs = Math.min(largeNs, run(2_000));
		expect(largeNs).toBeLessThan(32 * smallNs);
	});
});

describe("TTSR tool inspection cache", () => {
	it("re-inspects arguments an in-band stream grows in place", () => {
		const write: TtsrTool = {
			name: "write",
			matcherDigest: args =>
				args && typeof args === "object" && "content" in args && typeof args.content === "string"
					? args.content
					: undefined,
		};
		const inspector = new TtsrToolInspector(
			() => [write],
			() => "/repo",
		);
		const args: Record<string, unknown> = { path: "src/a", content: "safe" };
		const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: args };
		expect(inspector.digest(toolCall)).toBe("safe");
		expect(inspector.matchContext(toolCall, 0).filePaths).toContain("src/a");

		args.path = "src/a.ts";
		args.content = "safe FORBIDDEN";
		expect(inspector.digest(toolCall)).toBe("safe FORBIDDEN");
		expect(inspector.matchContext(toolCall, 0).filePaths).toContain("src/a.ts");
	});

	it("re-inspects reused arguments rewritten to same-length values, including nested ones", () => {
		const write: TtsrTool = {
			name: "write",
			// Reads a nested field too, so a nested in-place edit changes the digest.
			matcherDigest: args => {
				if (!args || typeof args !== "object" || !("content" in args) || typeof args.content !== "string") {
					return undefined;
				}
				const meta = "meta" in args && args.meta && typeof args.meta === "object" ? args.meta : undefined;
				const mode = meta && "mode" in meta && typeof meta.mode === "string" ? meta.mode : "";
				return `${args.content}:${mode}`;
			},
		};
		const inspector = new TtsrToolInspector(
			() => [write],
			() => "/repo",
		);
		const meta = { mode: "a" };
		const args: Record<string, unknown> = { path: "a.ts", content: "safe", meta };
		const toolCall: ToolCall = { type: "toolCall", id: "call-1", name: "write", arguments: args };
		expect(inspector.digest(toolCall)).toBe("safe:a");
		expect(inspector.matchContext(toolCall, 0).filePaths).toContain("a.ts");

		args.path = "b.ts";
		args.content = "evil";
		expect(inspector.digest(toolCall)).toBe("evil:a");
		expect(inspector.matchContext(toolCall, 0).filePaths).toContain("b.ts");

		meta.mode = "b";
		expect(inspector.digest(toolCall)).toBe("evil:b");
	});
});
