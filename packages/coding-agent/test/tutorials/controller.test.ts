import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { getLesson } from "@oh-my-pi/pi-coding-agent/tutorials/catalog";
import { TutorialController } from "@oh-my-pi/pi-coding-agent/tutorials/controller";
import { TutorialProgressStore } from "@oh-my-pi/pi-coding-agent/tutorials/progress";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

const btw = getLesson("btw")!;

interface FakeOptions {
	clearSwitches?: boolean;
	moveSwitches?: boolean;
}

/** Minimal interactive context: sessions are files in `dir`, each with its own entry list. */
function fakeContext(dir: string, options: FakeOptions = {}) {
	const entries = new Map<string, unknown[]>();
	let counter = 0;
	const state = {
		sessionFile: path.join(dir, "home.jsonl"),
		cwd: dir,
		statuses: [] as string[],
		resumed: [] as string[],
	};
	entries.set(state.sessionFile, []);
	const ctx = {
		session: { isStreaming: false, getEnabledToolNames: () => ["read", "edit", "bash", "write", "eval"] },
		sessionManager: {
			getSessionFile: () => state.sessionFile,
			getCwd: () => state.cwd,
			getEntries: () => entries.get(state.sessionFile) ?? [],
			appendCustomEntry: (customType: string, data: unknown) => {
				entries.get(state.sessionFile)!.push({ type: "custom", customType, data });
			},
		},
		handleClearCommand: async () => {
			if (options.clearSwitches === false) return;
			state.sessionFile = path.join(dir, `s${++counter}.jsonl`);
			await Bun.write(state.sessionFile, "");
			entries.set(state.sessionFile, []);
		},
		handleMoveCommand: async (target: string) => {
			if (options.moveSwitches !== false) state.cwd = target;
		},
		handleResumeSession: async (file: string) => {
			state.resumed.push(file);
			state.sessionFile = file;
		},
		showStatus: (message: string) => state.statuses.push(message),
		showError: () => {},
		showWarning: () => {},
		presentCommandOutput: () => {},
		setHookWidget: () => {},
	};
	return { ctx: ctx as unknown as InteractiveModeContext, state };
}

async function setup(options?: FakeOptions) {
	const dir = TempDir.createSync("@pi-tutorial-controller-");
	const progressFile = path.join(dir.path(), "tutorials.json");
	const sandboxRoot = path.join(dir.path(), "sandboxes");
	const fake = fakeContext(dir.path(), options);
	const controller = new TutorialController(fake.ctx, { progressFile, sandboxRoot });
	await controller.init();
	return { dir, progressFile, sandboxRoot, controller, ...fake };
}

async function listDir(dir: string): Promise<string[]> {
	try {
		return await fs.readdir(dir);
	} catch {
		return [];
	}
}

describe("TutorialController", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("resumes an interrupted replay of a lesson finished earlier", async () => {
		const { dir, progressFile, sandboxRoot, controller, state } = await setup();
		using _ = dir;
		await controller.handleCommand("btw");
		for (const _step of btw.steps) await controller.handleCommand("skip");
		await controller.handleCommand("exit");

		// Replay: fresh run, one step in, then leave mid-lesson.
		await controller.handleCommand("btw");
		const replaySession = state.sessionFile;
		await controller.handleCommand("skip");
		await controller.handleCommand("exit");
		const replay = (await TutorialProgressStore.load(progressFile)).get("btw")!;
		expect(replay.finished).toBe(true);

		await controller.handleCommand("btw");
		expect(state.sessionFile).toBe(replaySession);
		expect(state.resumed).toContain(replaySession);
		const resumed = await TutorialProgressStore.load(progressFile);
		expect(resumed.get("btw")?.sandbox).toBe(replay.sandbox);
		expect(resumed.nextStep(btw)).toBe(btw.steps[1]);
		// The finished first run's sandbox was replaced, so only the replay's remains.
		expect(await listDir(sandboxRoot)).toEqual([path.basename(replay.sandbox!)]);
	});

	it("removes the new sandbox when /clear does not switch sessions", async () => {
		const { dir, sandboxRoot, controller } = await setup({ clearSwitches: false });
		using _ = dir;
		await controller.handleCommand("btw");
		expect(await listDir(sandboxRoot)).toEqual([]);
	});

	it("removes the new sandbox when /move does not reach it", async () => {
		const { dir, sandboxRoot, controller } = await setup({ moveSwitches: false });
		using _ = dir;
		await controller.handleCommand("btw");
		expect(await listDir(sandboxRoot)).toEqual([]);
	});

	it("does not hint on unrelated slash commands when the step has no command check", async () => {
		const { dir, controller, state } = await setup();
		using _ = dir;
		await controller.handleCommand("btw");
		await controller.handleCommand("skip"); // now on a file-check step
		state.statuses.length = 0;
		controller.noteCommand("model");
		await controller.settled();
		expect(state.statuses.filter(status => status.startsWith("Not yet"))).toEqual([]);
	});
});
