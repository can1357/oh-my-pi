import { describe, expect, it } from "bun:test";
import * as vm from "node:vm";
import { $which } from "@oh-my-pi/pi-utils";
import { JAVASCRIPT_PRELUDE_SOURCE } from "../../src/eval/js/shared/prelude";
import { PYTHON_PRELUDE } from "../../src/eval/py/prelude";

/**
 * The RLM decomposition helpers (llm_query/llm_query_batched, rlm_query/
 * rlm_query_batched, chunk, search, metadata) live inside the eval preludes and
 * are not directly importable into Bun. We exercise the real shipped source
 * with the two existing prelude-test harnesses:
 *
 *  - JS: execute JAVASCRIPT_PRELUDE_SOURCE verbatim in a throwaway VM context
 *    with only the host bridge (`__omp_call_tool__`) stubbed (mirrors
 *    test/eval/prelude-agent.test.ts), so llm/rlm delegation is asserted via a
 *    spy on the loopback bridge rather than a re-implementation.
 *  - Python: run PYTHON_PRELUDE in a python3 subprocess with the `__omp_display`
 *    stub injected (mirrors test/eval/py/prelude.test.ts).
 */

function loadJsPrelude(callTool: (name: string, args: unknown) => Promise<unknown>): Record<string, unknown> {
	const sandbox: Record<string, unknown> = { __omp_call_tool__: callTool };
	vm.createContext(sandbox);
	vm.runInContext(JAVASCRIPT_PRELUDE_SOURCE, sandbox);
	return sandbox;
}

type ChunkFn = (text: string, opts?: Record<string, unknown>) => string[];
type SearchFn = (
	text: string,
	pattern: string,
	flags?: string | Record<string, unknown>,
	...rest: unknown[]
) => string[];
type MetadataFn = (text: unknown) => Record<string, unknown>;
type LlmQueryFn = (snippet: string, opts?: Record<string, unknown>) => Promise<unknown>;
type RlmQueryFn = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

/** A bridge stub that records calls and answers `__concurrency__` so parallel() fans out immediately. */
function recordingBridge() {
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	let counter = 0;
	const stub = async (name: string, args: unknown) => {
		calls.push({ name, args: (args ?? {}) as Record<string, unknown> });
		if (name === "__concurrency__") return { limit: 0 };
		counter += 1;
		return { text: `reply-${counter}` };
	};
	return { calls, stub };
}

