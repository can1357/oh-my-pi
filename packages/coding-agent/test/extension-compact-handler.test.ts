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
import { logger } from "@oh-my-pi/pi-utils";
import { runExtensionCompact } from "../src/extensibility/extensions/compact-handler";
import type { CompactOptions } from "../src/extensibility/extensions/types";

/** Shape of the log records the sink below captures. */
interface CapturedLog {
	level: string;
	message: string;
	context: Record<string, unknown> | undefined;
}

/**
 * The guarantee is only real if EVERY mode routes through the shared adapter,
 * so the call sites are pinned here: a bare `session.compact()` await in the
 * TUI controller or in the runner-less session command context would put the
 * rejection back into extension code.
 */
const uiControllerSource = await Bun.file(
	new URL("../src/modes/controllers/extension-ui-controller.ts", import.meta.url),
).text();
const agentSessionSource = await Bun.file(new URL("../src/session/agent-session.ts", import.meta.url)).text();

describe("runExtensionCompact", () => {
	it("reports a failed compaction through onError and resolves", async () => {
		const errors: Error[] = [];
		const session = {
			compact: async (): Promise<void> => {
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
			compact: async (_instructions?: string, options?: CompactOptions): Promise<void> => {
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
			compact: async (instructions?: string, options?: CompactOptions): Promise<void> => {
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
			compact: async (): Promise<void> => {
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

	it("logs a throwing extension onError instead of dropping it", async () => {
		const events: CapturedLog[] = [];
		const dispose = logger.registerLogSink(event => {
			events.push(event);
		});
		const session = {
			compact: async (): Promise<void> => {
				throw new Error("Nothing to compact (session too small)");
			},
		};

		try {
			const outcome = await runExtensionCompact(session, {
				onError: () => {
					throw new Error("extension handler exploded");
				},
			}).then(
				() => "resolved" as const,
				() => "rejected" as const,
			);

			// The extension's own handler threw; the promise must still resolve.
			expect(outcome).toBe("resolved");
		} finally {
			dispose();
		}

		const warnings = events.filter(event => event.level === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Extension compaction onError threw");
		expect(warnings[0]?.context?.error).toBe("extension handler exploded");
	});

	it("logs a throwing extension onError when the session reported the failure first", async () => {
		const events: CapturedLog[] = [];
		const dispose = logger.registerLogSink(event => {
			events.push(event);
		});
		const failure = new Error("Nothing to compact (session too small)");
		const session = {
			compact: async (_instructions?: string, options?: CompactOptions): Promise<void> => {
				// Mirrors `session-maintenance.ts`: report, then rethrow.
				options?.onError?.(failure);
				throw failure;
			},
		};

		try {
			const outcome = await runExtensionCompact(session, {
				onError: () => {
					throw new Error("extension handler exploded");
				},
			}).then(
				() => "resolved" as const,
				() => "rejected" as const,
			);

			expect(outcome).toBe("resolved");
		} finally {
			dispose();
		}

		const warnings = events.filter(event => event.level === "warn");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.message).toBe("Extension compaction onError threw");
	});
});

describe("extension compaction call sites", () => {
	it("routes the interactive TUI compaction through the shared adapter", () => {
		expect(uiControllerSource).toContain("await runExtensionCompact(this.ctx.session, instructionsOrOptions);");
		expect(uiControllerSource).not.toContain("await this.ctx.session.compact(");
	});

	it("routes the runner-less session command context through the shared adapter", () => {
		expect(agentSessionSource).toContain("await runExtensionCompact(this, instructionsOrOptions);");
		expect(agentSessionSource).not.toContain("await this.compact(instructions, options);");
	});
});
