/**
 * Contract: when a tool call's arguments do not parse, the excerpt the model
 * receives must contain the offending text, and the diagnostic must not
 * acquire a number that an HTTP-status classifier reads as a status code.
 *
 * A malformed tool call is usually long and its fault is usually near the end
 * (a batch `task` brief, a `write` payload, a stream cut mid-string). Showing
 * the payload's first 512 characters hands back an excerpt that cannot contain
 * the fault, and the model has nothing to correct (dispatch://INFRA-1270).
 */
import { describe, expect, it } from "bun:test";
import { isProviderRetryableError } from "@oh-my-pi/pi-ai/error";
import {
	INVALID_ARGUMENTS_RAW_LIMIT,
	invalidToolCallArguments,
	parseToolCallArguments,
} from "@oh-my-pi/pi-ai/utils/tool-call-arguments";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";
import { isRecord } from "@oh-my-pi/pi-utils";
import { JsonSyntaxError } from "@oh-my-pi/pi-utils/json-lexer";
import { parseJsonWithRepair } from "@oh-my-pi/pi-utils/json-parse";

const tool = { name: "task", description: "", parameters: { type: "object" } } as const;

function diagnostic(raw: string): Record<string, unknown> {
	const args = parseToolCallArguments(raw);
	if (!isRecord(args)) throw new Error("expected a diagnostic object");
	return args;
}

