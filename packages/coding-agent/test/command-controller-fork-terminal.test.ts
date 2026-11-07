import { beforeAll, describe, expect, it } from "bun:test";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { TerminalLaunchRequest } from "@oh-my-pi/pi-coding-agent/subprocess/terminal-launch";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

beforeAll(async () => {
	await initTheme(false);
});

interface ForkHarness {
	controller: CommandController;
	launched: TerminalLaunchRequest[];
	errors: string[];
	ensureOnDiskCalls: number;
	sessionFile: string;
	materialize: () => Promise<void>;
}

async function makeHarness(options: { preMaterialized: boolean; ensureFails?: boolean }): Promise<ForkHarness> {
	const dir = await mkdtemp(join(tmpdir(), "omp-fork-term-"));
	const sessionFile = join(dir, "session.jsonl");
	const launched: TerminalLaunchRequest[] = [];
	const errors: string[] = [];
	let ensureOnDiskCalls = 0;
	if (options.preMaterialized) await writeFile(sessionFile, "{}\n");

	const materialize = async () => {
		await writeFile(sessionFile, "{}\n");
	};
	// Mirror the real SessionManager lazily-persisted contract: an allocated
	// path that leads nowhere until ensureOnDisk (or a first assistant message).
	const sessionManager = {
		getSessionFile: () => sessionFile,
		isSessionOnDisk: () => options.preMaterialized,
		flush: async () => {},
		ensureOnDisk: async () => {
			ensureOnDiskCalls++;
			if (options.ensureFails) return;
			await materialize();
		},
		getHeader: () => undefined,
		getCwd: () => dir,
	};

	const ctx = {
		session: {
			isStreaming: false,
			sessionId: "fresh-session-id",
			model: { provider: "github-copilot", id: "gpt-6.1-sol" },
			configuredThinkingLevel: () => undefined,
			agent: { promptCacheKey: undefined },
		},
		sessionManager,
		settings: {
			getAgentDir: () => join(dir, "agent"),
			getConfigFiles: () => [],
		},
		showHookConfirm: async () => true,
		showError: (message: string) => {
			errors.push(message);
		},
		showWarning: () => {},
		showStatus: () => {},
	};

	const controller = new CommandController(ctx as unknown as InteractiveModeContext, {
		classifyTerminalMultiplexer: () => "ghostty",
		environment: () => ({}) as NodeJS.ProcessEnv,
		argv: () => [],
		resolveCliEntryCmd: () => ["omp"],
		getActiveProfile: () => undefined,
		launchTerminal: async request => {
			launched.push(request);
			return { multiplexer: "ghostty", placement: "window", id: "term-new" };
		},
	});
	return {
		controller,
		launched,
		errors,
		get ensureOnDiskCalls() {
			return ensureOnDiskCalls;
		},
		sessionFile,
		materialize,
	};
}

describe("CommandController /fork terminal persistence", () => {
	it("materializes a lazily persisted fresh session and opens the fork", async () => {
		const harness = await makeHarness({ preMaterialized: false });
		await harness.controller.handleForkCommand("window");
		expect(harness.ensureOnDiskCalls).toBe(1);
		expect(harness.errors).toEqual([]);
		expect(harness.launched).toHaveLength(1);
		expect(harness.launched[0]!.multiplexer).toBe("ghostty");
		expect(harness.launched[0]!.placement).toBe("window");
		await rm(harness.sessionFile, { force: true });
	});

	it("does not re-materialize a session already on disk", async () => {
		const harness = await makeHarness({ preMaterialized: true });
		await harness.controller.handleForkCommand("window");
		expect(harness.ensureOnDiskCalls).toBe(0);
		expect(harness.errors).toEqual([]);
		expect(harness.launched).toHaveLength(1);
		await rm(harness.sessionFile, { force: true });
	});

	it("still reports the transcript error when materialization cannot produce the file", async () => {
		const harness = await makeHarness({ preMaterialized: false, ensureFails: true });
		await harness.controller.handleForkCommand("window");
		expect(harness.ensureOnDiskCalls).toBe(1);
		expect(harness.errors.join("\n")).toContain("transcript is unavailable");
		expect(harness.launched).toHaveLength(0);
	});
});
