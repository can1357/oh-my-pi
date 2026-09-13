import { afterEach, describe, expect, test, vi } from "bun:test";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { type AsyncJob, AsyncJobManager, type AsyncJobProgressInfo } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { ProgressLines } from "@oh-my-pi/pi-coding-agent/async/progress-lines";
import { OutputSink } from "@oh-my-pi/pi-coding-agent/session/streaming-output";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { ToolAbortError, ToolError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { TempDir } from "@oh-my-pi/pi-utils";

const SETTINGS: Record<string, unknown> = {
	"async.enabled": true,
	"bash.autoBackground.enabled": false,
	"bash.autoBackground.thresholdMs": 60_000,
	"bashInterceptor.enabled": false,
	"astGrep.enabled": false,
	"astEdit.enabled": false,
	"grep.enabled": false,
	"glob.enabled": false,
};

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession(manager: AsyncJobManager, overrides: Record<string, unknown> = {}): ToolSession {
	const settings = { ...SETTINGS, ...overrides };
	return {
		cwd: "/tmp",
		hasUI: false,
		skills: [],
		asyncJobManager: manager,
		getAgentId: () => "Main",
		getSessionId: () => "progress-test",
		getSessionFile: () => null,
		settings: {
			get: (key: string) => settings[key],
			getBashInterceptorRules: () => [],
			getShellConfig: () => ({}),
		},
		getClientBridge: () => undefined,
	} as unknown as ToolSession;
}

function collectProgress(manager: AsyncJobManager): string[] {
	const seen: string[] = [];
	manager.registerDeliverySink("Main", () => {});
	manager.registerProgressSink("Main", {
		deliver: (_jobId, text) => {
			seen.push(text);
		},
	});
	return seen;
}

describe("bash progress parameter", () => {
	test("defaults off", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("default-off", { command: "printf 'one\\ntwo\\n'", async: true });
		await manager.waitForAll();

		expect(seen).toEqual([]);
	});

	test("reports complete non-empty lines and flushes the final partial line", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("complete-lines", {
			command: "printf par; sleep 0.1; printf 'tial\\n\\n'",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();
		await tool.execute("final-partial", {
			command: "printf final",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toEqual(["partial", "final"]);
	}, 10_000);

	test("bounds an unterminated output line before reporting it", async () => {
		const manager = new AsyncJobManager({});
		const seen = collectProgress(manager);
		const tool = new BashTool(makeSession(manager));

		await tool.execute("bounded-line", {
			command: "printf 'H%.0s' {1..300}; printf '%04400d' 0; printf 'T%.0s' {1..300}",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toHaveLength(1);
		expect(seen[0]).toHaveLength(500);
		expect(seen[0]).toBe(`${"H".repeat(250)}${"T".repeat(250)}`);
	});

	test("keeps the full raw stream in the same artifact referenced by bounded progress", async () => {
		using tempDir = TempDir.createSync("@omp-bash-progress-artifact-");
		const artifact = { id: "bash-progress-1", path: path.join(tempDir.path(), "output.txt") };
		const manager = new AsyncJobManager({});
		const seen: Array<{ text: string; info: AsyncJobProgressInfo; artifactText: string }> = [];
		manager.registerDeliverySink("Main", () => {});
		manager.registerProgressSink("Main", {
			deliver: async (_jobId, text, _job, _seq, info) => {
				seen.push({ text, info, artifactText: await Bun.file(artifact.path).text() });
			},
		});
		const session = makeSession(manager);
		session.allocateOutputArtifact = async () => artifact;
		const tool = new BashTool(session);

		await tool.execute("artifact-backed-line", {
			command: "printf 'H%.0s' {1..300}; printf '%04400d' 0; printf 'T%.0s' {1..300}",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();

		expect(seen).toEqual([
			{
				text: `${"H".repeat(250)}${"T".repeat(250)}`,
				info: { artifactId: artifact.id, truncated: true },
				artifactText: `${"H".repeat(300)}${"0".repeat(4_400)}${"T".repeat(300)}`,
			},
		]);
		expect(await Bun.file(artifact.path).text()).toBe(`${"H".repeat(300)}${"0".repeat(4_400)}${"T".repeat(300)}`);
	});

	test("keeps terminal output when the progress artifact cannot be created", async () => {
		using tempDir = TempDir.createSync("@omp-bash-progress-artifact-failure-");
		const artifact = { id: "broken-progress", path: path.join(tempDir.path(), "missing", "output.txt") };
		const manager = new AsyncJobManager({});
		const progress: Array<{ text: string; info: AsyncJobProgressInfo }> = [];
		const completions: Array<{ text: string; job?: AsyncJob }> = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text, _job, _seq, info) => {
				progress.push({ text, info });
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text, job) => {
			completions.push({ text, job });
		});
		const session = makeSession(manager);
		session.allocateOutputArtifact = async () => artifact;
		const tool = new BashTool(session);

		await tool.execute("broken-progress-artifact", {
			command: "printf 'only-result\\n'",
			async: true,
			progress: "wake",
		});
		await manager.waitForAll();
		await manager.drainDeliveries();

		expect(progress).toHaveLength(1);
		expect(progress[0]?.text).toBe("only-result");
		expect(progress[0]?.info.artifactId).toBeUndefined();
		expect(completions).toHaveLength(1);
		expect(completions[0]?.text).toContain("only-result");
		expect(completions[0]?.job?.progressArtifactId).toBeUndefined();
		expect(await Bun.file(artifact.path).exists()).toBeFalse();
	});

	test("rejects progress for a foreground command", async () => {
		const manager = new AsyncJobManager({});
		const tool = new BashTool(makeSession(manager));

		await expect(tool.execute("foreground", { command: "echo no", progress: "wake" })).rejects.toThrow(
			/requires `async: true`/,
		);
	});

	test("keeps advisor sessions inline for explicit and implicit background modes", async () => {
		// The SDK builds advisor tool sessions with the literal agent id
		// "advisor" (never a registry owner) and no async job manager, because
		// nothing would deliver a job's result to them.
		const session = {
			...makeSession(new AsyncJobManager({}), { "bash.autoBackground.enabled": true }),
			asyncJobManager: undefined,
			getAgentId: () => "advisor",
			agentRegistry: { get: () => undefined },
		} as unknown as ToolSession;
		const tool = new BashTool(session);

		for (const asyncMode of [true, "auto"] as const) {
			await expect(tool.execute("advisor-background", { command: "echo no", async: asyncMode })).rejects.toThrow(
				"job manager unavailable for this session",
			);
		}
		const result = await tool.execute("advisor-foreground", { command: "printf 'advisor-inline\\n'" });
		expect(result.details?.async).toBeUndefined();
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("advisor-inline") }),
		);
	});

	test("rejects PTY with async auto at the tool boundary", async () => {
		const manager = new AsyncJobManager({});
		const tool = new BashTool(makeSession(manager));

		const execution = tool.execute("pty-auto", {
			command: "printf unreachable",
			async: "auto",
			pty: true,
		});

		await expect(execution).rejects.toBeInstanceOf(ToolError);
		await expect(execution).rejects.toThrow('`pty: true` cannot be combined with `async: "auto"`.');
		await manager.dispose();
	});

	test("keeps a quick auto command inline without progress or completion delivery", async () => {
		const manager = new AsyncJobManager({});
		const progress = collectProgress(manager);
		const completions: string[] = [];
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 2_000 }));

		const result = await tool.execute("auto-inline", {
			command: "printf 'quick-result\\n'",
			async: "auto",
			progress: "wake",
		});
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(result.details?.async).toBeUndefined();
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("quick-result") }),
		);
		expect(progress).toEqual([]);
		expect(completions).toEqual([]);
		await manager.dispose();
	});

	test("runs auto inline with a notice at the running-job cap while explicit async errors", async () => {
		using tempDir = TempDir.createSync("@omp-bash-auto-at-capacity-");
		const releasePath = path.join(tempDir.path(), "release");
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		const progress = collectProgress(manager);
		const completions: string[] = [];
		manager.registerDeliverySink("Main", (_jobId, text) => {
			completions.push(text);
		});
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 50 }));
		await tool.execute("occupy-slot", {
			command: 'while [ ! -f "$RELEASE" ]; do sleep 0.01; done; printf "slot-released\\n"',
			env: { RELEASE: releasePath },
			async: true,
		});
		expect(manager.atCapacity).toBe(true);

		const explicit = tool.execute("explicit-at-capacity", { command: "echo no", async: true });
		await expect(explicit).rejects.toBeInstanceOf(ToolError);
		await expect(explicit).rejects.toThrow("Background job limit reached");

		const register = vi.spyOn(manager, "register");
		// Outlives the 50 ms grace, so without the cap it would have promoted.
		const result = await tool.execute("auto-at-capacity", {
			command: "sleep 0.2; printf 'inline-at-cap\\n'",
			async: "auto",
			progress: "wake",
		});
		const resultText = result.content.find(block => block.type === "text")?.text ?? "";

		expect(register).not.toHaveBeenCalled();
		expect(result.details?.async).toBeUndefined();
		expect(resultText).toContain("inline-at-cap");
		expect(resultText).toContain("Background job limit reached; ran inline to completion");
		expect(progress).toEqual([]);

		await Bun.write(releasePath, "");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });
		expect(completions).toHaveLength(1);
		expect(completions[0]).toContain("slot-released");
		await manager.dispose();
	}, 10_000);

	test("never promotes an auto command whose deadline cannot outlive the grace", async () => {
		const manager = new AsyncJobManager({});
		const progress = collectProgress(manager);
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 100 }));
		const register = vi.spyOn(manager, "register");

		// 1 s deadline <= 100 ms grace + 1 s buffer: outliving the grace must
		// still resolve inline instead of promoting a job about to expire.
		const completed = await tool.execute("auto-tiny-timeout", {
			command: "sleep 0.4; printf 'tiny-timeout-inline\\n'",
			async: "auto",
			progress: "wake",
			timeout: 1,
		});
		expect(register).not.toHaveBeenCalled();
		expect(completed.details?.async).toBeUndefined();
		expect(completed.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("tiny-timeout-inline") }),
		);

		// The deadline itself also expires inline rather than as a dead job.
		const expired = await tool.execute("auto-tiny-timeout-expired", {
			command: "sleep 5",
			async: "auto",
			timeout: 1,
		});
		expect(register).not.toHaveBeenCalled();
		expect(expired.details?.async).toBeUndefined();
		expect(expired.details?.timedOut).toBe(true);
		expect(progress).toEqual([]);
		await manager.dispose();
	}, 10_000);

	test("promotes past a stalled pre-promotion delivery and keeps the terminal text", async () => {
		using tempDir = TempDir.createSync("@omp-bash-stalled-promotion-");
		const releasePath = path.join(tempDir.path(), "release");
		const artifact = { id: "stalled-progress", path: path.join(tempDir.path(), "output.txt") };
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const session = makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 100 });
		session.allocateOutputArtifact = async () => artifact;
		const tool = new BashTool(session);

		// Mirror mode flushes the artifact before each onChunk; hold the first
		// flush so the inline line's delivery (and its barrier token) never
		// settles while the grace elapses.
		const releaseFlush = Promise.withResolvers<void>();
		const originalFlush = OutputSink.prototype.flushArtifact;
		let held = false;
		vi.spyOn(OutputSink.prototype, "flushArtifact").mockImplementation(async function (this: OutputSink) {
			if (!held) {
				held = true;
				await releaseFlush.promise;
			}
			return originalFlush.call(this);
		});

		const startedAt = performance.now();
		const result = await tool.execute("stalled-auto-promote", {
			command:
				"printf 'stalled-line\\n'; " +
				'while [ ! -f "$RELEASE" ]; do sleep 0.01; done; ' +
				"printf 'after-stall\\n'",
			env: { RELEASE: releasePath },
			async: "auto",
			progress: "wake",
		});
		const elapsedMs = performance.now() - startedAt;
		const resultText = result.content.find(block => block.type === "text")?.text ?? "";

		expect(held).toBe(true);
		expect(result.details?.async?.state).toBe("running");
		expect(resultText).not.toContain("stalled-line");
		// Grace (100 ms) + drain guard (1 s), not the command's lifetime.
		expect(elapsedMs).toBeLessThan(5_000);

		releaseFlush.resolve();
		await Bun.write(releasePath, "");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const completedJob = manager.getJob(result.details?.async?.jobId ?? "");
		expect(completedJob?.terminalTextProvenance).toBe("terminal");
		expect(events.filter(event => event.startsWith("progress:"))).toEqual(["progress:after-stall"]);
		expect(events.at(-1)).toContain("completion:");
		expect(events.at(-1)).toContain("stalled-line");
		expect(events.at(-1)).toContain("after-stall");
		await manager.dispose();
	}, 10_000);

	test("cancels instead of promoting when the tool is aborted during the drain", async () => {
		using tempDir = TempDir.createSync("@omp-bash-drain-abort-");
		const releasePath = path.join(tempDir.path(), "release");
		const pidPath = path.join(tempDir.path(), "pid");
		const artifact = { id: "drain-abort-progress", path: path.join(tempDir.path(), "output.txt") };
		const manager = new AsyncJobManager({});
		manager.registerProgressSink("Main", { deliver: () => {} });
		manager.registerDeliverySink("Main", () => {});
		const session = makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 100 });
		session.allocateOutputArtifact = async () => artifact;
		const tool = new BashTool(session);

		// Same stall as above: the held mirror flush keeps the first chunk's
		// barrier token pending, so promotion sits in its bounded drain window.
		const releaseFlush = Promise.withResolvers<void>();
		const flushHeld = Promise.withResolvers<void>();
		const originalFlush = OutputSink.prototype.flushArtifact;
		let held = false;
		vi.spyOn(OutputSink.prototype, "flushArtifact").mockImplementation(async function (this: OutputSink) {
			if (!held) {
				held = true;
				flushHeld.resolve();
				await releaseFlush.promise;
			}
			return originalFlush.call(this);
		});

		const controller = new AbortController();
		const execution = tool
			.execute(
				"drain-abort",
				{
					// The in-process shell's `$$` is the host pid; hold the loop in
					// an external `sh` whose pid proves the command was killed.
					command:
						"printf 'stalled-line\\n'; " +
						`sh -c 'echo $$ > "$PIDFILE"; while [ ! -f "$RELEASE" ]; do sleep 0.01; done'; ` +
						"printf 'after-stall\\n'",
					env: { RELEASE: releasePath, PIDFILE: pidPath },
					async: "auto",
					progress: "wake",
				},
				controller.signal,
			)
			.then(
				result => ({ kind: "resolved" as const, result }),
				(error: unknown) => ({ kind: "rejected" as const, error }),
			);
		await flushHeld.promise;
		// Real delay: the grace and drain guard are wall-clock timers racing
		// a live subprocess's I/O, and the drain start has no observable
		// hook. 400 ms sits past the 100 ms grace and well inside the 1 s
		// drain window on either side.
		await Bun.sleep(400);
		controller.abort();
		const outcome = await execution;

		expect(outcome.kind).toBe("rejected");
		if (outcome.kind === "rejected") {
			expect(outcome.error).toBeInstanceOf(ToolAbortError);
		}
		const [job] = manager.getAllJobs();
		expect(job?.status).toBe("cancelled");

		releaseFlush.resolve();
		await manager.waitForAll();
		const pid = Number.parseInt((await Bun.file(pidPath).text()).trim(), 10);
		expect(Number.isInteger(pid)).toBe(true);
		// The executor returns the cancelled result before the shell is reaped;
		// poll the OS for the actual exit rather than guessing a delay.
		const deadline = performance.now() + 5_000;
		let alive = true;
		while (alive && performance.now() < deadline) {
			try {
				process.kill(pid, 0);
				await Bun.sleep(10);
			} catch {
				alive = false;
			}
		}
		expect(alive).toBe(false);
		expect(await Bun.file(releasePath).exists()).toBe(false);
		expect(manager.getJob(job?.id ?? "")?.status).toBe("cancelled");
		await manager.dispose();
	}, 10_000);

	test("keeps terminal text when the inline preview could not hold the foreground stream", async () => {
		const manager = new AsyncJobManager({});
		const progress = collectProgress(manager);
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 200 }));

		// 60 KB before the grace outgrows the 50 KB preview tail; the bytes it
		// dropped were never returned, so completion must not treat the
		// foreground provenance as already shown.
		const result = await tool.execute("auto-promote-oversized-preview", {
			command: "yes x | head -c 60000; printf '\\n'; sleep 0.5",
			async: "auto",
			progress: "wake",
		});
		const resultText = result.content.find(block => block.type === "text")?.text ?? "";

		expect(result.details?.async?.state).toBe("running");
		expect(resultText.length).toBeLessThan(60_000);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const completedJob = manager.getJob(result.details?.async?.jobId ?? "");
		expect(completedJob?.terminalTextProvenance).toBe("terminal");
		expect(progress).toEqual([]);
		await manager.dispose();
	}, 10_000);

	test("promotes a slow auto command and delivers only later lines before completion", async () => {
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const tool = new BashTool(
			makeSession(manager, {
				"bash.autoBackground.thresholdMs": 2_000,
				"bash.asyncAuto.inlineGraceMs": 200,
			}),
		);

		const result = await tool.execute("auto-promote", {
			command: "printf 'before-promotion\\n'; sleep 0.5; printf 'after-promotion\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("before-promotion") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const completedJob = manager.getJob(result.details?.async?.jobId ?? "");
		expect(completedJob?.terminalTextProvenance).toBe("progress");

		expect(events[0]).toBe("progress:after-promotion");
		expect(events[1]).toContain("completion:");
		expect(events[1]).toContain("before-promotion");
		expect(events[1]).toContain("after-promotion");
		expect(events.join("\n").match(/progress:before-promotion/g)).toBeNull();
		await manager.dispose();
	}, 10_000);

	test("keeps continuous coverage when all output arrives after auto-promotion", async () => {
		const manager = new AsyncJobManager({});
		const progress: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				progress.push(text);
			},
		});
		manager.registerDeliverySink("Main", () => {});
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 100 }));

		const result = await tool.execute("auto-promote-empty-foreground", {
			command: "sleep 0.4; printf 'post-promotion-only\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const completedJob = manager.getJob(result.details?.async?.jobId ?? "");
		expect(completedJob?.terminalTextProvenance).toBe("progress");
		expect(progress).toEqual(["post-promotion-only"]);
		await manager.dispose();
	}, 10_000);

	test("records foreground-only output provenance when auto-promoted", async () => {
		const manager = new AsyncJobManager({});
		const progress: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				progress.push(text);
			},
		});
		manager.registerDeliverySink("Main", () => {});
		const tool = new BashTool(
			makeSession(manager, {
				"bash.autoBackground.thresholdMs": 2_000,
				"bash.asyncAuto.inlineGraceMs": 200,
			}),
		);

		const result = await tool.execute("auto-promote-foreground-only", {
			command: "printf 'foreground-only\\n'; sleep 0.5",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("foreground-only") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const completedJob = manager.getJob(result.details?.async?.jobId ?? "");
		expect(completedJob?.terminalTextProvenance).toBe("progress");
		expect(completedJob?.progressDeliveredCount).toBe(1);
		expect(progress).toEqual([]);
		await manager.dispose();
	}, 10_000);

	test("does not repeat foreground output when only a blank line follows auto-promotion", async () => {
		const manager = new AsyncJobManager({});
		const progress: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				progress.push(text);
			},
		});
		manager.registerDeliverySink("Main", () => {});
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 200 }));

		const result = await tool.execute("auto-promote-blank-suffix", {
			command: "printf 'ready\\n'; sleep 0.5; printf '\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("ready") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const completedJob = manager.getJob(result.details?.async?.jobId ?? "");
		expect(completedJob?.terminalTextProvenance).toBe("progress");
		expect(completedJob?.progressDeliveredCount).toBe(1);
		expect(progress).toEqual([]);
		await manager.dispose();
	}, 10_000);

	test("surfaces async-auto artifact allocation failures before the promotion grace", async () => {
		const manager = new AsyncJobManager({});
		manager.registerDeliverySink("Main", () => {});
		const session = makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 60_000 });
		const allocationStarted = Promise.withResolvers<void>();
		session.allocateOutputArtifact = async () => {
			allocationStarted.resolve();
			throw new Error("artifact allocation failed");
		};
		const tool = new BashTool(session);
		const controller = new AbortController();
		const execution = tool
			.execute("allocation-failure", { command: "printf unreachable", async: "auto" }, controller.signal)
			.then(
				() => ({ kind: "resolved" as const }),
				error => ({ kind: "failed" as const, error }),
			);
		await allocationStarted.promise;

		const firstSettlement = await Promise.race([
			execution,
			manager.waitForAll().then(async () => {
				await Bun.sleep(0);
				return { kind: "manager-only" as const };
			}),
		]);
		if (firstSettlement.kind === "manager-only") controller.abort();

		expect(firstSettlement.kind).toBe("failed");
		if (firstSettlement.kind === "failed") {
			expect(firstSettlement.error).toBeInstanceOf(Error);
			expect((firstSettlement.error as Error).message).toBe("artifact allocation failed");
		}
		await execution;
		await manager.dispose();
	});

	test("promotes after a mirror artifact failure instead of waiting for command exit", async () => {
		using tempDir = TempDir.createSync("@omp-bash-auto-artifact-failure-");
		const releasePath = path.join(tempDir.path(), "release");
		const artifact = { id: "broken-auto-progress", path: path.join(tempDir.path(), "missing", "output.txt") };
		const manager = new AsyncJobManager({});
		const progress: string[] = [];
		const completions: Array<{ text: string; job?: AsyncJob }> = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				progress.push(text);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text, job) => {
			completions.push({ text, job });
		});
		const session = makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 20 });
		session.allocateOutputArtifact = async () => artifact;
		const tool = new BashTool(session);

		const result = await tool.execute("broken-auto-progress-artifact", {
			command:
				"printf 'before-failure\\n'; " +
				'while [ ! -f "$RELEASE" ]; do sleep 0.01; done; ' +
				"printf 'after-failure\\n'",
			env: { RELEASE: releasePath },
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(progress).toEqual([]);
		await Bun.write(releasePath, "");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(completions).toHaveLength(1);
		expect(completions[0]?.text).toContain("before-failure");
		expect(completions[0]?.text).toContain("after-failure");
		expect(completions[0]?.job?.progressArtifactId).toBeUndefined();
		expect(await Bun.file(artifact.path).exists()).toBeFalse();
		await manager.dispose();
	}, 10_000);

	test("freezes the foreground preview before a mirror-delayed post-boundary callback", async () => {
		using tempDir = TempDir.createSync("@omp-bash-stable-promotion-preview-");
		const releasePath = path.join(tempDir.path(), "release");
		const manager = new AsyncJobManager({});
		const progressEvents: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				progressEvents.push(text);
			},
		});
		manager.registerDeliverySink("Main", () => {});

		let reportPreview: ((text: string, details?: Record<string, unknown>) => void | Promise<void>) | undefined;
		let reportAgentProgress: ((text: string, info?: AsyncJobProgressInfo) => void) | undefined;
		const register = manager.register.bind(manager);
		manager.register = (type, label, run, options) => {
			reportPreview = options?.onProgress;
			return register(
				type,
				label,
				context => {
					reportAgentProgress = context.reportAgentProgress;
					return run(context);
				},
				options,
			);
		};

		const deliveriesResumed = Promise.withResolvers<void>();
		let postBoundaryCallbackRan = false;
		const resumeDeliveries = manager.resumeDeliveries.bind(manager);
		manager.resumeDeliveries = jobIds => {
			resumeDeliveries(jobIds);
			deliveriesResumed.resolve();
		};
		const activateProgressDelivery = manager.activateProgressDelivery.bind(manager);
		manager.activateProgressDelivery = (jobId, delivery, foregroundStreamProvenance, coverage) => {
			const activated = activateProgressDelivery(jobId, delivery, foregroundStreamProvenance, coverage);
			queueMicrotask(() => {
				postBoundaryCallbackRan = true;
				void reportPreview?.("foreground\npost-boundary\n");
				void deliveriesResumed.promise.then(() => reportAgentProgress?.("post-boundary"));
			});
			return activated;
		};

		const steering = new AbortController();
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 60_000 }));
		const result = await tool.execute(
			"auto-promote-stable-preview",
			{
				command: "printf 'foreground\\n'; while [ ! -f \"$RELEASE\" ]; do sleep 0.01; done",
				env: { RELEASE: releasePath },
				async: "auto",
				progress: "wake",
			},
			undefined,
			update => {
				const text = update.content.find(block => block.type === "text")?.text ?? "";
				if (text.includes("foreground")) steering.abort();
			},
			{
				toolCall: {
					batchId: "stable-promotion-preview",
					index: 0,
					total: 1,
					toolCalls: [{ id: "auto-promote-stable-preview", name: "bash" }],
					steeringSignal: steering.signal,
				},
			} as AgentToolContext,
		);
		const resultText = result.content.find(block => block.type === "text")?.text ?? "";

		expect(result.details?.async?.state).toBe("running");
		expect(postBoundaryCallbackRan).toBe(true);
		expect(resultText).toContain("foreground");
		expect(resultText).not.toContain("post-boundary");

		await Bun.write(releasePath, "");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });
		expect(progressEvents).toEqual(["post-boundary"]);
		await manager.dispose();
	}, 10_000);

	test("does not replay inline-shown partial output after promotion", async () => {
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const tool = new BashTool(
			makeSession(manager, {
				"bash.autoBackground.thresholdMs": 2_000,
				"bash.asyncAuto.inlineGraceMs": 100,
			}),
		);

		// One output line spans the promotion boundary: "before" is printed and
		// shown inline during the grace window; "after\n" completes the line
		// only after promotion. Progress must not replay the inline prefix.
		const result = await tool.execute("auto-promote-boundary", {
			command: "printf before; sleep 0.5; printf 'after\\n'",
			async: "auto",
			progress: "wake",
		});

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("before") }),
		);
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		const progressEvents = events.filter(event => event.startsWith("progress:"));
		expect(progressEvents).toEqual(["progress:after"]);
		expect(events.at(-1)).toContain("completion:");
		expect(events.at(-1)).toContain("beforeafter");
		await manager.dispose();
	}, 10_000);

	test("never surfaces a sink-queued pre-promotion chunk as progress", async () => {
		// The exact wiring bash uses for auto-promotion: a mirror-mode sink
		// stamps each chunk with the sampler epoch at entry, and the sampler
		// drops stale-stamped chunks. The first chunk's delivery is still
		// queued behind the sink's artifact flush when the promotion boundary
		// resets the sampler, so without the stamp it would replay
		// inline-shown output as the first background progress event.
		const reported: string[] = [];
		const sampler = new ProgressLines(line => reported.push(line.text));
		const sink = new OutputSink({
			artifactWriteMode: "mirror",
			chunkStamp: () => sampler.epoch,
			onChunk: (chunk, stamp) => sampler.append(chunk, stamp),
		});

		sink.push("inline-shown\n");
		// Promotion boundary: reset the sampler while the chunk above is still
		// in the sink's delivery queue.
		sampler.reset();
		sink.push("post-promotion\n");
		await sink.dump();
		sampler.finish();

		expect(reported).toEqual(["post-promotion"]);
	});

	test("drains a throttle-held chunk into the preview without replaying it after promotion", async () => {
		using tempDir = TempDir.createSync("@omp-bash-throttled-promotion-");
		const gatePath = path.join(tempDir.path(), "emit-held");
		const heldEnteredSink = Promise.withResolvers<void>();
		const releasePath = path.join(tempDir.path(), "emit-post");
		const manager = new AsyncJobManager({});
		const events: string[] = [];
		manager.registerProgressSink("Main", {
			deliver: (_jobId, text) => {
				events.push(`progress:${text}`);
			},
		});
		manager.registerDeliverySink("Main", (_jobId, text) => {
			events.push(`completion:${text}`);
		});
		const tool = new BashTool(makeSession(manager, { "bash.asyncAuto.inlineGraceMs": 60_000 }));
		const steering = new AbortController();
		const originalPush = OutputSink.prototype.push;
		vi.spyOn(OutputSink.prototype, "push").mockImplementation(function (this: OutputSink, chunk: string) {
			const syntheticNow = chunk.includes("inline-first")
				? 1_000
				: chunk.includes("throttle-held")
					? 1_001
					: undefined;
			if (syntheticNow === undefined) {
				originalPush.call(this, chunk);
				return;
			}
			const nowSpy = vi.spyOn(Date, "now").mockReturnValue(syntheticNow);
			try {
				originalPush.call(this, chunk);
			} finally {
				nowSpy.mockRestore();
			}
			if (chunk.includes("throttle-held")) heldEnteredSink.resolve();
		});
		let openedGate = false;
		const execution = tool.execute(
			"throttled-auto-promote",
			{
				command:
					"printf 'inline-first\\n'; " +
					'while [ ! -f "$GATE" ]; do sleep 0.01; done; ' +
					"printf 'throttle-held\\n'; " +
					'while [ ! -f "$RELEASE" ]; do sleep 0.01; done; ' +
					"printf 'post-promotion\\n'",
				env: { GATE: gatePath, RELEASE: releasePath },
				async: "auto",
				progress: "wake",
			},
			undefined,
			async update => {
				const text = update.content.find(block => block.type === "text")?.text ?? "";
				if (!openedGate && text.includes("inline-first")) {
					openedGate = true;
					await Bun.write(gatePath, "");
				}
			},
			{
				toolCall: {
					batchId: "throttled-promotion",
					index: 0,
					total: 1,
					toolCalls: [{ id: "throttled-auto-promote", name: "bash" }],
					steeringSignal: steering.signal,
				},
			} as AgentToolContext,
		);

		// Observe the second chunk at OutputSink.push(), before its deterministic
		// 50 ms throttle expires. Promotion must wait for that pre-boundary chunk
		// to reach onChunk and enter the inline preview.
		await heldEnteredSink.promise;
		steering.abort();

		const result = await execution;
		await Bun.write(releasePath, "");
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(result.details?.async?.state).toBe("running");
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("inline-first") }),
		);
		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "text", text: expect.stringContaining("throttle-held") }),
		);

		expect(events.filter(event => event.startsWith("progress:"))).toEqual(["progress:post-promotion"]);
		expect(events.at(-1)).toContain("completion:");
		expect(events.at(-1)).toContain("inline-first");
		expect(events.at(-1)).toContain("throttle-held");
		expect(events.at(-1)).toContain("post-promotion");
		await manager.dispose();
	}, 10_000);

	test("retains successful and failed exit values for completion delivery", async () => {
		const manager = new AsyncJobManager({});
		const completedJobs: AsyncJob[] = [];
		manager.registerDeliverySink("Main", (_jobId, _text, completedJob) => {
			if (completedJob) completedJobs.push(completedJob);
		});
		const tool = new BashTool(makeSession(manager));

		await tool.execute("exit-zero", { command: "exit 0", async: true });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });
		await tool.execute("exit-seven", { command: "exit 7", async: true });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });
		await tool.execute("timeout-job", { command: "sleep 5", async: true, timeout: 1 });
		await manager.waitForAll();
		await manager.drainDeliveries({ timeoutMs: 10 });

		expect(completedJobs.map(job => job.status)).toEqual(["completed", "failed", "failed"]);
		expect(completedJobs.map(job => job.latestDetails?.exitCode)).toEqual([0, 7, undefined]);
		expect(completedJobs.map(job => job.latestDetails?.timedOut === true)).toEqual([false, false, true]);
		await manager.dispose();
	});
});