describe("eval JS RLM helpers", () => {
	it("chunk splits by lines and joins with \\n", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		expect(chunk("a\nb\nc")).toEqual(["a\nb\nc"]); // size defaults to 100 > input
		expect(chunk("a\nb\nc", { size: 2 })).toEqual(["a\nb", "c"]);
		expect(chunk("a\nb\nc", { size: 1 })).toEqual(["a", "b", "c"]);
	});

	it("chunk by lines preserves __splitlines semantics on CRLF, trailing newlines, and uneven sizes", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// The incremental line scan must match the previous
		// __splitlines() + slice/join behavior exactly: \r\n|\r|\n are the
		// only boundaries, and a trailing terminator yields no empty last line.
		expect(chunk("a\r\nb\r\nc", { size: 2 })).toEqual(["a\nb", "c"]);
		expect(chunk("a\nb\n", { size: 1 })).toEqual(["a", "b"]); // trailing \n dropped
		expect(chunk("a\r\nb\r\n", { size: 1 })).toEqual(["a", "b"]); // trailing CRLF dropped
		expect(chunk("a\rb\nc", { size: 2 })).toEqual(["a\nb", "c"]); // lone \r boundary
		expect(chunk("\n\n", { size: 1 })).toEqual(["", ""]); // internal blank lines kept
		expect(chunk("a\n\nb", { size: 1 })).toEqual(["a", "", "b"]);
	});

	it("chunk splits 'tokens' mode into character-bounded windows (~4 chars/token)", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// size=2 -> maxChars=8; each window is a hard character slice, not a
		// word-boundary split, so it stays bounded regardless of whitespace.
		expect(chunk("a b c d", { by: "tokens", size: 2 })).toEqual(["a b c d"]);
		expect(chunk("a b c d e f g h", { by: "tokens", size: 2 })).toEqual(["a b c d ", "e f g h"]);
	});

	it("chunk 'tokens' mode bounds a single unbroken run with no whitespace", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// The exact failure mode this bounds: one giant minified/base64 line
		// that word-splitting would leave as a single unbounded chunk.
		const unbroken = "x".repeat(1000);
		const chunks = chunk(unbroken, { by: "tokens", size: 10 });
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
		expect(chunks.join("")).toBe(unbroken);
	});

	it("chunk 'tokens' mode never splits a surrogate pair", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		// U+1F600 (😀) is a non-BMP code point encoded as a UTF-16 surrogate
		// pair. Pad so a naive maxChars=8 (size=2) UTF-16-unit slice would land
		// mid-pair; code-point-aware splitting must keep every emoji intact.
		const text = `ab${"\u{1F600}".repeat(6)}cd`;
		const chunks = chunk(text, { by: "tokens", size: 2 });
		expect(chunks.join("")).toBe(text);
		for (const c of chunks)
			expect(c).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
	});

	it("chunk returns [] for empty text and rejects invalid by/size", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const chunk = sandbox.chunk as ChunkFn;
		expect(chunk("")).toEqual([]);
		expect(chunk("", { by: "tokens" })).toEqual([]);
		expect(() => chunk("a\nb", { by: "bogus" })).toThrow();
		expect(() => chunk("a\nb", { size: 0 })).toThrow();
		expect(() => chunk("a\nb", { size: -3 })).toThrow();
	});

	it("search returns L<lineno>: <rstripped line> for matches and [] when none match", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		expect(search("foo bar\nbaz\nfoo baz  ", "foo")).toEqual(["L1: foo bar", "L3: foo baz"]);
		expect(search("abc", "zzz")).toEqual([]);
		expect(search("Foo\nfoo", "foo")).toEqual(["L2: foo"]); // case-sensitive by default
		expect(search("Foo\nfoo", "foo", "i")).toEqual(["L1: Foo", "L2: foo"]); // flags honored
	});

	it("search scans lines incrementally with split semantics on CRLF, blank lines, and trailing newlines", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		expect(search("", "x")).toEqual([]); // empty payload
		expect(search("no newline", "newline")).toEqual(["L1: no newline"]);
		expect(search("a\r\nb\rc\nd\n", "b")).toEqual(["L2: b"]); // CRLF, lone \r, trailing \n
		expect(search("foo\n\nfoo", "foo")).toEqual(["L1: foo", "L3: foo"]); // blank line keeps numbering
		expect(search("same same\nsame", "same")).toEqual(["L1: same same", "L2: same"]); // one entry per matching line
		expect(search("  pad  \n\t", "pad")).toEqual(["L1:   pad"]); // trailing whitespace trimmed, leading kept
	});

	it("search resets lastIndex per line for stateful g/y flags", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		// Without a per-line reset, the stateful pattern resumes after the
		// first match position and misses the match on the next line entirely.
		expect(search("aaa\na", "a", "g")).toEqual(["L1: aaa", "L2: a"]);
		expect(search("aaa\na", "a", "y")).toEqual(["L1: aaa", "L2: a"]);
	});

	it("search caps results at limit and stops scanning once the cap is hit", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		// Below the cap the result is identical to the unbounded behavior.
		expect(search("a\nb\nc\nd\ne", "a|c", { limit: 5 })).toEqual(["L1: a", "L3: c"]);
		// Over the cap: first `limit` matches plus a truncation marker; the
		// scan stops the moment the cap is hit, so the result list cannot
		// grow past limit+1 entries no matter how many lines match.
		expect(search("a\nb\nc\nd\ne", "a|c|e", { limit: 2 })).toEqual([
			"L1: a",
			"L3: c",
			"... (truncated, more matches may exist)",
		]);
		// A scan that ends exactly at the cap (no lines left unexamined) is
		// not truncated, so no marker is appended.
		expect(search("a\nb\n", "a|b", { limit: 2 })).toEqual(["L1: a", "L2: b"]);
		expect(search("a\nb", "a|b", { limit: 2 })).toEqual(["L1: a", "L2: b"]);
		// Positional flags still work; limit can ride along positionally too.
		expect(search("Foo\nfoo", "foo", "i", 1)).toEqual(["L1: Foo", "... (truncated, more matches may exist)"]);
		// Invalid limits are rejected like chunk()'s size.
		expect(() => search("a\nb", "a", { limit: 0 })).toThrow();
		expect(() => search("a\nb", "a", { limit: -1 })).toThrow();
		expect(() => search("a\nb", "a", { limit: 1.5 })).toThrow();
		expect(() => search("a\nb", "a", { limit: "5" })).toThrow();
	});

	it("search truncates oversized matching lines to max_line_chars and leaves short lines intact", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		const long = "y".repeat(5000);
		// Short lines pass through unchanged (default cap is 1000).
		expect(search("short\n", "short")).toEqual(["L1: short"]);
		// A single oversized matching line keeps a bounded window instead of
		// being copied whole — the failure mode where one minified
		// JSON/base64 line duplicates the payload. The match sits at offset
		// 0, so the window is the line prefix and the offset annotation
		// reads L1@0.
		expect(search(long, "y")).toEqual([`L1@0: ${"y".repeat(1000)}... (line truncated)`]);
		// The cap is configurable; every matching line is truncated, and the
		// count cap (limit) still applies on top.
		const two = `${long}\n${long}`;
		expect(search(two, "y", { max_line_chars: 20 })).toEqual([
			`L1@0: ${"y".repeat(20)}... (line truncated)`,
			`L2@0: ${"y".repeat(20)}... (line truncated)`,
		]);
		expect(search(`${long}\n${long}\n${long}`, "y", { limit: 1, max_line_chars: 10 })).toEqual([
			`L1@0: ${"y".repeat(10)}... (line truncated)`,
			"... (truncated, more matches may exist)",
		]);
		// Trailing whitespace is trimmed before the cap applies; numbering
		// stays intact across blank lines.
		expect(search(`\n${long}  `, "y", { max_line_chars: 5 })).toEqual([
			`L2@0: ${"y".repeat(5)}... (line truncated)`,
		]);
		// The new option also rides positionally after flags/limit, like
		// limit itself did when it was added. (A payload ending exactly at
		// the cap is not marked, so keep a remaining line to see the marker.)
		expect(search(`${long}\n${long}`, "y", "g", 1, 8)).toEqual([
			`L1@0: ${"y".repeat(8)}... (line truncated)`,
			"... (truncated, more matches may exist)",
		]);
		// Invalid caps are rejected like invalid limits.
		expect(() => search("a\nb", "a", { max_line_chars: 0 })).toThrow();
		expect(() => search("a\nb", "a", { max_line_chars: -1 })).toThrow();
		expect(() => search("a\nb", "a", { max_line_chars: 1.5 })).toThrow();
	});

	it("search keeps a bounded window around the first match in oversized lines", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		// Match near the END of an oversized single line (e.g. a key at the
		// tail of minified JSON): a prefix cut would drop the matched region
		// entirely, so the excerpt must be a window centered on the match,
		// annotated with the window's character offset (L<n>@<offset>:) and
		// "..." markers on the cut sides.
		const head = "a".repeat(2000);
		const tail = "b".repeat(3000);
		const line = head + tail; // first "b" at offset 2000
		expect(search(line, "b")).toEqual([`L1@1500: ...${"a".repeat(500)}${"b".repeat(500)}... (line truncated)`]);
		// A match at the very END of the line: the window shifts right to
		// the line end (no right cut, so no "... (line truncated)" suffix).
		const end = "z".repeat(3000) + "K";
		expect(search(end, "K")).toEqual([`L1@2001: ...${"z".repeat(999)}K`]);
		// Multiple matches: the window is centered on the FIRST match only.
		const multi = "z".repeat(100) + "m" + "z".repeat(1899) + "m" + "z".repeat(2000);
		expect(search(multi, "m")).toEqual([`L1@0: ${"z".repeat(100)}m${"z".repeat(899)}... (line truncated)`]);
		// Stateful g/y flags keep their per-line lastIndex reset on oversized
		// lines: every matching line is reported with its own window.
		expect(search(`${line}\n${line}`, "b", "g")).toEqual([
			`L1@1500: ...${"a".repeat(500)}${"b".repeat(500)}... (line truncated)`,
			`L2@1500: ...${"a".repeat(500)}${"b".repeat(500)}... (line truncated)`,
		]);
		// Sticky mode only matches at offset 0, so a line starting with the
		// pattern keeps the window anchored to the prefix.
		const sticky = "b".repeat(3000) + "a".repeat(2000);
		expect(search(`${sticky}\n${sticky}`, "b", "y")).toEqual([
			`L1@0: ${"b".repeat(1000)}... (line truncated)`,
			`L2@0: ${"b".repeat(1000)}... (line truncated)`,
		]);
	});

	it("search windows never split a surrogate pair at a truncation boundary", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const search = sandbox.search as SearchFn;
		// The exact Codex repro: repeated emoji (each a UTF-16 surrogate
		// pair) followed by K, with a max_line_chars window that would end
		// mid-pair. The offset annotation moves to the adjusted code-point
		// boundary and the excerpt keeps whole emoji (before the fix the
		// slice started on a lone low surrogate and ended on a lone high).
		const emoji = "\u{1F600}".repeat(2000) + "K";
		expect(search(emoji, "K", { max_line_chars: 4 })).toEqual(["L1@3996: ...\u{1F600}\u{1F600}K"]);

		// Sweep window sizes and emoji placements: every emitted window must
		// hold no lone surrogate half, stay contiguous with its annotated
		// (adjusted) offset, and still cover the first match.
		const loneHalf = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
		const cases: Array<[string, string]> = [
			// emoji at the start, middle, and end of an oversized line
			["\u{1F600}" + "x".repeat(3000), "x"],
			["x".repeat(1500) + "\u{1F600}" + "x".repeat(1500), "x"],
			["x".repeat(3000) + "\u{1F600}", "\u{1F600}"],
			// match inside astral text
			["\u{1F600}".repeat(1000) + "needle" + "\u{1F600}".repeat(1000), "needle"],
			// match directly before / after an emoji (window edges land on
			// the pair's halves)
			["x".repeat(2000) + "m" + "\u{1F600}" + "x".repeat(2000), "m"],
			["x".repeat(2000) + "\u{1F600}" + "m" + "x".repeat(2000), "m"],
		];
		for (const [line, pattern] of cases) {
			for (const maxLineChars of [1, 2, 3, 4, 5, 7, 8]) {
				const entries = search(line, pattern, { max_line_chars: maxLineChars });
				const firstMatch = line.indexOf(pattern);
				expect(entries).toHaveLength(1);
				const ann = /^L\d+@(\d+): /.exec(entries[0]!);
				expect(ann).not.toBeNull();
				const offset = Number(ann![1]);
				let windowText = entries[0]!.slice(ann![0].length);
				if (offset > 0 && windowText.startsWith("...")) windowText = windowText.slice(3);
				if (windowText.endsWith("... (line truncated)")) {
					windowText = windowText.slice(0, -"... (line truncated)".length);
				}
				expect(windowText).not.toMatch(loneHalf);
				expect(line.slice(offset).startsWith(windowText)).toBe(true);
				expect(offset).toBeLessThanOrEqual(firstMatch);
				expect(firstMatch).toBeLessThan(offset + windowText.length);
			}
		}
		// Stateful g/y flags still reset per line and keep every window
		// surrogate-safe.
		const two = `${emoji}\n${emoji}`;
		expect(search(two, "K", { flags: "g", max_line_chars: 4 })).toEqual([
			"L1@3996: ...\u{1F600}\u{1F600}K",
			"L2@3996: ...\u{1F600}\u{1F600}K",
		]);
		// Sticky mode only matches at offset 0; the window anchored to the
		// line start keeps the leading emoji pair intact.
		expect(search(two, "\u{1F600}", { flags: "y", max_line_chars: 4 })).toEqual([
			"L1@0: \u{1F600}\u{1F600}... (line truncated)",
			"L2@0: \u{1F600}\u{1F600}... (line truncated)",
		]);
	});

	it("metadata reports str shape", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const metadata = sandbox.metadata as MetadataFn;
		expect(metadata("hi there\nworld")).toEqual({
			type: "str",
			chars: 14,
			lines: 2,
			words: 3,
			approx_tokens: 3, // 14 // 4
		});
	});

	it("metadata sizes iterable and array-like list inputs in one pass", () => {
		const sandbox = loadJsPrelude(async () => ({}));
		const metadata = sandbox.metadata as MetadataFn;
		function* gen() {
			yield "ab";
			yield "cde";
		}
		// No Array.from: generators are consumed once (items counted as they
		// stream) and array-likes are indexed by numeric length — both must
		// report the same shape as a plain array.
		expect(metadata(["ab", "cde"])).toEqual({ type: "list", items: 2, chars: 5, approx_tokens: 1 });
		expect(metadata(gen())).toEqual({ type: "list", items: 2, chars: 5, approx_tokens: 1 });
		expect(metadata({ length: 2, 0: "ab", 1: "cde" })).toEqual({ type: "list", items: 2, chars: 5, approx_tokens: 1 });
		expect(metadata([])).toEqual({ type: "list", items: 0, chars: 0, approx_tokens: 0 });
	});

	it("llm_query delegates to completion, prefixing instructions when given", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.llm_query as LlmQueryFn)("the code", { instructions: "explain this" });
		expect(out).toBe("reply-1");
		const completion = calls.filter(c => c.name === "__completion__");
		expect(completion).toHaveLength(1);
		expect(completion[0]!.args).toEqual({ prompt: "explain this\n\nthe code", model: "default" });
	});

	it("llm_query sends bare snippet when instructions are omitted", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		await (sandbox.llm_query as LlmQueryFn)("just code");
		expect(calls.filter(c => c.name === "__completion__")[0]!.args).toEqual({
			prompt: "just code",
			model: "default",
		});
	});

	it("llm_query renders the llm_query.md template exactly like the old inline construction", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		// Empty instructions still prefix the two newlines, exactly as the
		// previous `${instructions}\n\n${snippet}` construction did.
		await (sandbox.llm_query as LlmQueryFn)("code", { instructions: "" });
		expect(calls.filter(c => c.name === "__completion__")[0]!.args).toEqual({
			prompt: "\n\ncode",
			model: "default",
		});
		// Payloads that themselves contain the placeholder tokens are never
		// re-scanned: the single-pass render replaces only the template's own
		// {{instructions}}/{{snippet}} placeholders, so both values survive
		// byte-for-byte (and $ patterns are not special).
		calls.length = 0;
		await (sandbox.llm_query as LlmQueryFn)("see {{instructions}} $& here", {
			instructions: "a {{snippet}} b",
		});
		expect(calls.filter(c => c.name === "__completion__")[0]!.args.prompt).toBe(
			"a {{snippet}} b\n\nsee {{instructions}} $& here",
		);
		// Multi-line values keep their newlines verbatim.
		calls.length = 0;
		await (sandbox.llm_query as LlmQueryFn)("l1\nl2", { instructions: "i1\ni2" });
		expect(calls.filter(c => c.name === "__completion__")[0]!.args.prompt).toBe("i1\ni2\n\nl1\nl2");
	});

	it("llm_query_batched fans out through parallel and preserves order", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.llm_query_batched as (p: string[], o?: Record<string, unknown>) => Promise<unknown[]>)(
			["a", "b"],
			{ model: "smol" },
		);
		expect(out).toEqual(["reply-1", "reply-2"]);
		const completions = calls.filter(c => c.name === "__completion__");
		expect(completions.map(c => c.args.prompt)).toEqual(["a", "b"]);
		for (const c of completions) expect(c.args.model).toBe("smol");
	});

	it("rlm_query delegates to agent() with no agent field, resolving the session's spawn-policy default", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.rlm_query as RlmQueryFn)("solve this");
		expect(out).toBe("reply-1");
		const agentCall = calls.filter(c => c.name === "__agent__");
		expect(agentCall).toHaveLength(1);
		expect(agentCall[0]!.args).toEqual({ prompt: "solve this", handle: false });
	});

	it("rlm_query forwards an explicit agent override", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		await (sandbox.rlm_query as RlmQueryFn)("solve this", { agent: "scout" });
		const agentCall = calls.filter(c => c.name === "__agent__");
		expect(agentCall[0]!.args).toEqual({ prompt: "solve this", agent: "scout", handle: false });
	});

	it("rlm_query_batched fans out through parallel and preserves order", async () => {
		const { calls, stub } = recordingBridge();
		const sandbox = loadJsPrelude(stub);
		const out = await (sandbox.rlm_query_batched as (p: string[], o?: Record<string, unknown>) => Promise<unknown[]>)(
			["q1", "q2"],
			{ agent: "scout" },
		);
		expect(out).toEqual(["reply-1", "reply-2"]);
		const agentCalls = calls.filter(c => c.name === "__agent__");
		expect(agentCalls.map(c => c.args.prompt)).toEqual(["q1", "q2"]);
		for (const c of agentCalls) expect(c.args.agent).toBe("scout");
	});
});

