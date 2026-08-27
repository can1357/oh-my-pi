import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as os from "node:os";
import type { ClientBridge, ClientBridgeTerminalHandle } from "@oh-my-pi/pi-coding-agent/session/client-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";

function makeSession(bridge: ClientBridge): ToolSession {
	return {
		cwd: os.tmpdir(),
		hasUI: false,
		skills: [],
		getSessionFile: () => null,
		settings: {
			get(key: string) {
				if (key === "async.enabled") return false;
				if (key === "bash.autoBackground.enabled") return false;
				if (key === "bash.autoBackground.thresholdMs") return 60_000;
				if (key === "bashInterceptor.enabled") return false;
				if (key === "astGrep.enabled") return false;
				if (key === "astEdit.enabled") return false;
				if (key === "grep.enabled") return false;
				if (key === "glob.enabled") return false;
				return undefined;
			},
			getBashInterceptorRules() {
				return [];
			},
			getShellConfig() {
				// Fixed bash shell keeps the wrap assertions cross-platform: the fix
				// must reuse the resolved shell (Git Bash on Windows, `$SHELL` on
				// POSIX) instead of collapsing to `cmd.exe` — that's the contract
				// this test defends.
				return { shell: "/bin/bash", args: ["-l", "-c"], env: {}, prefix: undefined };
			},
		},
		getClientBridge: () => bridge,
	} as unknown as ToolSession;
}

// Keep the real promise/race behavior while compressing only ACP's deliberately
// conservative wall-clock deadline and cleanup grace periods.
function shortenAcpWaits(): void {
	const realSetTimeout = globalThis.setTimeout;
	spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number, ...args: unknown[]) =>
		realSetTimeout(
			handler,
			typeof ms === "number" && ms >= 1000 ? 50 : ms,
			...args,
		)) as typeof globalThis.setTimeout);
	const realSleep = Bun.sleep.bind(Bun);
	spyOn(Bun, "sleep").mockImplementation((duration?: number | Date) => {
		if (duration === 250) return realSleep(1);
		if (typeof duration === "number" && duration >= 1000) return realSleep(5);
		return realSleep(duration ?? 0);
	});
}

afterEach(() => {
	mock.restore();
});

