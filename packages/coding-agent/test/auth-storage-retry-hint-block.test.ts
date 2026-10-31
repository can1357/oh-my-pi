/**
 * A rate-limited credential is blocked for the wait the failure names. That
 * wait reaches `AuthStorage.limits.rotate` as text, built by
 * `formatErrorMessageWithRetryAfter` from the error and its response headers,
 * so a header wait the formatter drops is a block that ends too early, and the
 * next request goes out inside a window the server said is closed.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { formatErrorMessageWithRetryAfter } from "@oh-my-pi/pi-ai/utils/retry-after";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("credential block from a rate-limit failure", () => {
	it.each([
		["a shorter body hint and a longer Retry-After", "usage_limit_reached retry-after-ms=200", "9", 9000],
		["a longer body hint and a shorter Retry-After", "usage_limit_reached retry-after-ms=9000", "0.2", 9000],
		["a Retry-After and no body hint", "usage_limit_reached", "9", 9000],
		["a zero body hint and a Retry-After", "usage_limit_reached retry-after-ms=0", "9", 9000],
		["a malformed body hint and a Retry-After", "usage_limit_reached retry-after-ms=oops", "9", 9000],
		// A number quoted in the body is not this response's wait. Read as one, an
		// echoed prompt blocked the credential for a day.
		[
			"an echoed longer number and an equal Retry-After",
			'usage_limit_reached retry-after-ms=200 echoed {"prompt":"retry-after-ms=86400000"}',
			"0.2",
			200,
		],
		[
			"an echoed longer number and a longer Retry-After",
			'usage_limit_reached retry-after-ms=200 echoed {"prompt":"retry-after-ms=86400000"}',
			"9",
			9000,
		],
	] as [string, string, string, number][])(
		"lasts the response's own longest wait for %s",
		async (_label, body, retryAfter, expected) => {
			const dir = TempDir.createSync("@pi-retry-hint-block-");
			const auth = await AuthStorage.create(`${dir.path()}/auth.db`);
			// A private provider has no usage report to fetch; the rotation and the
			// block it persists are the real ones.
			const provider = "retry-hint-local";
			await auth.credentials.set(provider, [{ type: "api_key", key: "fixture-key" }]);
			const now = Date.now();
			vi.spyOn(Date, "now").mockReturnValue(now);
			try {
				const error = formatErrorMessageWithRetryAfter(new Error(body), { "retry-after": retryAfter });
				const result = await auth.limits.rotate(provider, "retry-hint-session", {
					error,
					apiKey: "fixture-key",
					waitForSibling: false,
				});
				const blocks = auth.blocks.list(auth.credentials.list(provider).map(credential => credential.id));

				expect(result.switched).toBe(false);
				expect(blocks).toHaveLength(1);
				expect(blocks[0].blockedUntilMs - now).toBe(expected);
			} finally {
				auth.close();
				dir.removeSync();
			}
		},
	);
});
