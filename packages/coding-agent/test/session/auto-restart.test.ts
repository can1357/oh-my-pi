import { describe, expect, it } from "bun:test";
import {
	AUTO_RESTART_COMMAND_ENV,
	AUTO_RESTART_SESSION_FILE_ENV,
	type AutoRestartableArgs,
	awaitAutoRestartExit,
	buildAutoRestartCommand,
	ExecutableUpdateMonitor,
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

	it("keeps the handoff parent alive until the replacement exits", async () => {
		let resolveExit!: (exitCode: number) => void;
		const exit = new Promise<number>(resolve => {
			resolveExit = resolve;
		});
		const waiting = awaitAutoRestartExit(exit);
		let settled = false;
		void waiting.then(() => {
			settled = true;
		});

		await Promise.resolve();
		expect(settled).toBe(false);

		resolveExit(17);
		expect(await waiting).toBe(17);
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
});