describe("tool-call argument parse diagnostics", () => {
	it("excerpts the offending fragment of a long call instead of its head", () => {
		const fragment = 'second "broken" thing';
		const padding = "background paragraph. ".repeat(220);
		const raw = `{"context":"${padding}","tasks":[{"task":"do the thing","name":"Alpha"},{"task":"${fragment}","name":"Beta"}]}`;
		expect(raw.length).toBeGreaterThan(INVALID_ARGUMENTS_RAW_LIMIT * 4);
		// The fault is past the head window, so a head excerpt cannot hold it.
		expect(raw.slice(0, INVALID_ARGUMENTS_RAW_LIMIT)).not.toContain(fragment);

		const args = diagnostic(raw);
		const excerpt = String(args.__rawJson);
		expect(excerpt).toContain(fragment);
		expect(excerpt.length).toBeLessThanOrEqual(INVALID_ARGUMENTS_RAW_LIMIT);
		expect(excerpt).toStartWith("… [earlier text omitted] ");

		// What the model is shown keeps the fragment: re-bounding leaves it alone.
		expect(() => validateToolArguments(tool, { type: "toolCall", id: "c1", name: "task", arguments: args })).toThrow(
			fragment,
		);
	});

	it("reaches the cut end of a long truncated call", () => {
		const raw = `{"context":"${"background. ".repeat(100)}","tasks":[{"task":"do the thing`;
		const excerpt = String(diagnostic(raw).__rawJson);
		expect(excerpt.length).toBeLessThanOrEqual(INVALID_ARGUMENTS_RAW_LIMIT);
		expect(excerpt).toEndWith('"tasks":[{"task":"do the thing');
	});

	it("shows a short payload whole, with no window markers", () => {
		const raw = '{"path":"a.ts","content":"half';
		const args = diagnostic(raw);
		expect(String(args.__parseError)).toBe("Unterminated string");
		expect(String(args.__rawJson)).toBe(raw);
	});

	it("keeps a status-like number out of the diagnostic the model and the classifiers see", () => {
		// `\b(?:401|403|429|500|502|503|504)\b` in `packages/ai/src/error/flags.ts`
		// matches anywhere in an error's text, so an excerpt whose own marker
		// reads "truncated 429 chars" classifies a malformed tool call as a
		// retryable provider failure. A window marker carries no count, and the
		// fault offset rides on the error object rather than in its message, so
		// neither can put a status-like number into the text.
		const prefix = '{"context":"';
		const suffix = '","tasks":[{"task":"x" bad}]}';
		const raw = `${prefix}${"p".repeat(941 - prefix.length - suffix.length)}${suffix}`;
		// 941 - 512 = 429: a head-truncation marker here reads "truncated 429 chars".
		expect(raw.length - INVALID_ARGUMENTS_RAW_LIMIT).toBe(429);

		const args = diagnostic(raw);
		const shown = `Parse Error: ${args.__parseError}\nRaw JSON:\n${String(args.__rawJson)}`;
		expect(shown).not.toMatch(/\b(?:401|403|429|500|502|503|504)\b/);
		expect(isProviderRetryableError(new Error(shown))).toBe(false);
	});

	it("bounds and de-digits a long excerpt even when the failure reports no offset", () => {
		// Providers hand `invalidToolCallArguments` errors from `JSON.parse`
		// itself, which on JavaScriptCore carries no offset. The head excerpt
		// taken then must still fit the budget and still carry no count: the
		// replay sanitizer's diagnostic reaches the same classifiers.
		const raw = `${" ".repeat(934)}{} nope`;
		const args = invalidToolCallArguments(raw, new SyntaxError("JSON Parse error: Unexpected identifier"));
		if (!isRecord(args)) throw new Error("expected a diagnostic object");
		const excerpt = String(args.__rawJson);
		expect(excerpt.length).toBeLessThanOrEqual(INVALID_ARGUMENTS_RAW_LIMIT);
		expect(excerpt).toEndWith(" … [rest of the arguments omitted]");
		const shown = `Parse Error: ${args.__parseError}\nRaw JSON:\n${excerpt}`;
		expect(shown).not.toMatch(/\b(?:401|403|429|500|502|503|504)\b/);
		expect(isProviderRetryableError(new Error(shown))).toBe(false);
	});

	// `\b`'s word class is `[A-Za-z0-9_]`, so `x429"` and `1403` carry no
	// boundary before the digits and the raw matches no status. Severing that
	// `x`, `_` or `1` supplies the boundary and the excerpt matches one the
	// payload never carried. Both round-6 reviewers found this independently;
	// these are their inputs.
	//
	// The offset is driven DIRECTLY rather than inferred from where the parser
	// happens to fault. Two earlier versions of this test were vacuous because
	// they constructed a payload and hoped the window would land on the seed:
	// one put the seed outside the window entirely, and in the other the `"`
	// inside `x429"` closed the string value, so the fault — and the window
	// centred on it — moved with the seed and never cut it. Both passed with
	// every trim removed. Sweeping the offset puts each edge through the seed
	// by construction, which is the only version a mutation of the trims fails.
	it.each([
		["digit before", "1403"],
		["letter before", 'x429"'],
		["underscore before", 'run_429"'],
		["letter before, auth", "x403,"],
		["letter after", '"403x'],
		["letter after, transient", " 429y"],
		["digit after", "4031"],
	])("never invents a status by cutting through a word: %s", (_name, seed) => {
		const statusPattern = /\b(?:401|403|429|500|502|503|504)\b/;
		const raw = `${"a".repeat(600)}${seed}${"b".repeat(600)}`;
		expect(raw).not.toMatch(statusPattern);
		let sawSeverance = false;
		// Both edges of a 453-character window pass through the seed at 600
		// somewhere in this range.
		for (let position = 340; position <= 860; position++) {
			const args = invalidToolCallArguments(raw, new JsonSyntaxError("Unexpected token", position));
			if (!isRecord(args)) throw new Error("expected a diagnostic object");
			const excerpt = String(args.__rawJson);
			expect(excerpt).not.toMatch(statusPattern);
			expect(excerpt.length).toBeLessThanOrEqual(INVALID_ARGUMENTS_RAW_LIMIT);
			if (excerpt.includes(seed.slice(-2)) && !excerpt.includes(seed)) sawSeverance = true;
		}
		expect(sawSeverance).toBe(true);
	});

	it("keeps the payload text when no status could appear, however many digits it is", () => {
		// An unconditional trim ate the whole window here: the payload is one
		// digit run, so every character was "severed digits" and the model got
		// the marker alone — losing the offending text this change exists to
		// show. The trim now fires only when a status would actually appear.
		const raw = `${"9".repeat(600)}e`;
		expect(raw).not.toMatch(/\b(?:401|403|429|500|502|503|504)\b/);
		const excerpt = String(diagnostic(raw).__rawJson);
		expect(excerpt).not.toBe(" … [rest of the arguments omitted]");
		expect(excerpt).toContain("999999");
		expect(excerpt.length).toBeGreaterThan(400);
		expect(excerpt.length).toBeLessThanOrEqual(INVALID_ARGUMENTS_RAW_LIMIT);
	});

	// A payload that already carries one status must not license the cut to
	// mint a different one. Gating on "does the raw contain any status" let
	// `HTTP 403 denied` suppress the trim for an `x429"` elsewhere in the same
	// payload, flipping an authentication failure into a retryable one and
	// back. The word-boundary sweep above cannot see it: its fixture carries no
	// status at all, so a one-boolean gate is always satisfied there.
	it.each([
		["403 present, 429 at the cut", "403", "429"],
		["401 present, 503 at the cut", "401", "503"],
		["429 present, 403 at the cut", "429", "403"],
		["500 present, 401 at the cut", "500", "401"],
	])("never mints a second status because the payload already carried one: %s", (_name, present, minted) => {
		const prefix = `{"c":"HTTP ${present} denied",`;
		const raw = `${prefix}${"q".repeat(680)}x${minted}"${"r".repeat(700)}`;
		const digitsAt = raw.indexOf(`x${minted}"`) + 1;
		for (let position = digitsAt + 200; position <= digitsAt + 250; position++) {
			const args = invalidToolCallArguments(raw, new JsonSyntaxError("Unexpected token", position));
			if (!isRecord(args)) throw new Error("expected a diagnostic object");
			const seen = [...String(args.__rawJson).matchAll(/\b(?:401|403|429|500|502|503|504)\b/g)].map(m => m[0]);
			expect(seen.filter(status => status !== present)).toEqual([]);
		}
	});

	it("keeps a status-shaped fault offset out of the message text", () => {
		// The whole point of carrying the offset on the error: putting it back
		// into the message is invisible to a fixture whose offsets are all
		// small, so this one picks an offset that is itself a status.
		let thrown: unknown;
		try {
			parseJsonWithRepair(`${" ".repeat(428)}{:1}`);
		} catch (error) {
			thrown = error;
		}
		expect((thrown as JsonSyntaxError).position).toBe(429);
		expect((thrown as Error).message).not.toMatch(/\d/);
		expect(isProviderRetryableError(thrown as Error)).toBe(false);
	});
});
