import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { BUILTIN_DEFAULTS_PROVIDER_ID, type Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";
import { isBacktrackProne } from "@oh-my-pi/pi-coding-agent/export/ttsr-regex-sandbox";

function rule(name: string, condition: string, provider = "test"): Rule {
	return {
		name,
		path: `${name}.md`,
		content: "reminder",
		condition: [condition],
		scope: ["text"],
		interruptMode: "never",
		_source: { provider, providerName: provider, path: `${name}.md`, level: "project" },
	};
}

const TEXT: TtsrMatchContext = { source: "text" };
/** Short sandbox deadline: a stuck condition costs this much per call. */
const SANDBOX = { sandboxTimeoutMs: 300 };

/**
 * A user rule that loops over indented lines. `[ \t]+[^\n]*` splits each line's
 * indentation in several ways, so the failing search costs x5 per body line:
 * 42 ms at 6 lines, 2.2 s at 8, 62 s at 10.
 */
const INDENTED_LOOP =
	"(?:^|\\n)([ \\t]*)(?:async[ \\t]+)?for\\b[^\\n]*:[ \\t]*\\n(?:\\1[ \\t]+[^\\n]*\\n|[ \\t]*\\n)*?\\1[ \\t]+[^\\n]*(?:\\.objects\\.(?:get|filter)\\s*\\()";
const LOOP_BODY = "        x = compute(a, b, c)\n";

function names(rules: Rule[]): string[] {
	return rules.map(match => match.name);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("backtrack-prone condition classifier", () => {
	it.each([
		["a backreference", "(['\"])x\\1"],
		["a named backreference", "(?<q>['\"])x\\k<q>"],
		["a lookbehind", "(?<!#[^\\n]*)\\bwhich\\s+x"],
		["a repeated group around a quantifier", "(a+)+b"],
		["a repeated group around an alternation", '(?:[^"\\\\]|\\\\.)*"'],
		["the indented-loop shape", INDENTED_LOOP],
	])("flags %s", (_label, source) => {
		expect(isBacktrackProne(new RegExp(source))).toBe(true);
	});

	it.each([
		["a literal call", "FORBIDDEN_\\w+\\("],
		["adjacent quantifiers", "\\bfoo\\s+bar\\s*\\("],
		["an optional group", "[a-z]+(?:\\.[a-z]+)?"],
		["a bounded repeated group", "(?:ab){2,5}c"],
		["a lookahead with a quantifier", "x(?=y+)"],
	])("passes %s", (_label, source) => {
		expect(isBacktrackProne(new RegExp(source))).toBe(false);
	});
});

describe("TTSR regex sandbox", () => {
	it("returns promptly and quarantines a user condition that backtracks exponentially", () => {
		const warn = vi.spyOn(logger, "warn");
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("indented-loop", INDENTED_LOOP));
		const stream = `for item in items:\n${LOOP_BODY.repeat(9)}done = 1\n`;

		const started = performance.now();
		const matches = manager.checkDelta(stream, TEXT, { final: true });
		const elapsed = performance.now() - started;

		expect(elapsed).toBeLessThan(3_000);
		expect(matches).toEqual([]);
		const quarantined = warn.mock.calls.filter(([message]) => String(message).includes("quarantined"));
		expect(quarantined).toHaveLength(1);
		expect(quarantined[0][1]).toMatchObject({ ruleName: "indented-loop" });

		const again = performance.now();
		expect(manager.checkDelta(LOOP_BODY.repeat(3), TEXT, { final: true })).toEqual([]);
		expect(performance.now() - again).toBeLessThan(250);
		expect(warn.mock.calls.filter(([message]) => String(message).includes("quarantined"))).toHaveLength(1);
	});

	it("quarantines a single-line nested-quantifier condition", () => {
		const warn = vi.spyOn(logger, "warn");
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("nested", "(a+)+b"));

		expect(manager.checkDelta(`${"a".repeat(26)}!`, TEXT, { final: true })).toEqual([]);
		expect(warn.mock.calls.some(([message]) => String(message).includes("quarantined"))).toBe(true);
	});

	it("keeps matching the benign conditions around a stuck one", () => {
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("quoted-x", "(['\"])x\\1"));
		manager.addRule(rule("indented-loop", INDENTED_LOOP));
		manager.addRule(rule("not-hash", "(?<!#)\\bwhich\\s+x"));
		const stream = `say "x" and which x\nfor item in items:\n${LOOP_BODY.repeat(9)}done = 1\n`;

		expect(names(manager.checkDelta(stream, TEXT, { final: true })).sort()).toEqual(["not-hash", "quoted-x"]);
	});

	it("evaluates prone conditions only when the stream block ends, with the same verdicts as in process", () => {
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("quoted-x", "(['\"])x\\1"));

		expect(manager.checkDelta('say "x"', TEXT)).toEqual([]);
		expect(names(manager.checkDelta("", TEXT, { final: true }))).toEqual(["quoted-x"]);
		expect(manager.matchExcerpt("quoted-x", TEXT)).toContain('say "x"');

		manager.resetBuffer();
		expect(manager.checkDelta("say \"x' now", TEXT, { final: true })).toEqual([]);
	});

	it("keeps checking non-prone conditions on every delta", () => {
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("forbidden", "FORBIDDEN_\\w+\\("));

		expect(names(manager.checkDelta("call FORBIDDEN_api(", TEXT))).toEqual(["forbidden"]);
	});

	it("leaves builtin rules in process, mid-stream", () => {
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("builtin-quoted", "(['\"])x\\1", BUILTIN_DEFAULTS_PROVIDER_ID));

		expect(names(manager.checkDelta('say "x"', TEXT))).toEqual(["builtin-quoted"]);
	});

	it("moves a user condition that was slow in process to the sandbox", () => {
		const warn = vi.spyOn(logger, "warn");
		const manager = new TtsrManager({ enabled: true }, SANDBOX);
		manager.addRule(rule("quartic", "a+a+a+a+b"));

		expect(manager.checkDelta("a".repeat(150), TEXT)).toEqual([]);
		expect(warn.mock.calls.some(([message]) => String(message).includes("moved to the regex sandbox"))).toBe(true);
	});
});