describe("eval Python RLM helpers", () => {
	const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

	async function run(code: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
		const prelude = PYTHON_PRELUDE.replace(
			"from __future__ import annotations",
			"from __future__ import annotations\n__omp_display = lambda *args, **kwargs: None",
		);
		const proc = Bun.spawn([pythonPath, "-c", `${prelude}\n${code}`], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
	}

	it("chunk splits by lines and tokens with the documented boundaries", async () => {
		const r = await run(`
import json
print(json.dumps(chunk("a\\nb\\nc")))
print(json.dumps(chunk("a\\nb\\nc", size=2)))
print(json.dumps(chunk("a b c d", by="tokens", size=2)))
print(json.dumps(chunk("")))
print(json.dumps(chunk("", by="tokens")))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(["a\nb\nc"]);
		expect(JSON.parse(lines[1]!)).toEqual(["a\nb", "c"]);
		// "a b c d" is 7 chars; size=2 -> max_chars=8, so it fits one window.
		expect(JSON.parse(lines[2]!)).toEqual(["a b c d"]);
		expect(JSON.parse(lines[3]!)).toEqual([]);
		expect(JSON.parse(lines[4]!)).toEqual([]);
	});

	it("chunk by lines preserves splitlines semantics on CRLF, Unicode separators, and uneven sizes", async () => {
		const r = await run(`
import json
print(json.dumps(chunk("a\\r\\nb\\r\\nc", size=2)))
print(json.dumps(chunk("a\\nb\\n", size=1)))
print(json.dumps(chunk("\\n\\n", size=1)))
print(json.dumps(chunk("a\\n\\nb", size=1)))
print(json.dumps(chunk("a\\u2028b\\u2029c", size=2)))
print(json.dumps(chunk("a\\v\\fb\\x85c", size=2)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(["a\nb", "c"]);
		expect(JSON.parse(lines[1]!)).toEqual(["a", "b"]);
		expect(JSON.parse(lines[2]!)).toEqual(["", ""]);
		expect(JSON.parse(lines[3]!)).toEqual(["a", "", "b"]);
		expect(JSON.parse(lines[4]!)).toEqual(["a\nb", "c"]);
		expect(JSON.parse(lines[5]!)).toEqual(["a\n", "b\nc"]); // \v and \f are adjacent boundaries -> blank line
	});

	it("chunk 'tokens' mode bounds a single unbroken run with no whitespace", async () => {
		const r = await run(`
import json
print(json.dumps(chunk("x" * 1000, by="tokens", size=10)))
`);
		expect(r.exitCode).toBe(0);
		const chunks = JSON.parse(r.stdout.trim().split("\n")[0]!) as string[];
		expect(chunks.length).toBeGreaterThan(1);
		for (const c of chunks) expect(c.length).toBeLessThanOrEqual(40);
		expect(chunks.join("")).toBe("x".repeat(1000));
	});

	it("chunk rejects invalid by and non-positive size", async () => {
		const badBy = await run(`chunk("a\\nb", by="bogus")`);
		expect(badBy.exitCode).not.toBe(0);
		expect(badBy.stderr).toContain("ValueError");

		const badSize = await run(`chunk("a\\nb", size=0)`);
		expect(badSize.exitCode).not.toBe(0);
		expect(badSize.stderr).toContain("ValueError");
	});

	it("search returns 1-indexed L<lineno>: <rstripped line> matches and [] otherwise", async () => {
		const r = await run(`
import json
print(json.dumps(search("foo bar\\nbaz\\nfoo baz  ", "foo")))
print(json.dumps(search("abc", "zzz")))
print(json.dumps(search("Foo\\nfoo", "foo", re.IGNORECASE)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual(["L1: foo bar", "L3: foo baz"]);
		expect(JSON.parse(lines[1]!)).toEqual([]);
		expect(JSON.parse(lines[2]!)).toEqual(["L1: Foo", "L2: foo"]);
	});

	it("search scans lines lazily with splitlines semantics on CRLF, Unicode separators, and blank lines", async () => {
		const r = await run(`
import json
print(json.dumps(search("", "x")))
print(json.dumps(search("no newline", "newline")))
print(json.dumps(search("a\\r\\nb\\rc\\nd\\n", "b")))
print(json.dumps(search("foo\\n\\nfoo", "foo")))
print(json.dumps(search("same same\\nsame", "same")))
print(json.dumps(search("a\\u2028b\\u2029c", "b")))
print(json.dumps(search("a\\v\\fb\\x85c", "b")))
print(json.dumps(search("  pad  \\n\\t", "pad")))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual([]); // empty payload
		expect(JSON.parse(lines[1]!)).toEqual(["L1: no newline"]);
		expect(JSON.parse(lines[2]!)).toEqual(["L2: b"]); // CRLF, lone \r, trailing \n
		expect(JSON.parse(lines[3]!)).toEqual(["L1: foo", "L3: foo"]); // blank line keeps numbering
		expect(JSON.parse(lines[4]!)).toEqual(["L1: same same", "L2: same"]); // one entry per matching line
		expect(JSON.parse(lines[5]!)).toEqual(["L2: b"]); // \u2028/\u2029 separators
		expect(JSON.parse(lines[6]!)).toEqual(["L3: b"]); // \v and \f are adjacent -> blank line, b on L3
		expect(JSON.parse(lines[7]!)).toEqual(["L1:   pad"]); // trailing whitespace stripped, leading kept
	});

	it("search caps results at limit and stops scanning once the cap is hit", async () => {
		const r = await run(`
import json
print(json.dumps(search("a\\nb\\nc\\nd\\ne", "a|c", limit=5)))
print(json.dumps(search("a\\nb\\nc\\nd\\ne", "a|c|e", limit=2)))
print(json.dumps(search("a\\nb\\n", "a|b", limit=2)))
print(json.dumps(search("a\\nb", "a|b", limit=2)))
print(json.dumps(search("Foo\\nfoo", "foo", re.IGNORECASE, limit=1)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		// Below the cap the result is identical to the unbounded behavior.
		expect(JSON.parse(lines[0]!)).toEqual(["L1: a", "L3: c"]);
		// Over the cap: first `limit` matches plus a truncation marker; the
		// scan stops the moment the cap is hit, so the result list cannot
		// grow past limit+1 entries no matter how many lines match.
		expect(JSON.parse(lines[1]!)).toEqual(["L1: a", "L3: c", "... (truncated, more matches may exist)"]);
		// A scan that ends exactly at the cap (no lines left unexamined) is
		// not truncated, so no marker is appended.
		expect(JSON.parse(lines[2]!)).toEqual(["L1: a", "L2: b"]);
		expect(JSON.parse(lines[3]!)).toEqual(["L1: a", "L2: b"]);
		// flags stays positional; limit is a keyword-only kwarg.
		expect(JSON.parse(lines[4]!)).toEqual(["L1: Foo", "... (truncated, more matches may exist)"]);
	});

	it("search truncates oversized matching lines to max_line_chars and leaves short lines intact", async () => {
		const r = await run(`
import json
long = "y" * 5000
print(json.dumps(search("short\\n", "short")))
print(json.dumps(search(long, "y")))
print(json.dumps(search(long + "\\n" + long, "y", max_line_chars=20)))
print(json.dumps(search(long + "\\n" + long + "\\n" + long, "y", limit=1, max_line_chars=10)))
print(json.dumps(search("\\n" + long + "  ", "y", max_line_chars=5)))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		// Short lines pass through unchanged (default cap is 1000).
		expect(JSON.parse(lines[0]!)).toEqual(["L1: short"]);
		// A single oversized matching line keeps a bounded window instead of
		// being copied whole; the match is at offset 0, so the window is the
		// line prefix and the offset annotation reads L1@0.
		expect(JSON.parse(lines[1]!)).toEqual(["L1@0: " + "y".repeat(1000) + "... (line truncated)"]);
		// The cap is configurable; every matching line is truncated, and the
		// count cap (limit) still applies on top.
		expect(JSON.parse(lines[2]!)).toEqual([
			"L1@0: " + "y".repeat(20) + "... (line truncated)",
			"L2@0: " + "y".repeat(20) + "... (line truncated)",
		]);
		expect(JSON.parse(lines[3]!)).toEqual([
			"L1@0: " + "y".repeat(10) + "... (line truncated)",
			"... (truncated, more matches may exist)",
		]);
		// Trailing whitespace is stripped before the cap applies; numbering
		// stays intact across blank lines.
		expect(JSON.parse(lines[4]!)).toEqual(["L2@0: " + "y".repeat(5) + "... (line truncated)"]);
	});

	it("search keeps a bounded window around the first match in oversized lines", async () => {
		const r = await run(`
import json
head = "a" * 2000
tail = "b" * 3000
line = head + tail
print(json.dumps(search(line, "b")))
print(json.dumps(search("z" * 3000 + "K", "K")))
print(json.dumps(search("z" * 100 + "m" + "z" * 1899 + "m" + "z" * 2000, "m")))
print(json.dumps(search(line + "\\n" + line, "b")))
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		// Match near the END of an oversized single line: the excerpt is a
		// window centered on the match (offset 1500 for a match at 2000
		// with the default 1000-char cap), not the line prefix.
		expect(JSON.parse(lines[0]!)).toEqual(["L1@1500: ..." + "a".repeat(500) + "b".repeat(500) + "... (line truncated)"]);
		// A match at the very END of the line: the window shifts right to
		// the line end (no right cut, so no "... (line truncated)" suffix).
		expect(JSON.parse(lines[1]!)).toEqual(["L1@2001: ..." + "z".repeat(999) + "K"]);
		// Multiple matches: the window is centered on the FIRST match only.
		expect(JSON.parse(lines[2]!)).toEqual(["L1@0: " + "z".repeat(100) + "m" + "z".repeat(899) + "... (line truncated)"]);
		// Every matching oversized line gets its own window.
		expect(JSON.parse(lines[3]!)).toEqual([
			"L1@1500: ..." + "a".repeat(500) + "b".repeat(500) + "... (line truncated)",
			"L2@1500: ..." + "a".repeat(500) + "b".repeat(500) + "... (line truncated)",
		]);
	});
	it("search windows never split a surrogate pair at a truncation boundary", async () => {
		const r = await run(`
import json

def has_lone_half(s):
    for i, ch in enumerate(s):
        cp = ord(ch)
        if 0xDC00 <= cp <= 0xDFFF and (i == 0 or not 0xD800 <= ord(s[i - 1]) <= 0xDBFF):
            return True
        if 0xD800 <= cp <= 0xDBFF and (i == len(s) - 1 or not 0xDC00 <= ord(s[i + 1]) <= 0xDFFF):
            return True
    return False

# The exact Codex repro: repeated emoji as JSON-style surrogate escapes
# (decoding leaves them as surrogate code points) followed by K, with a
# max_line_chars window that would land mid-pair.
emoji = "\\ud83d\\ude00" * 2000 + "K"
print(json.dumps(search(emoji, "K", max_line_chars=4)))

# Sweep window sizes and emoji placements; every window must hold no
# lone surrogate half, stay contiguous with its annotated (adjusted)
# offset, and still cover the first match.
cases = [
    ("\\ud83d\\ude00" + "x" * 3000, "x"),
    ("x" * 1500 + "\\ud83d\\ude00" + "x" * 1500, "x"),
    ("x" * 3000 + "\\ud83d\\ude00", "\\ud83d\\ude00"),
    ("\\ud83d\\ude00" * 1000 + "needle" + "\\ud83d\\ude00" * 1000, "needle"),
    ("x" * 2000 + "m" + "\\ud83d\\ude00" + "x" * 2000, "m"),
    ("x" * 2000 + "\\ud83d\\ude00" + "m" + "x" * 2000, "m"),
]
for line, pattern in cases:
    for cap in (1, 2, 3, 4, 5, 7, 8):
        entries = search(line, pattern, max_line_chars=cap)
        assert len(entries) == 1, (pattern, cap)
        ann = re.match(r"^L\\d+@(\\d+): ", entries[0])
        assert ann, entries[0]
        off = int(ann.group(1))
        win = entries[0][ann.end() :]
        if off > 0 and win.startswith("..."):
            win = win[3:]
        if win.endswith("... (line truncated)"):
            win = win[: -len("... (line truncated)")]
        assert not has_lone_half(win), (pattern, cap, entries[0])
        assert line[off:].startswith(win), (pattern, cap, entries[0])
        first = line.index(pattern)
        assert off <= first < off + len(win), (pattern, cap, entries[0])
print("ok")
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		// Same exact output as the JS backend (UTF-16 equality: the JSON
		// surrogate escapes decode to the same code units as \\u{1F600}).
		expect(JSON.parse(lines[0]!)).toEqual(["L1@3996: ...\u{1F600}\u{1F600}K"]);
		expect(lines[1]).toBe("ok");
	});
	it("search rejects non-positive limits and max_line_chars", async () => {
		const bad = await run(`search("a\\nb", "a", limit=0)`);
		expect(bad.exitCode).not.toBe(0);
		expect(bad.stderr).toContain("ValueError");

		const badCap = await run(`search("a\\nb", "a", max_line_chars=0)`);
		expect(badCap.exitCode).not.toBe(0);
		expect(badCap.stderr).toContain("ValueError");
	});

	it("llm_query delegates to completion, prefixing instructions when given", async () => {
		// The prelude's completion() hits the host bridge, so stub it after
		// the prelude (same namespace) to capture the delegated prompts.
		const r = await run(`
import json
def completion(prompt, *, model="default", system=None, schema=None):
    print(json.dumps({"prompt": prompt, "model": model}))
    return "reply"
llm_query("the code", "explain this")
llm_query("just code")
llm_query_batched(["a", "b"], model="smol")
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		expect(JSON.parse(lines[0]!)).toEqual({ prompt: "explain this\n\nthe code", model: "default" });
		expect(JSON.parse(lines[1]!)).toEqual({ prompt: "just code", model: "default" });
		// Batched prompts are bare snippets (no instructions path).
		expect(JSON.parse(lines[2]!)).toEqual({ prompt: "a", model: "smol" });
		expect(JSON.parse(lines[3]!)).toEqual({ prompt: "b", model: "smol" });
	});

	it("llm_query renders the llm_query.md template exactly like the old inline construction", async () => {
		const r = await run(`
import json
def completion(prompt, *, model="default", system=None, schema=None):
    print(json.dumps({"prompt": prompt, "model": model}))
    return "reply"
llm_query("code", "")
llm_query("", "explain")
llm_query("see {{instructions}} $& here", "a {{snippet}} b")
llm_query("l1\\nl2", "i1\\ni2")
`);
		expect(r.exitCode).toBe(0);
		const lines = r.stdout.trim().split("\n");
		// Empty instructions still prefix the two newlines, exactly as the
		// previous f"{instructions}\\n\\n{snippet}" construction did.
		expect(JSON.parse(lines[0]!)).toEqual({ prompt: "\n\ncode", model: "default" });
		expect(JSON.parse(lines[1]!)).toEqual({ prompt: "explain\n\n", model: "default" });
		// Payloads that themselves contain the placeholder tokens are never
		// re-scanned: the single-pass render replaces only the template's own
		// {{instructions}}/{{snippet}} placeholders, so both values survive
		// byte-for-byte.
		expect(JSON.parse(lines[2]!)).toEqual({
			prompt: "a {{snippet}} b\n\nsee {{instructions}} $& here",
			model: "default",
		});
		// Multi-line values keep their newlines verbatim.
		expect(JSON.parse(lines[3]!)).toEqual({ prompt: "i1\ni2\n\nl1\nl2", model: "default" });
	});
});
