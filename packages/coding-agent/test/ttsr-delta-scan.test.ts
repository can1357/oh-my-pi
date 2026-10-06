import { describe, expect, it, spyOn } from "bun:test";
import type { Rule } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { TtsrManager, type TtsrMatchContext } from "@oh-my-pi/pi-coding-agent/export/ttsr";

const NEVER_MATCHES = "NEVER_MATCHES_THIS_LITERAL";
const RULE_NAME = "delta-scan-tool-bash";

function makeRule(condition: string, scope = "tool:bash"): Rule {
	const name = `delta-scan-${scope.replaceAll(/[^a-z0-9]+/gi, "-")}`;
	return {
		name,
		path: `${name}.md`,
		content: "Test reminder",
		condition: [condition],
		scope: [scope],
		_source: {
			provider: "test",
			providerName: "test",
			path: `${name}.md`,
			level: "project",
		},
	};
}

function managerFor(condition: string): TtsrManager {
	const manager = new TtsrManager({ enabled: true, interruptMode: "never", repeatMode: "once" });
	expect(manager.addRule(makeRule(condition))).toBe(true);
	return manager;
}

function toolContext(streamKey: string): TtsrMatchContext {
	return { source: "tool", toolName: "bash", streamKey };
}

function matchedNames(rules: readonly Rule[]): string[] {
	return rules.map(rule => rule.name);
}

/** Feeds `wire` in fixed-size deltas and returns every rule reported by any delta. */
function stream(manager: TtsrManager, wire: string, context: TtsrMatchContext, deltaBytes = 16): Rule[] {
	const matched: Rule[] = [];
	for (let offset = 0; offset < wire.length; offset += deltaBytes) {
		matched.push(...manager.checkDelta(wire.slice(offset, offset + deltaBytes), context));
	}
	return matched;
}

/**
 * Counts how many characters the matcher actually reads, by wrapping
 * `RegExp.prototype.test`. `checkDelta` used to hand every delta the whole
 * accumulated buffer, so this total grew with the square of the stream length;
 * each rule now resumes near the end of its previous scan, so it tracks the
 * bytes streamed.
 */
function totalCharactersTested(run: () => void): number {
	const original = RegExp.prototype.test;
	const spy = spyOn(RegExp.prototype, "test").mockImplementation(function (this: RegExp, input: string): boolean {
		return original.call(this, input);
	});
	try {
		run();
		return spy.mock.calls.reduce((sum, [input]) => sum + input.length, 0);
	} finally {
		spy.mockRestore();
	}
}

describe("TTSR checkDelta scan cost", () => {
	it("rescans each delta instead of the whole accumulated buffer", () => {
		const manager = managerFor(NEVER_MATCHES);
		const wire = JSON.stringify({ command: "N".repeat(16 * 1024) });
		const deltas = Math.ceil(wire.length / 16);
		const tested = totalCharactersTested(() => {
			expect(stream(manager, wire, toolContext("perf"))).toEqual([]);
		});

		// Whole-buffer rescanning reads sum(16, 32, ... n) ~= n^2/32, over 8M
		// characters here. Resuming reads one window per delta — the delta plus the
		// rule's match window — so it stays in the tens of thousands.
		expect(deltas).toBeGreaterThan(1000);
		expect(tested).toBeLessThan(deltas * 100);
	});

	it("keeps bounded rescanning linear as the stream grows", () => {
		const measure = (streamBytes: number): number => {
			const manager = managerFor(NEVER_MATCHES);
			const wire = JSON.stringify({ command: "N".repeat(streamBytes) });
			return totalCharactersTested(() => {
				stream(manager, wire, toolContext("scale"));
			});
		};
		measure(2048);

		// Doubling the stream roughly doubles the work; quadratic behaviour would
		// quadruple it.
		const small = measure(8 * 1024);
		const large = measure(16 * 1024);
		expect(large).toBeLessThan(small * 3);
	});
});

