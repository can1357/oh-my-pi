import { describe, expect, it, vi } from "bun:test";
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
		expect(manager.matchExcerpt("forbidden", TEXT)).toContain("call FORBIDDEN_api(1); next");
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

	it("bounds match excerpts and collapses multiline whitespace without including the whole stream", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("begin-end", "BEGIN\\s+END"));
		const snapshot = `${"before ".repeat(100)}BEGIN\n\tEND${" after".repeat(100)}`;
		expect(names(manager.checkSnapshot(snapshot, TEXT))).toEqual(["begin-end"]);
		const excerpt = manager.matchExcerpt("begin-end", TEXT);
		expect(excerpt).toContain("BEGIN END");
		expect(excerpt).toMatch(/^….*…$/);
		expect(excerpt).not.toMatch(/[\n\t]/);
		expect(excerpt!.length).toBeLessThanOrEqual(242);
	});

	it("limits long regex matches and replaces the excerpt when a snapshot is rewritten", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("long", "TOKEN_\\w+"));
		expect(names(manager.checkSnapshot(`TOKEN_${"x".repeat(1_000)}`, TEXT))).toEqual(["long"]);
		expect(manager.matchExcerpt("long", TEXT)!.length).toBeLessThanOrEqual(241);
		expect(manager.matchExcerpt("long", TEXT)).toEndWith("…");
		expect(names(manager.checkSnapshot("new TOKEN_short context", TEXT))).toEqual(["long"]);
		expect(manager.matchExcerpt("long", TEXT)).toBe("new TOKEN_short context");
	});

	it("keeps settled matches cheap while a non-interrupting rule stays pending", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule({
			...rule("early", "EARLY_HIT"),
			condition: ["NEVER_\\d{3}", "EARLY_HIT"],
			interruptMode: "never",
		});
		manager.checkDelta("EARLY_HIT\n", TEXT);
		const exec = RegExp.prototype.exec;
		let scanned = 0;
		const spy = vi.spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input: string) {
			if (this.source.includes("EARLY_HIT") || this.source.includes("NEVER_")) scanned += input.length;
			return exec.call(this, input);
		});
		try {
			for (let index = 0; index < 2_000; index++) manager.checkDelta("const value = compute(input);\n", TEXT);
			expect(scanned).toBeLessThan(2 * FILLER.length);
			expect(manager.matchExcerpt("early", TEXT)).toBe("EARLY_HIT");
		} finally {
			spy.mockRestore();
		}
	});

	it("omits zero-width excerpts without losing the rule match", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("assertion", "(?=[\\s\\S]*FORBIDDEN)"));
		expect(names(manager.checkSnapshot(`${FILLER}FORBIDDEN`, TEXT))).toEqual(["assertion"]);
		expect(manager.matchExcerpt("assertion", TEXT)).toBeUndefined();
	});

	it("isolates excerpts between streams and discards them at stream boundaries", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule({ ...rule("token", "TOKEN_\\w+"), scope: ["tool"] });
		const first: TtsrMatchContext = { source: "tool", streamKey: "toolcall:first" };
		const second: TtsrMatchContext = { source: "tool", streamKey: "toolcall:second" };
		manager.checkSnapshot("TOKEN_first", first);
		manager.checkSnapshot("TOKEN_second", second);
		expect(manager.matchExcerpt("token", first)).toBe("TOKEN_first");
		expect(manager.matchExcerpt("token", second)).toBe("TOKEN_second");
		manager.clearStream(first.streamKey!);
		expect(manager.matchExcerpt("token", first)).toBeUndefined();
		expect(manager.matchExcerpt("token", second)).toBe("TOKEN_second");
		manager.resetBuffer();
		expect(manager.matchExcerpt("token", second)).toBeUndefined();
	});

	it("matches a condition that arrives late in a snapshot growing in small chunks, scanning each chunk once", () => {
		const manager = new TtsrManager({ enabled: true });
		manager.addRule(rule("forbidden", "FORBIDDEN_\\w+\\("));
		// Count regex input instead of timing it: wall-clock ratios flake under load.
		const test = RegExp.prototype.test;
		let scanned = 0;
		const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
			if (this.source.includes("FORBIDDEN_")) scanned += input.length;
			return test.call(this, input);
		});
		try {
			let snapshot = "";
			for (let index = 0; index < 2_000; index++) {
				snapshot += "const value = compute(input);\n";
				expect(manager.checkSnapshot(snapshot, TEXT, { final: false })).toEqual([]);
			}
			snapshot += "FORBIDDEN_api(1);\n";
			expect(names(manager.checkSnapshot(snapshot, TEXT))).toEqual(["forbidden"]);
			// Every chunk is read; a whole-buffer rescan per update would read the stream ~1000 times over.
			expect(scanned).toBeGreaterThanOrEqual(snapshot.length);
			expect(scanned).toBeLessThan(2 * snapshot.length);
		} finally {
			spy.mockRestore();
		}
	});

	describe("one long unterminated line (raw tool-argument JSON escapes its newlines)", () => {
		const TOOL: TtsrMatchContext = { source: "tool", toolName: "bash", streamKey: "toolcall:long-line" };
		const DELTA = 16;

		function toolRule(name: string, condition: string): Rule {
			return { ...rule(name, condition), scope: ["tool"] };
		}

		function stream(manager: TtsrManager, wire: string): Rule[][] {
			const results: Rule[][] = [];
			for (let offset = 0; offset < wire.length; offset += DELTA) {
				results.push(manager.checkDelta(wire.slice(offset, offset + DELTA), TOOL));
			}
			return results;
		}

		it("reads the line a bounded number of times instead of once per delta", () => {
			const manager = new TtsrManager({ enabled: true });
			manager.addRule(toolRule("force-push", "git\\s+push\\s+--force"));
			const wire = JSON.stringify({ command: "echo ok\n".repeat(8_192) });
			const test = RegExp.prototype.test;
			let scanned = 0;
			const spy = vi.spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string) {
				if (this.source.includes("push")) scanned += input.length;
				return test.call(this, input);
			});
			try {
				for (const matches of stream(manager, wire)) expect(matches).toEqual([]);
				expect(manager.checkDelta("", TOOL, { final: true })).toEqual([]);
				// Rescanning the whole line on every 16-character delta reads it ~2000 times over.
				expect(scanned).toBeGreaterThanOrEqual(wire.length);
				expect(scanned).toBeLessThan(16 * wire.length);
			} finally {
				spy.mockRestore();
			}
		});

		it("still reports a match deep in the line mid-stream, and exactly on the final check", () => {
			const filler = "echo ok\n".repeat(4_096);
			const wire = JSON.stringify({ command: `${filler}git push --force origin main\n${filler}` });
			const matchEnd = wire.indexOf("--force") + "--force".length;

			const manager = new TtsrManager({ enabled: true });
			manager.addRule(toolRule("force-push", "git\\s+push\\s+--force"));
			const results = stream(manager, wire);
			const firstHit = results.findIndex(matches => names(matches).includes("force-push"));
			expect(firstHit).toBeGreaterThanOrEqual(0);
			// Deferred scans may report late, but within a quarter of the line's growth, never before the text exists.
			expect(firstHit * DELTA + DELTA).toBeGreaterThanOrEqual(matchEnd);
			expect(firstHit * DELTA).toBeLessThanOrEqual(matchEnd * 1.25 + DELTA);

			const finalOnly = new TtsrManager({ enabled: true });
			finalOnly.addRule(toolRule("force-push", "git\\s+push\\s+--force"));
			const cut = matchEnd + 64;
			stream(finalOnly, wire.slice(0, cut));
			expect(names(finalOnly.checkDelta("", TOOL, { final: true }))).toEqual(["force-push"]);
		});
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
