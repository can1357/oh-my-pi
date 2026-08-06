import { describe, expect, it } from "bun:test";
import {
	AUTO_RESTART_COMMAND_ENV,
	AUTO_RESTART_SESSION_FILE_ENV,
	type AutoRestartableArgs,
	autoRestartHandoffEnv,
	buildAutoRestartCommand,
	consumeAutoRestartHandoff,
	ExecutableUpdateMonitor,
	handoffAutoRestart,
	prepareAutoRestartArgs,
} from "../../src/session/auto-restart";

describe("ExecutableUpdateMonitor", () => {
	it("restarts only after an executable change stays stable", async () => {
		const snapshots = ["old", "new", "new"];
		let index = 0;
		let restarts = 0;
		const monitor = new ExecutableUpdateMonitor({
			paths: ["/opt/omp"],
			isEnabled: () => true,
			snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
			onUpdate: () => {
				restarts++;
			},
		});

		await monitor.prime();
		await monitor.poll();
		expect(restarts).toBe(0);
		await monitor.poll();

		expect(restarts).toBe(1);
		expect(monitor.updatePending).toBe(true);
	});

	it("drops a transient fingerprint instead of restarting", async () => {
		const snapshots = ["old", "building", "old"];
		let index = 0;
		let restarts = 0;
		const monitor = new ExecutableUpdateMonitor({
			paths: ["/opt/omp"],
			isEnabled: () => true,
			snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
			onUpdate: () => {
				restarts++;
			},
		});

		await monitor.prime();
		await monitor.poll();
		await monitor.poll();

		expect(restarts).toBe(0);
		expect(monitor.updatePending).toBe(false);
	});

	it("waits for the setting to be enabled before establishing its baseline", async () => {
		let enabled = false;
		const snapshots = ["old", "new", "new"];
		let index = 0;
		let restarts = 0;
		const monitor = new ExecutableUpdateMonitor({
			paths: ["/opt/omp"],
			isEnabled: () => enabled,
			snapshot: async () => snapshots[Math.min(index++, snapshots.length - 1)],
			onUpdate: () => {
				restarts++;
			},
		});

		await monitor.prime();
		enabled = true;
		await monitor.poll();
		await monitor.poll();
		await monitor.poll();

		expect(restarts).toBe(1);
	});
});

describe("auto restart handoff", () => {
	it("uses the configured wrapper and preserves the original CLI arguments", () => {
		expect(
			buildAutoRestartCommand({
				argv: ["bun", "/app/src/cli.ts", "--model", "opus"],
				execPath: "/opt/homebrew/bin/bun",
				execArgv: ["--preload", "/app/preload.ts"],
				env: { [AUTO_RESTART_COMMAND_ENV]: "/app/scripts/omp" },
			}),
		).toEqual(["/app/scripts/omp", "--model", "opus"]);
	});

	it("relaunches a compiled executable without its virtual Bun entrypoint", () => {
		expect(
			buildAutoRestartCommand({
				argv: ["bun", "/$bunfs/root/cli.js", "--advisor"],
				execPath: "/opt/omp",
				execArgv: [],
				env: {},
			}),
		).toEqual(["/opt/omp", "--advisor"]);
	});

	it("does not quit the handoff parent before the replacement exits", async () => {
		let resolveChildExit!: (exitCode: number) => void;
		const childExit = new Promise<number>(resolve => {
			resolveChildExit = resolve;
		});
		let spawnCalls = 0;
		const quitCodes: number[] = [];

		const handoff = handoffAutoRestart(
			() => {
				spawnCalls++;
				return { exited: childExit };
			},
			async exitCode => {
				quitCodes.push(exitCode);
			},
		);

		expect(spawnCalls).toBe(1);
		await Promise.resolve();
		expect(quitCodes).toEqual([]);

		resolveChildExit(17);
		await handoff;
		expect(quitCodes).toEqual([17]);
	});

	it("forces the resumed session while preserving ordinary launch options", () => {
		const args: AutoRestartableArgs = {
			resume: undefined as string | true | undefined,
			continue: true,
			fork: "old-session",
			fromClaude: true,
			fromCodex: true,
			noSession: true,
			messages: ["do this again"],
			fileArgs: ["notes.md"],
		};

		prepareAutoRestartArgs(args, "/sessions/current.jsonl");

		expect(args).toEqual({
			resume: "/sessions/current.jsonl",
			continue: false,
			fork: undefined,
			fromClaude: false,
			fromCodex: false,
			noSession: false,
			messages: [],
			fileArgs: [],
		});
	});

	it("uses a dedicated environment key for the exact session file", () => {
		expect(AUTO_RESTART_SESSION_FILE_ENV).toBe("OMP_AUTO_RESTART_SESSION_FILE");
	});

	// The handoff token rides the environment, so every descendant of the
	// replacement inherits it: tool subprocesses, nested `omp` invocations, and
	// the long-lived worker daemon. Only the process the parent actually spawned
	// may act on it, otherwise an unrelated startup is hijacked into resuming a
	// stale session instead of honouring its own CLI arguments.
	it("accepts the handoff token only from the process that spawned this one", () => {
		const addressed: Record<string, string | undefined> = {
			PATH: "/usr/bin",
			...autoRestartHandoffEnv("/sessions/current.jsonl", 4242),
		};
		expect(consumeAutoRestartHandoff(addressed, 4242)).toBe("/sessions/current.jsonl");
		expect(addressed).toEqual({ PATH: "/usr/bin" });

		const inherited: Record<string, string | undefined> = {
			PATH: "/usr/bin",
			...autoRestartHandoffEnv("/sessions/current.jsonl", 4242),
		};
		expect(consumeAutoRestartHandoff(inherited, 5150)).toBeUndefined();
		expect(inherited).toEqual({ PATH: "/usr/bin" });
	});
});
