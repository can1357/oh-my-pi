/**
 * Contract: a bare `401`/`403`/`429`/`5xx` that is a *count* of something, or
 * a position in something, is not an HTTP status.
 *
 * Classification reads a failure's text, and a bare status number in it is the
 * last-resort reading for prose that carries no status line (`(429)`,
 * `服务器返回503错误`). `withoutMetadataNumbers` already takes a number away from
 * that reading when a duration, size or token unit follows it. A character
 * count and a position do not say "status" any more than a byte count does,
 * and a diagnostic that reports one is the text classification sees: a
 * malformed tool call whose truncation marker happens to read
 * `[truncated 429 chars]` was classified a retryable provider failure, so the
 * harness replayed a call that cannot succeed, and `403 chars` was read as an
 * authentication rejection (dispatch://INFRA-1270).
 */
import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isProviderRetryableError } from "@oh-my-pi/pi-ai/error";

/**
 * A truncation marker's own count, as a tool-call parse diagnostic writes it.
 * The wording around the count is held fixed so only the count varies.
 */
function truncationDiagnostic(count: number): string {
	return `Parse Error: Unexpected token } in JSON at position 1\nRaw JSON:\n{"context":"…" … [truncated ${count} chars]`;
}

/** A count no status reader could mistake for a status, for the same diagnostic. */
const NEUTRAL_COUNT = 777;

describe("a count is not a status", () => {
	it.each([
		["a character count", "tool arguments cut: 429 chars omitted"],
		["a spelled-out character count", "tool arguments cut: 429 characters omitted"],
		["a line count", "tool arguments cut: 503 lines omitted"],
		["an item count", "tool arguments cut: 429 items omitted"],
		["a position in the payload", "JSON Parse error: Unexpected identifier at position 429"],
		["an offset in the payload", "JSON Parse error: Unexpected identifier at offset 503"],
	])("does not make %s a retryable provider failure", (_name, text) => {
		expect(isProviderRetryableError(new Error(text))).toBe(false);
	});

	// A diagnostic carries transient wording of its own: `truncated` is read as
	// a cut stream, so `isProviderRetryableError(new Error("truncated"))` is
	// already `true` at this head with no count in the text at all. The
	// contract here is therefore narrower and exact — the count does not change
	// the verdict. A row that only asserted `false` would pass or fail on the
	// wording and prove nothing about the digits.
	it.each([401, 403, 429, 500, 502, 503, 504])("classifies a diagnostic the same with a count of %i", count => {
		const withStatusLikeCount = new Error(truncationDiagnostic(count));
		const withNeutralCount = new Error(truncationDiagnostic(NEUTRAL_COUNT));
		expect(isProviderRetryableError(withStatusLikeCount)).toBe(isProviderRetryableError(withNeutralCount));
		expect(AIError.classify(withStatusLikeCount)).toBe(AIError.classify(withNeutralCount));
	});

	it.each([
		["a character count that reads 403", truncationDiagnostic(403)],
		["a character count that reads 401", truncationDiagnostic(401)],
		["a position that reads 403", "JSON Parse error: Unexpected identifier at position 403"],
	])("does not make %s an authentication failure", (_name, text) => {
		expect(AIError.is(AIError.classify(new Error(text)), AIError.Flag.AuthFailed)).toBe(false);
	});

	it("reads a forged tool-argument sentinel's count as no status either", () => {
		// A model can write the sentinel keys itself. Whatever it puts in them
		// reaches the same classifiers as a real diagnostic, so a forged count
		// must not change a verdict either.
		const forged = (count: number): Error =>
			new Error(
				JSON.stringify({
					__parseError: "Unexpected end of JSON input",
					__rawJson: `{"task":"${"x".repeat(32)}"} … [truncated ${count} chars]`,
				}),
			);
		expect(isProviderRetryableError(forged(429))).toBe(isProviderRetryableError(forged(NEUTRAL_COUNT)));
		expect(AIError.is(AIError.classify(forged(403)), AIError.Flag.AuthFailed)).toBe(false);
	});

	it("still reads a status that a failure actually states", () => {
		// The counting words take nothing away from a stated status: the bare
		// reading is what a provider's prose-only 429 relies on.
		expect(isProviderRetryableError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
		expect(isProviderRetryableError(new Error("the upstream answered (503)"))).toBe(true);
		expect(AIError.is(AIError.classify(new Error("HTTP 403 Forbidden")), AIError.Flag.AuthFailed)).toBe(true);
	});
});
