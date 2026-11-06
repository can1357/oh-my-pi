/**
 * A rate-limited credential is blocked for the wait the failure names, and for
 * no longer than a stated ceiling.
 *
 * The response headers' wait reaches `AuthStorage.limits.rotate` structured:
 * on a thrown error's own headers (the auth retry and key resolver paths), or
 * as `retryAfterMs` beside the message text (turn recovery, from
 * `AssistantMessage.errorRetryAfterMs`). The text is read for the body's first
 * wait only. A body ending in `retry-after-ms=<n>` used to be read as the
 * header's appended wait, and persisted an 86,400,000 ms block behind a
 * `Retry-After: 0.2`.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getRetryAfterMsFromHeaders, providerRetryWaitMs } from "@oh-my-pi/pi-ai/utils/retry-after";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

const PROVIDER = "retry-hint-local";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MAX_VALUE_DIGITS = BigInt(Number.MAX_VALUE).toString();
const ECHO = 'usage_limit_reached retry-after-ms=200 echoed {"prompt":"retry-after-ms=86400000"}';
const FINAL_TOKEN = "usage_limit_reached retry-after-ms=200\nUpstream diagnostic: retry-after-ms=86400000";

/** A fresh store with one credential under a private provider, which has no usage report to fetch. */
async function withStore(run: (auth: AuthStorage, now: number) => Promise<void>): Promise<void> {
	const dir = TempDir.createSync("@pi-retry-hint-block-");
	const auth = await AuthStorage.create(`${dir.path()}/auth.db`);
	await auth.credentials.set(PROVIDER, [{ type: "api_key", key: "fixture-key" }]);
	const now = Date.now();
	vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		await run(auth, now);
	} finally {
		auth.close();
		dir.removeSync();
	}
}

function blockedForMs(auth: AuthStorage, now: number): number {
	const blocks = auth.blocks.list(auth.credentials.list(PROVIDER).map(credential => credential.id));
	expect(blocks).toHaveLength(1);
	return blocks[0].blockedUntilMs - now;
}

const ROTATE_CASES = [
	["a shorter body hint and a longer Retry-After", "usage_limit_reached retry-after-ms=200", "9", 9000],
	["a longer body hint and a shorter Retry-After", "usage_limit_reached retry-after-ms=9000", "0.2", 9000],
	["a Retry-After and no body hint", "usage_limit_reached", "9", 9000],
	["a zero body hint and a Retry-After", "usage_limit_reached retry-after-ms=0", "9", 9000],
	["a malformed body hint and a Retry-After", "usage_limit_reached retry-after-ms=oops", "9", 9000],
	["an echoed longer number and an equal Retry-After", ECHO, "0.2", 200],
	["an echoed longer number and a longer Retry-After", ECHO, "9", 9000],
	["a body ending in a longer hint and a short Retry-After", FINAL_TOKEN, "0.2", 200],
	[
		"a body ending in the largest finite number",
		`usage_limit_reached retry-after-ms=200 upstream retry-after-ms=${MAX_VALUE_DIGITS}`,
		"0.2",
		200,
	],
] as [string, string, string, number][];

describe("credential block from a rate-limit failure", () => {
	it.each(ROTATE_CASES)(
		"lasts the response's own wait for %s, from a thrown error's headers",
		async (_label, body, retryAfter, expected) => {
			await withStore(async (auth, now) => {
				const error = Object.assign(new Error(body), {
					headers: new Headers({ "retry-after": retryAfter }),
				});
				const result = await auth.limits.rotate(PROVIDER, "retry-hint-session", {
					error,
					apiKey: "fixture-key",
					waitForSibling: false,
				});
				expect(result.switched).toBe(false);
				expect(blockedForMs(auth, now)).toBe(expected);
			});
		},
	);

	it.each(ROTATE_CASES)(
		"lasts the response's own wait for %s, from text and the structured wait",
		async (_label, body, retryAfter, expected) => {
			await withStore(async (auth, now) => {
				const headers = { "retry-after": retryAfter };
				const result = await auth.limits.rotate(PROVIDER, "retry-hint-session", {
					error: body,
					retryAfterMs: getRetryAfterMsFromHeaders(headers),
					apiKey: "fixture-key",
					waitForSibling: false,
				});
				expect(result.switched).toBe(false);
				expect(blockedForMs(auth, now)).toBe(expected);
			});
		},
	);
});

describe("credential block ceiling", () => {
	it.each([
		["a 72-digit first hint", `usage_limit_reached retry-after-ms=${"9".repeat(72)}`, undefined, WEEK_MS],
		[
			"the largest finite number as the first hint",
			`usage_limit_reached retry-after-ms=${MAX_VALUE_DIGITS}`,
			undefined,
			WEEK_MS,
		],
		["a far-epoch reset header", "retry-after-ms=200 overloaded", { "x-ratelimit-reset": "99999999999" }, WEEK_MS],
		["a reset header a year ahead", "retry-after-ms=200 overloaded", { "x-ratelimit-reset": "YEAR" }, WEEK_MS],
		["a one-day hint", "usage_limit_reached retry-after-ms=86400000", undefined, DAY_MS],
		[
			"a millisecond delta under a seconds header",
			"retry-after-ms=200 overloaded",
			{ "x-ratelimit-reset": "300000" },
			300_000_000,
		],
		["a six-day hint", "usage_limit_reached retry-after-ms=518400000", undefined, 6 * DAY_MS],
	] as [string, string, Record<string, string> | undefined, number][])(
		"blocks for at most seven days on %s",
		async (_label, body, headers, expected) => {
			// No message or header may take a credential out of rotation for longer
			// than the longest rolling window a provider publishes. Unclamped, a
			// 72-digit hint blocked for 1e72 ms and a far epoch for 1.1 million days.
			await withStore(async (auth, now) => {
				const resolved =
					headers?.["x-ratelimit-reset"] === "YEAR"
						? { "x-ratelimit-reset": String(Math.floor(now / 1000) + 365 * 24 * 3600) }
						: headers;
				const retryAfterMs = providerRetryWaitMs(PROVIDER, body, getRetryAfterMsFromHeaders(resolved));
				const result = await auth.limits.markReached(PROVIDER, "retry-hint-session", {
					retryAfterMs,
					providerTimed: retryAfterMs !== undefined,
					apiKey: "fixture-key",
				});
				expect(result.switched).toBe(false);
				expect(blockedForMs(auth, now)).toBe(expected);
			});
		},
	);
});
