import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { GeminiLiveExecution } from "@oh-my-pi/pi-coding-agent/live/execution";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { TempDir } from "@oh-my-pi/pi-utils";
import { disposeVmContextsByOwner } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { disposeKernelSessionsByOwner } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import { cfgLiveComputer } from "@oh-my-pi/pi-coding-agent/live/settings";
import { withTimeout } from "@oh-my-pi/pi-utils/async";
import * as fs from "node:fs/promises";

const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const tempDirs: TempDir[] = [];
const executors: GeminiLiveExecution[] = [];
const runtimeOwners = new Set<string>();

afterEach(async () => {
	await Promise.allSettled(executors.splice(0).map(executor => executor.close()));
	for (const owner of runtimeOwners) {
		await Promise.all([disposeVmContextsByOwner(owner), disposeKernelSessionsByOwner(owner)]);
	}
	runtimeOwners.clear();
	for (const tempDir of tempDirs.splice(0)) tempDir.removeSync();
});

function harness(settingsOverrides: Record<string, unknown> = {}, provideEval = true) {
	const tempDir = TempDir.createSync("@pi-live-execution-");
	tempDirs.push(tempDir);
	runtimeOwners.add(`gemini-live-test-${tempDir.path()}`);
	const settings = Settings.isolated({
		"eval.autoBackground.enabled": false,
		"tools.approvalMode": "yolo",
		...settingsOverrides,
	});
	const evalSession: ToolSession = {
		cwd: tempDir.path(),
		hasUI: false,
		settings,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getEvalSessionId: () => `gemini-live-test-${tempDir.path()}`,
		getEvalKernelOwnerId: () => `gemini-live-test-${tempDir.path()}`,
		getEvalPreludes: () => [],
	};
	const evalTool = provideEval ? (new EvalTool(evalSession) as unknown as AgentTool) : undefined;
	const session = {
		settings,
		sessionManager: { getCwd: () => tempDir.path() },
		sessionFile: undefined,
		sessionId: `gemini-live-test-${tempDir.path()}`,
		model: undefined,
		getEvalSessionId: () => evalSession.getEvalSessionId?.() ?? "gemini-live-test",
		getEvalKernelOwnerId: () => evalSession.getEvalKernelOwnerId?.() ?? "gemini-live-test",
		getEvalPreludes: () => [],
		getToolByName: (name: string) => (name === "eval" ? evalTool : undefined),
		getToolForEvalBridge: (name: string) => (name === "eval" ? evalTool : undefined),
		getEvalBridgeToolNames: () => (evalTool ? ["eval"] : []),
	} as unknown as AgentSession;
	return { session, evalTool, tempDir };
}

function execution(session: AgentSession, desktopEnabled = false): GeminiLiveExecution {
	const executor = new GeminiLiveExecution(session, desktopEnabled);
	executors.push(executor);
	return executor;
}