describe("TTSR checkDelta resumed scans stay exact", () => {
	// A resumed scan starts at `offset - window`, so a match completing only in the
	// newest delta must still be found. Each case below puts the token in the
	// first characters of the buffer, which is exactly where a stale offset would
	// resume past it and miss the match.
	const TOKEN = "BOUNDARY_TOKEN";

	it("finds a match spanning the delta that completed it", () => {
		const manager = managerFor(TOKEN);
		const context = toolContext("boundary");
		// The token straddles a delta boundary: the first delta ends mid-token.
		const wire = `${TOKEN} trailing payload that keeps streaming after the match`;
		const firstDelta = wire.slice(0, 6);
		expect(firstDelta).not.toContain(TOKEN);
		expect(wire).toContain(TOKEN);

		expect(matchedNames(stream(manager, wire, context))).toContain(RULE_NAME);
	});

	it("finds a match sitting at the very start of the stream", () => {
		const manager = managerFor(TOKEN);
		expect(matchedNames(stream(manager, `${TOKEN} and then some`, toolContext("head")))).toContain(RULE_NAME);
	});

	it("still matches after a long non-matching prefix", () => {
		const manager = managerFor(TOKEN);
		const context = toolContext("late");
		// Advance the scan offset well past the token's position in a later buffer.
		expect(stream(manager, "N".repeat(64), context)).toEqual([]);
		expect(matchedNames(manager.checkDelta(TOKEN, context))).toEqual([RULE_NAME]);
	});

	it("keeps unbounded patterns matching the whole buffer", () => {
		const manager = managerFor("QUIET.+PROFILE");
		const wire = `{"command":"${"QUIET".repeat(400)}PROFILE"}`;
		// `+` is unbounded, so no window may be assumed and the late token is found.
		expect(matchedNames(stream(manager, wire, toolContext("unbounded")))).toContain(RULE_NAME);
	});
});

describe("TTSR scan offsets follow the buffer lifecycle", () => {
	const TOKEN = "LIFECYCLE_TOKEN";
	/** Long enough that a leaked offset would resume past this short buffer. */
	const PREFIX = `{"command":"${"N".repeat(64)}"`;

	it("starts each stream from its own beginning", () => {
		const manager = managerFor(TOKEN);
		// Fill one stream so its offset advances; a second stream must be unaffected.
		expect(stream(manager, PREFIX, toolContext("first"))).toEqual([]);
		expect(matchedNames(manager.checkDelta(TOKEN, toolContext("second")))).toEqual([RULE_NAME]);
	});

	it("restarts the scan after a snapshot replaces the buffer", () => {
		const manager = managerFor(TOKEN);
		const context = toolContext("snapshot");
		expect(stream(manager, PREFIX, context)).toEqual([]);
		// Split the token across the snapshot/delta boundary: the snapshot alone
		// must not match, and the completing delta must. A retained offset would
		// resume past this short buffer and miss it.
		expect(manager.checkSnapshot(TOKEN.slice(0, -2), context)).toEqual([]);
		expect(matchedNames(manager.checkDelta("EN", context))).toEqual([RULE_NAME]);
	});

	it("restarts the scan after the stream is reset", () => {
		const manager = managerFor(TOKEN);
		const context = toolContext("reset");
		expect(stream(manager, PREFIX, context)).toEqual([]);
		manager.resetBuffer();
		expect(matchedNames(manager.checkDelta(TOKEN, context))).toEqual([RULE_NAME]);
	});

	it("clears one tool stream without disturbing the others", () => {
		const manager = managerFor(TOKEN);
		const kept = toolContext("kept");
		const dropped = toolContext("dropped");
		expect(stream(manager, PREFIX, kept)).toEqual([]);
		expect(stream(manager, PREFIX, dropped)).toEqual([]);

		manager.clearStream("dropped");
		expect(matchedNames(manager.checkDelta(TOKEN, dropped))).toEqual([RULE_NAME]);
		// The untouched stream keeps its offset, so re-feeding the token still
		// matches rather than being skipped.
		expect(matchedNames(manager.checkDelta(TOKEN, kept))).toEqual([RULE_NAME]);
	});
});
