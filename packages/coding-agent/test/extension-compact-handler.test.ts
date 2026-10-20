/**
 * Regression tests for `runExtensionCompact` (issue #12041).
 *
 * `AgentSession.compact()` reports a failed compaction through
 * `CompactOptions.onError` and then rethrows. `ctx.compact()` used to await
 * that rejection without a catch, so extensions that fire `ctx.compact()`
 * without awaiting it produced an unhandled rejection that tore down RPC
 * hosts. The handler must report the failure through the extension's error
 * path and resolve instead of rejecting.
 */
import { describe, expect, it } from "bun:test";
import { runExtensionCompact } from "../src/extensibility/extensions/compact-handler";
import type { CompactOptions } from "../src/extensibility/extensions/types";

describe("runExtensionCompact", () => {
	it("reports a failed compaction through onError and resolves", async () => {
		const errors: Error[] = [];
		const session = {
			compact: async (): Promise<unknown> => {
				throw new Error("Nothing to compact (session too small)");
			},
		};

		await expect(
			runExtensionCompact(session, {
				onError: error => errors.push(error),
			}),
		).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toBe("Nothing to compact (session too small)");
	});

	it("reports the failure once when the session already called onError", async () => {
		const errors: Error[] = [];
		const failure = new Error("Nothing to compact (session too small)");
		const session = {
			compact: async (_instructions?: string, options?: CompactOptions): Promise<unknown> => {
				// Mirrors `session-maintenance.ts`: report, then rethrow.
				options?.onError?.(failure);
				throw failure;
			},
		};

		await expect(
			runExtensionCompact(session, {
				onError: error => errors.push(error),
			}),
		).resolves.toBeUndefined();

		expect(errors).toHaveLength(1);
		expect(errors[0]).toBe(failure);
	});

	it("forwards instructions and options to the session", async () => {
		const calls: Array<[string | undefined, CompactOptions | undefined]> = [];
		const session = {
			compact: async (instructions?: string, options?: CompactOptions): Promise<unknown> => {
				calls.push([instructions, options]);
			},
		};

		await runExtensionCompact(session, { mode: "soft" });

		expect(calls).toHaveLength(1);
		expect(calls[0]?.[0]).toBeUndefined();
		expect(calls[0]?.[1]?.mode).toBe("soft");
	});

	it("resolves instead of rejecting when the extension supplies no onError callback", async () => {
		const session = {
			compact: async (): Promise<unknown> => {
				throw new Error("Nothing to compact (session too small)");
			},
		};

		// An extension that fires `ctx.compact()` without awaiting it must not
		// leave a rejected promise behind — that is the unhandled rejection
		// that kills RPC hosts.
		const outcome = await runExtensionCompact(session, undefined).then(
			() => "resolved" as const,
			() => "rejected" as const,
		);

		expect(outcome).toBe("resolved");
	});
});