describe("GeminiLiveExecution", () => {
	it("runs Gemini-authored JavaScript and returns text and images through the real eval runtime", async () => {
		const { session } = harness();
		const executor = execution(session);

		expect(executor.codeEnabled).toBe(true);
		const result = await executor.executeCode(
			`print([3, 5].reduce((sum, n) => sum + n * n, 0)); display({ type: "image", data: "${PNG_1X1}", mimeType: "image/png" });`,
			"js",
		);

		expect(result.text).toContain("34");
		expect(result.images).toHaveLength(1);
		const image = result.images[0]!;
		const metadata = await new Bun.Image(Buffer.from(image.data, "base64")).metadata();
		expect(image.mimeType).toBe(`image/${metadata.format}`);
		expect(metadata.width).toBe(metadata.height);
	});

	it("runs Gemini-authored Python through the session eval runtime", async () => {
		const { session } = harness();
		const result = await execution(session).executeCode("print(sum(n*n for n in range(4)))", "py");
		expect(result.text).toContain("14");
	});

	it("does not advertise or execute code when eval is absent from the allowed session surface", async () => {
		const { session } = harness({}, false);
		const executor = execution(session);

		expect(executor.codeEnabled).toBe(false);
		await expect(executor.executeCode('print("must-not-run")', "py")).rejects.toThrow(/not enabled/);
	});

	it("aborts real JavaScript execution before later host code can mutate a file", async () => {
		const { session, tempDir } = harness();
		const executor = execution(session);
		const ready = Bun.file(tempDir.join("started.txt"));
		const destination = tempDir.join("must-not-exist.txt");
		const abort = new AbortController();
		const readyEvents = fs.watch(tempDir.path(), { signal: abort.signal });
		const reachedMarker = (async () => {
			for await (const event of readyEvents) {
				if (event.filename === "started.txt") return;
			}
			throw new Error("Readiness watcher ended before eval started");
		})();
		// Real isolated-worker termination: fake timers cannot drive this worker's host code.
		const running = executor.executeCode(
			`await Bun.write(${JSON.stringify(ready.name)}, "started"); await Bun.sleep(60_000); await Bun.write(${JSON.stringify(destination)}, "late effect");`,
			"js",
			abort.signal,
		);
		const prematureCompletion = running.then(() => {
			throw new Error("Eval completed before reaching the cancellation boundary");
		});
		try {
			await withTimeout(
				Promise.race([reachedMarker, prematureCompletion]),
				20_000,
				"Eval did not reach the owned readiness marker",
			);
			const stopped = (async () => {
				await expect(running).rejects.toThrow();
			})();
			abort.abort();
			await withTimeout(stopped, 10_000, "Cancelled eval did not settle");

			const replacement = await executor.executeCode("print(6 * 7)", "js");
			expect(replacement.text).toContain("42");
			expect(await Bun.file(destination).exists()).toBe(false);
		} finally {
			abort.abort();
		}
	});

	it("closing rejects later live calls without closing the AgentSession-owned eval runtime", async () => {
		const { session, evalTool } = harness();
		const executor = execution(session);
		await executor.close();

		await expect(executor.executeCode('print("late")', "js")).rejects.toThrow(/closed/);
		const sessionResult = await evalTool!.execute("session-still-open", { language: "js", code: 'print("owned")' });
		const text = sessionResult.content.flatMap(content => (content.type === "text" ? [content.text] : [])).join("\n");
		expect(text).toContain("owned");
	});

	it("rejects desktop host code when either opt-in or the underlying capability is unavailable", async () => {
		for (const [settings, optIn] of [
			[{ "computer.enabled": true, "live.computer": false }, false],
			[{ "computer.enabled": false, "live.computer": true }, true],
		] as const) {
			const { session, tempDir } = harness(settings);
			const executor = execution(session, optIn);
			const destination = tempDir.join("disabled-mutation.txt");
			await expect(
				executor.executeDesktop(`await Bun.write(${JSON.stringify(destination)}, "not authorized")`),
			).rejects.toThrow(/not enabled/);
			expect(await Bun.file(destination).exists()).toBe(false);
		}
	});

	it("revoking live.computer blocks an existing desktop surface before host code runs", async () => {
		const { session, tempDir } = harness({ "computer.enabled": true, "live.computer": true });
		const executor = execution(session, true);
		cfgLiveComputer.override(session.settings, false);
		const destination = tempDir.join("revoked-mutation.txt");

		await expect(
			executor.executeDesktop(`await Bun.write(${JSON.stringify(destination)}, "not authorized")`),
		).rejects.toThrow(/not enabled/);
		expect(await Bun.file(destination).exists()).toBe(false);
	});

	it("fails closed before native desktop execution when computer permission is denied", async () => {
		const { session } = harness({
			"computer.enabled": true,
			"live.computer": true,
			"tools.approval": { computer: "deny" },
		});
		const executor = execution(session, true);

		expect(executor.desktopEnabled).toBe(true);
		await expect(executor.executeDesktop("await desktop.screenshot()", undefined, true)).rejects.toThrow(/blocked/);
		await executor.close();
		await expect(executor.executeDesktop("await desktop.screenshot()", undefined, true)).rejects.toThrow(/closed/);
	});
});