describe("BashTool ACP terminal routing", () => {
	it("routes through bridge without emitting a legacy terminal snapshot, and releases the handle", async () => {
		const stubText = "hello from terminal\n";

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-xyz",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: async () => {},
		};

		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const createSpy = spyOn(bridge, "createTerminal");
		const releaseSpy = spyOn(handle, "release");

		let updates = 0;

		const tool = new BashTool(makeSession(bridge));
		const result = await tool.execute("call-1", { command: "echo hi" }, undefined, () => {
			updates++;
		});

		// createTerminal must send the resolved bash shell + `-l -c <line>` so
		// spec-conformant ACP clients that spawn `command` directly (no implicit
		// shell) still get bash semantics — never `cmd.exe`, which would break
		// `$VAR`, `$(...)`, `source`, and POSIX quoting on Windows.
		expect(createSpy).toHaveBeenCalledTimes(1);
		const params = createSpy.mock.calls[0]![0];
		expect(params.command).toBe("/bin/bash");
		expect(params.args).toEqual(["-l", "-c", "echo hi"]);

		// A client-owned terminal renders its own process bytes. This direct-use
		// harness has no presentation producer, so the obsolete cumulative callback
		// must remain silent rather than providing a second delivery channel.
		expect(updates).toBe(0);

		// The final result text must contain the stub output
		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("hello from terminal");

		// The handle must always be released
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("wraps shell metacharacters into args instead of packing them into command", async () => {
		// Regression for #4333: a bash line with `&&`, pipes, or spaces must not
		// be sent as raw `command` (spec-conformant ACP clients spawn command+args
		// directly and would ENOENT the whole line as argv[0]).
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-shell-wrap",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createSpy = spyOn(bridge, "createTerminal");

		const line = "git status && echo x | head";
		const tool = new BashTool(makeSession(bridge));
		await tool.execute("call-shell-wrap", { command: line });

		expect(createSpy).toHaveBeenCalledTimes(1);
		const params = createSpy.mock.calls[0]![0];
		expect(params.command).toBe("/bin/bash");
		expect(params.args).toEqual(["-l", "-c", line]);
		// `args` must actually be present — the bug was omitting it entirely.
		expect(params.args).toBeDefined();
		expect(params.args?.length).toBeGreaterThan(0);
	});

	it("does not allocate a client terminal when the signal is already aborted before createTerminal", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-should-not-create",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "should not be reached", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const createSpy = spyOn(bridge, "createTerminal");

		const controller = new AbortController();
		controller.abort();

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-pre-abort", { command: "echo hi" }, controller.signal)).rejects.toThrow(
			/Command aborted/,
		);

		expect(createSpy).toHaveBeenCalledTimes(0);
	});

	it("kills and releases a terminal created after cancellation wins the allocation race", async () => {
		const created = Promise.withResolvers<ClientBridgeTerminalHandle>();
		const createStarted = Promise.withResolvers<void>();
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-late-create",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: () => {
				createStarted.resolve();
				return created.promise;
			},
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");
		const controller = new AbortController();
		const tool = new BashTool(makeSession(bridge));

		const execution = tool.execute("call-late-create", { command: "sleep 60" }, controller.signal);
		await createStarted.promise;
		controller.abort();
		await expect(execution).rejects.toThrow(/Command aborted/);

		created.resolve(handle);
		await Promise.resolve();
		await Promise.resolve();
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("resolves using the last polled output when final output retrieval fails", async () => {
		shortenAcpWaits();
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let currentOutputCalls = 0;
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-output-failure",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				currentOutputCalls++;
				if (currentOutputCalls === 1) {
					// first poll loop iteration
					setTimeout(() => pendingExit.resolve({ exitCode: 0, signal: null }), 0);
					return { output: "polled text", truncated: false };
				}
				throw new Error("client output unavailable");
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		const result = await tool.execute("call-output-failure", { command: "echo hi" });

		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("polled text"); // proves fallback
		expect(result.isError).toBeUndefined();
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("releases the client terminal when waiting for exit fails", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-exit-failure",
			waitForExit: async () => {
				throw new Error("client wait unavailable");
			},
			currentOutput: async () => ({ output: "", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		await expect(tool.execute("call-exit-failure", { command: "echo hi" })).rejects.toThrow(
			/client wait unavailable/,
		);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kills and releases the client terminal when the caller aborts", async () => {
		shortenAcpWaits();
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const controller = new AbortController();

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-abort",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				// Trigger abort during the poll loop, ensuring handle is assigned
				controller.abort();
				return { output: "partial", truncated: false };
			},
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));

		const executePromise = tool.execute("call-abort", { command: "sleep 60" }, controller.signal);

		await expect(executePromise).rejects.toThrow(/Command aborted/);
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	});

	it("kills and releases the client terminal when the command times out", async () => {
		// The timeout and cleanup windows are compressed; the terminal promises,
		// kill-before-output ordering, and hung-RPC behavior remain real.
		shortenAcpWaits();
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		let killCalls = 0;
		let currentOutputAfterKill = 0;

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-timeout",
			waitForExit: async () => pendingExit.promise,
			currentOutput: async () => {
				if (killCalls > 0) currentOutputAfterKill++;
				return { output: "timeout output", truncated: false };
			},
			kill: async () => {
				killCalls++;
			},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));
		const executePromise = tool.execute("call-timeout", { command: "sleep 60", timeout: 1 });

		// A timeout is a completed-but-failed command, returned as an error
		// *result* rather than thrown: a throw becomes `buildToolErrorResult`
		// (`cursor.ts`), which carries no `details`, so every renderer would
		// lose the timeout and wall-time facts with it.
		const result = await executePromise;
		expect(result.isError).toBe(true);
		expect(result.content.find(c => c.type === "text")?.text).toMatch(/Command timed out after 1 seconds/);
		expect(result.details?.timedOut).toBe(true);

		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
		expect(currentOutputAfterKill).toBeGreaterThan(0);
	});

	it("still times out when a poll-tick output read hangs", async () => {
		// A never-settling output RPC exercises the real race while the outer
		// deadline is compressed to avoid paying a full second.
		shortenAcpWaits();
		const pendingExit = Promise.withResolvers<{ exitCode: number | null; signal: string | null }>();
		const neverOutput = new Promise<{ output: string; truncated: boolean }>(() => {});

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-hung-poll",
			waitForExit: async () => pendingExit.promise,
			currentOutput: () => neverOutput,
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};
		const killSpy = spyOn(handle, "kill");
		const releaseSpy = spyOn(handle, "release");

		const tool = new BashTool(makeSession(bridge));
		const executePromise = tool.execute("call-hung-poll", { command: "sleep 60", timeout: 1 });

		const result = await executePromise;
		expect(result.isError).toBe(true);
		expect(result.content.find(c => c.type === "text")?.text).toMatch(/Command timed out after 1 seconds/);
		// The hung poll read means no model-output snapshot arrived, but the timeout
		// result still settles after killing and releasing the client terminal.
		expect(killSpy).toHaveBeenCalledTimes(1);
		expect(releaseSpy).toHaveBeenCalledTimes(1);
	}, 8000);

	it("returns even when terminal release hangs", async () => {
		// release() truly never settles; only the production grace sleep is
		// compressed so this still proves cleanup is bounded.
		shortenAcpWaits();
		const stubText = "done\n";
		const neverRelease = new Promise<void>(() => {});

		const handle: ClientBridgeTerminalHandle = {
			terminalId: "term-hung-release",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: stubText, truncated: false }),
			kill: async () => {},
			release: () => neverRelease,
		};
		const bridge: ClientBridge = {
			capabilities: { terminal: true },
			createTerminal: async () => handle,
		};

		const tool = new BashTool(makeSession(bridge));
		const result = await tool.execute("call-hung-release", { command: "echo done" });

		const text = result.content.find(c => c.type === "text");
		expect(text?.text).toContain("done");
	}, 8000);
});
