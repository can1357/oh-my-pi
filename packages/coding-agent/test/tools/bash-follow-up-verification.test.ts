import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as bashExecutor from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import type { ClientBridge } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { withFollowUpVerification } from "@oh-my-pi/pi-coding-agent/tools/follow-up-context";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	mock.restore();
});

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(block => block.type === "text")?.text ?? "";
}

function shellQuote(value: string): string {
	return `'${value.replace(/\\/gu, "/").replace(/'/gu, "'\\''")}'`;
}

/** Bounded poll for a native follow-up process to touch disk. Fake timers cannot
 *  drive executeShell / brush, so this waits on the real marker with a deadline. */
async function pollUntil(predicate: () => boolean, deadlineMs: number): Promise<void> {
	while (!predicate() && Date.now() < deadlineMs) {
		await Bun.sleep(2);
	}
}

function makeSession(
	cwd: string,
	overrides: {
		settings?: Record<string, unknown>;
		asyncJobManager?: AsyncJobManager;
		getSessionId?: () => string;
		getClientBridge?: () => ClientBridge | undefined;
	} = {},
): ToolSession {
	return {
		cwd,
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		getSessionId: overrides.getSessionId ?? (() => "follow-up-test-session"),
		asyncJobManager: overrides.asyncJobManager,
		getClientBridge: overrides.getClientBridge ?? (() => undefined),
		settings: Settings.isolated({
			"async.enabled": false,
			"bash.autoBackground.enabled": false,
			"bash.autoBackground.thresholdMs": 60_000,
			"bashInterceptor.enabled": false,
			...overrides.settings,
		}),
	} as unknown as ToolSession;
}

describe("BashTool follow-up verification", () => {
	it("does not auto-background when verification is active", async () => {
		await using temp = await TempDir.create("@bash-follow-up-autobg-");
		const manager = new AsyncJobManager({});
		try {
			const tool = new BashTool(
				makeSession(temp.path(), {
					asyncJobManager: manager,
					settings: {
						"bash.autoBackground.enabled": true,
						"bash.autoBackground.thresholdMs": 0,
					},
				}),
			);
			const result = await withFollowUpVerification("verify-autobg", () =>
				tool.execute("verify-autobg", { command: "printf hi" }),
			);
			expect(result.details?.async).toBeUndefined();
			expect(textOf(result)).toContain("hi");
		} finally {
			await manager.dispose();
		}
	});

	it("overrides extension-revised async=true to stay in the foreground", async () => {
		await using temp = await TempDir.create("@bash-follow-up-async-");
		const manager = new AsyncJobManager({});
		try {
			const tool = new BashTool(
				makeSession(temp.path(), {
					asyncJobManager: manager,
					settings: { "async.enabled": true },
				}),
			);
			const result = await withFollowUpVerification("verify-async", () =>
				tool.execute("verify-async", { command: "printf hi", async: true }),
			);
			expect(result.details?.async).toBeUndefined();
			expect(textOf(result)).toContain("hi");
		} finally {
			await manager.dispose();
		}
	});

	it("rejects a remote ACP terminal session instead of running locally", async () => {
		const executeSpy = spyOn(bashExecutor, "executeBash");
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => {
				throw new Error("ACP terminal must not be created for follow-up");
			},
		};
		const tool = new BashTool(
			makeSession(os.tmpdir(), {
				getClientBridge: () => bridge,
			}),
		);
		await expect(
			withFollowUpVerification("verify-acp", () => tool.execute("verify-acp", { command: "printf hi" })),
		).rejects.toThrow(/remote ACP session/);
		expect(executeSpy).not.toHaveBeenCalled();
	});

	it("times out a long follow-up command at the requested deadline", async () => {
		await using temp = await TempDir.create("@bash-follow-up-timeout-");
		const tool = new BashTool(makeSession(temp.path()));
		// Native executeShell owns the 1s deadline; fake timers cannot fire it.
		const result = await withFollowUpVerification("verify-timeout", () =>
			tool.execute("verify-timeout", { command: "sleep 30", timeout: 1 }),
		);
		expect(result.isError).toBe(true);
		expect(result.details?.timedOut).toBe(true);
		expect(textOf(result)).toMatch(/timed out after 1 seconds/u);
	});

	it("cancels an in-flight follow-up command without classifying it as a timeout", async () => {
		await using temp = await TempDir.create("@bash-follow-up-cancel-");
		const started = path.join(temp.path(), "started");
		const tool = new BashTool(makeSession(temp.path()));
		const controller = new AbortController();
		const execution = withFollowUpVerification("verify-cancel", () =>
			tool.execute(
				"verify-cancel",
				{ command: `printf started > ${shellQuote(started)}; sleep 30` },
				controller.signal,
			),
		);
		await pollUntil(() => fs.existsSync(started), Date.now() + 4000);
		expect(fs.existsSync(started)).toBe(true);
		controller.abort();

		const error = await execution.catch(caught => caught);
		expect(error).toBeInstanceOf(ToolAbortError);
		const message = (error as Error).message;
		expect(message.match(/\[Command cancelled\]/gu)).toHaveLength(1);
		expect(message).not.toContain("Command aborted");
	});

	it.skipIf(process.platform === "win32")(
		"uses an isolated shell so verification cannot read or write session env",
		async () => {
			await using temp = await TempDir.create("@bash-follow-up-isolate-");
			const sessionId = `follow-up-isolate-${Date.now()}`;
			const tool = new BashTool(makeSession(temp.path(), { getSessionId: () => sessionId }));

			await tool.execute("seed", { command: "export PI_FOLLOW_UP_VAR=session" });
			const fromFollowUp = await withFollowUpVerification("verify-isolate", () =>
				tool.execute("verify-isolate", { command: "printf '%s' \"${PI_FOLLOW_UP_VAR:-unset}\"" }),
			);
			expect(textOf(fromFollowUp)).toContain("unset");

			await withFollowUpVerification("verify-isolate-write", () =>
				tool.execute("verify-isolate-write", { command: "export PI_FOLLOW_UP_VAR=verify" }),
			);
			const fromSession = await tool.execute("read-session", {
				command: "printf '%s' \"$PI_FOLLOW_UP_VAR\"",
			});
			expect(textOf(fromSession)).toContain("session");
			expect(textOf(fromSession)).not.toContain("verify");
		},
	);

	it.skipIf(process.platform === "win32")(
		"does not reset the session shell when a follow-up call is cancelled",
		async () => {
			await using temp = await TempDir.create("@bash-follow-up-cancel-isolate-");
			const sessionId = `follow-up-cancel-${Date.now()}`;
			const started = path.join(temp.path(), "started");
			const tool = new BashTool(makeSession(temp.path(), { getSessionId: () => sessionId }));
			await tool.execute("seed", { command: "export PI_FOLLOW_UP_KEEP=alive" });

			const controller = new AbortController();
			const execution = withFollowUpVerification("verify-cancel-isolate", () =>
				tool.execute(
					"verify-cancel-isolate",
					{ command: `printf started > ${shellQuote(started)}; sleep 30` },
					controller.signal,
				),
			);
			await pollUntil(() => fs.existsSync(started), Date.now() + 4000);
			expect(fs.existsSync(started)).toBe(true);
			controller.abort();
			await execution.catch(() => undefined);

			const kept = await tool.execute("read-session", {
				command: "printf '%s' \"${PI_FOLLOW_UP_KEEP:-unset}\"",
			});
			expect(textOf(kept)).toContain("alive");
		},
	);
});
