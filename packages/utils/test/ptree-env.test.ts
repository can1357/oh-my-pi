import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type ExecOptions, exec, spawnToolProcess } from "@oh-my-pi/pi-utils/ptree";
import type { Subprocess } from "bun";
import { BELOW_TOOL_SCORE, BELOW_TOOL_SCORE_TIMEOUT_MS, belowToolScore, spawnFailure } from "./helpers/tool-process";

const NAME = "OMP_PTREE_ENV_PROBE";

/** The timeout of a case that waits for the processes it starts: their runs, and the cleanup that ends them. */
const RUN_TIMEOUT_MS = 30_000;
/** How long a case's cleanup waits for the processes it ended to be reaped. */
const CLEANUP_MS = 5_000;

describe("ptree child environment", () => {
	afterEach(() => {
		delete Bun.env[NAME];
	});

	// omp loads `~/.env` and the agent `.env` into `Bun.env` after startup; Bun.spawn's
	// own default environment predates those writes, so `!command` config values
	// reading such a variable resolved to an empty credential.
	it(
		"inherits values written into Bun.env after startup",
		async () => {
			Bun.env[NAME] = "loaded-from-dotenv";
			const result = await exec([process.execPath, "-e", `process.stdout.write(process.env.${NAME} ?? "")`]);
			expect(result.stdout).toBe("loaded-from-dotenv");
		},
		RUN_TIMEOUT_MS,
	);
});

const SCORE = "/proc/self/oom_score_adj";

/** What `exec` of `command` throws, as the code and message a caller sees. */
async function execFailure(command: string[], options: ExecOptions): Promise<unknown> {
	return await exec(command, options).then(
		() => "started",
		(error: Error & { code?: string }) => ({ code: error.code, message: error.message }),
	);
}

/** The launcher of a tool process, as `Bun.spawn` gets it: this process's image. */
const LAUNCHER = `/proc/${process.pid}/exe`;

/** Kill and reap each of `children`, the processes a case started, waiting {@link CLEANUP_MS} at most. */
async function endAll(children: readonly Subprocess[]): Promise<void> {
	for (const child of children) {
		try {
			child.kill("SIGKILL");
		} catch {
			// It exited already.
		}
	}
	await Promise.race([Promise.all(children.map(child => child.exited)), Bun.sleep(CLEANUP_MS)]);
}

/**
 * Spy on `Bun.spawn`: each process it starts goes to `children` as it is started, and `replace` gives the argv it
 * starts in place of the one it gets.
 */
function recordSpawns(children: Subprocess[], replace: (cmd: string[]) => string[] = cmd => cmd) {
	const spawn = Bun.spawn.bind(Bun);
	return spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: object) => {
		const child = spawn(replace(cmd), options as never);
		children.push(child);
		return child;
	}) as unknown as typeof Bun.spawn);
}

describe.skipIf(process.platform !== "linux")("exec of a tool process", () => {
	// Failure mode: the program runs as a child of its launcher, which stays between it and this process (the pid a
	// caller signals, the exit it waits for), or its arguments reach it through a shell that splits or expands them.
	it(
		"runs the program in place of its launcher with literal arguments",
		async () => {
			const args = ["a b", "", '$HOME; "quoted"', "--"];
			const result = await exec(
				["/bin/sh", "-c", `printf '%s\\n' "$PPID" "\${BUN_BE_BUN-unset}" "$@"`, "sh", ...args],
				{ toolOomScore: true },
			);
			// Its parent is this process: the launcher became the program instead of starting it.
			expect(result.stdout).toBe([String(process.pid), Bun.env.BUN_BE_BUN ?? "unset", ...args, ""].join("\n"));
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: the program gets another environment than the caller's: one a shell imports (`dash` drops names
	// that are not shell identifiers, an exported Bash function, and resets `IFS` and `OPTIND`), one without the keys
	// a launcher kept for itself, or one with what the launcher's runtime loads from the working directory (`.env`).
	// A `bunfig.toml` there would run its preload in the launcher.
	it(
		"runs the program with the caller's environment exactly, whatever the working directory holds",
		async () => {
			using dir = TempDir.createSync("@omp-oom-env-");
			await Bun.write(dir.join(".env"), "OMP_FROM_DOTENV=loaded\n");
			const preloaded = dir.join("preloaded");
			await Bun.write(
				dir.join("preload.ts"),
				`require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "");\n`,
			);
			await Bun.write(dir.join("bunfig.toml"), 'preload = ["./preload.ts"]\n');
			const env = {
				"BASH_FUNC_f%%": "() { echo f; }",
				"a.b": "1",
				IFS: ":",
				OPTIND: "5",
				OMP_TOOL_EXEC_FAILED: "the caller's",
				OMP_TOOL_EXEC_BUN_BE_BUN: "the caller's too",
				BUN_BE_BUN: "0",
			};
			const result = await exec(["/usr/bin/env"], { env, cwd: dir.path(), toolOomScore: true });
			const expected = Object.entries(env).map(([name, value]) => `${name}=${value}`);
			expect(result.stdout.trimEnd().split("\n").sort()).toEqual(expected.sort());
			expect(await Bun.file(preloaded).exists()).toBe(false);
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: the launcher's runtime takes the program's environment as its own, so the code a
	// `BUN_INSPECT_PRELOAD` there names runs in the launcher, before the score is set or the program starts.
	it(
		"keeps the program's environment out of its launcher's runtime",
		async () => {
			using dir = TempDir.createSync("@omp-oom-preload-");
			const preloaded = dir.join("preloaded");
			const preload = dir.join("preload.js");
			await Bun.write(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloaded)}, "");\n`);
			const env = { PATH: Bun.env.PATH ?? "", BUN_INSPECT_PRELOAD: preload };
			const result = await exec(["/usr/bin/env"], { env, toolOomScore: true });
			expect(result.stdout.split("\n")).toContain(`BUN_INSPECT_PRELOAD=${preload}`);
			expect(await Bun.file(preloaded).exists()).toBe(false);
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: the program loses an environment key named `__proto__` (assigned into an object, it sets the
	// prototype), or starts with its own name as `argv[0]` where the caller gave `argv0`; a direct spawn keeps both.
	it(
		"gives the program the environment keys and argv0 a direct spawn gives it",
		async () => {
			const env: Record<string, string> = { PATH: Bun.env.PATH ?? "" };
			Object.defineProperty(env, "__proto__", {
				value: "own",
				enumerable: true,
				configurable: true,
				writable: true,
			});
			const command = ["/bin/sh", "-c", 'printf "%s\\n" "$0"; /usr/bin/env'];
			const lines = async (toolOomScore: boolean) =>
				(await exec(command, { env, argv0: "named0", toolOomScore })).stdout.split("\n").sort();
			const direct = await lines(false);
			expect(direct).toContain("__proto__=own");
			expect(direct).toContain("named0");
			expect(await lines(true)).toEqual(direct);
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: the program's descriptor of its launcher's payload or report reach it.
	it(
		"leaves the program no descriptor of its launcher",
		async () => {
			const result = await exec(
				["/bin/sh", "-c", 'for fd in 3 4; do [ -e "/proc/$$/fd/$fd" ] && echo "$fd"; done; :'],
				{ toolOomScore: true },
			);
			expect(result.stdout).toBe("");
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: a tool process, or what it starts, keeps this process's OOM adjustment, so the kernel, picking one
	// process to kill for lack of memory, may kill Oh My Pi in its place; or the spawn changes this process's value.
	const TOOL_SCORE = "sets 1000 in the tool and its child without changing the caller";
	it.skipIf(!BELOW_TOOL_SCORE)(
		TOOL_SCORE,
		async () => {
			await belowToolScore(import.meta.path, TOOL_SCORE, async before => {
				const result = await exec(["/bin/sh", "-c", `read -r score < ${SCORE}; echo "$score"; /bin/cat ${SCORE}`], {
					toolOomScore: true,
				});
				expect(await Bun.file(SCORE).text()).toBe(before);
				expect(result.stdout).toBe("1000\n1000\n");
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: as for `exec`, for `spawnToolProcess`; or the handle it returns is the launcher's, so a kill or a
	// wait reaches another process than the program.
	const SPAWN_SCORE = "spawns the tool itself with 1000 for spawnToolProcess";
	it.skipIf(!BELOW_TOOL_SCORE)(
		SPAWN_SCORE,
		async () => {
			await belowToolScore(import.meta.path, SPAWN_SCORE, async before => {
				const proc = await spawnToolProcess(["/bin/sh", "-c", `echo "$$"; /bin/cat ${SCORE}`], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
				expect(await Bun.file(SCORE).text()).toBe(before);
				expect(exitCode).toBe(0);
				// The handle is the program's: the launcher became it.
				expect(stdout).toBe(`${proc.pid}\n1000\n`);
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: a bare program name is looked up on this process's `PATH` instead of the child's, or in the
	// working directory through an empty one, so another program runs; or a missing one fails otherwise than its own
	// spawn does.
	const PATH_SCORE = "looks a bare program up on the child's PATH, and fails a missing one as its own spawn does";
	it.skipIf(!BELOW_TOOL_SCORE)(
		PATH_SCORE,
		async () => {
			await belowToolScore(import.meta.path, PATH_SCORE, async () => {
				using dir = TempDir.createSync("@omp-oom-path-");
				await fs.promises.writeFile(dir.join("omp-oom-tool"), `#!/bin/sh\n/bin/cat ${SCORE}\n`, { mode: 0o755 });
				const env = { PATH: dir.path() };
				const result = await exec(["omp-oom-tool"], { env, toolOomScore: true });
				expect(result.stdout).toBe("1000\n");
				const missing = ["omp-oom-missing-tool"];
				expect(await execFailure(missing, { env, toolOomScore: true })).toEqual(
					await execFailure(missing, { env }),
				);
				// An empty PATH: Bun's spawn does not search the working directory, so neither does the launcher.
				const empty = { env: { PATH: "" }, cwd: dir.path() };
				const tool = ["omp-oom-tool"];
				expect(await execFailure(tool, { ...empty, toolOomScore: true })).toEqual(await execFailure(tool, empty));
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: with an empty or missing PATH, a bare name that a direct spawn finds on the default path (`sh`)
	// is not found for the launcher, and runs directly, without the score.
	const DEFAULT_PATH_SCORE = "finds a bare name on the default path where a direct spawn does, and runs it as a tool";
	it.skipIf(!BELOW_TOOL_SCORE)(
		DEFAULT_PATH_SCORE,
		async () => {
			await belowToolScore(import.meta.path, DEFAULT_PATH_SCORE, async before => {
				const command = ["sh", "-c", `read -r score < ${SCORE}; echo "$score"`];
				for (const env of [{ PATH: "" }, {}]) {
					expect((await exec(command, { env })).stdout, JSON.stringify(env)).toBe(before);
					expect((await exec(command, { env, toolOomScore: true })).stdout, JSON.stringify(env)).toBe("1000\n");
				}
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: a program named `/proc/self/exe` (a runtime that runs itself again) runs another image than this
	// process's under the launcher, or fails to start there.
	const IMAGE_SCORE = "runs this process's image for /proc/self/exe";
	it.skipIf(!BELOW_TOOL_SCORE)(
		IMAGE_SCORE,
		async () => {
			await belowToolScore(import.meta.path, IMAGE_SCORE, async () => {
				const result = await exec(
					["/proc/self/exe", "-e", `process.stdout.write(require("node:fs").readFileSync("${SCORE}", "utf8"))`],
					{ toolOomScore: true },
				);
				expect(result.stdout).toBe("1000\n");
			});
		},
		BELOW_TOOL_SCORE_TIMEOUT_MS,
	);

	// Failure mode: a program that cannot start is reported as one that ran and exited 127, or runs as shell code.
	// The exec fails with the errno of the program's exec, the one its own spawn fails with.
	it(
		"fails a program that cannot exec with the error of its exec",
		async () => {
			using dir = TempDir.createSync("@omp-oom-exec-");
			// A script whose `#!` interpreter is missing; a file without `#!` that the kernel cannot load.
			for (const [name, body, code] of [
				["no-interpreter", "#!/nonexistent/interpreter\n", "ENOENT"],
				["no-shebang", "echo ran as shell code\n", "ENOEXEC"],
			]) {
				const script = dir.join(name);
				await fs.promises.writeFile(script, body, { mode: 0o755 });
				const failure = await exec([script], { toolOomScore: true }).then(
					() => "started",
					(error: NodeJS.ErrnoException) => ({
						code: error.code,
						errno: error.errno === undefined ? undefined : Math.abs(error.errno),
						names: error.message.includes(script),
					}),
				);
				expect(failure).toEqual({ ...spawnFailure(script), names: true });
				expect(failure).toMatchObject({ code });
			}
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: a program whose exec failed is spawned again, so it runs where it has become runnable since, and
	// runs twice where it starts both times. Here its interpreter appears once the launcher's exec failed and the
	// launcher ended: before anything after that exit could spawn it again.
	it(
		"never spawns a program whose exec failed again",
		async () => {
			using dir = TempDir.createSync("@omp-oom-once-");
			const interpreter = dir.join("interpreter");
			const ran = dir.join("ran");
			const script = dir.join("tool");
			await fs.promises.writeFile(script, `#!${interpreter}\n`, { mode: 0o755 });
			const children: Subprocess[] = [];
			const spawn = Bun.spawn.bind(Bun);
			const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: string[], options?: object) => {
				const child = spawn(cmd, options as never);
				children.push(child);
				// The first callback of its exit: it runs before the exec that waits on that exit goes on, and writes
				// synchronously so the interpreter is there before then.
				void child.exited.then(() =>
					fs.writeFileSync(interpreter, `#!/bin/sh\necho ran >> ${ran}\n`, { mode: 0o755 }),
				);
				return child;
			}) as unknown as typeof Bun.spawn);
			let failure: unknown;
			try {
				failure = await execFailure([script], { toolOomScore: true });
			} finally {
				spy.mockRestore();
				await endAll(children);
			}
			expect(failure).toMatchObject({ code: "ENOENT" });
			expect(children.length).toBe(1);
			expect(await Bun.file(ran).exists()).toBe(false);
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: a launcher report that cannot be read passes for the report of a launcher that ended before its
	// exec, and the program, which may have run, is started again.
	it(
		"never starts a program again whose launcher's report cannot be read, and ends its launcher",
		async () => {
			using dir = TempDir.createSync("@omp-oom-report-");
			const runs = dir.join("runs");
			const children: Subprocess[] = [];
			const spawns = recordSpawns(children);
			const file = Bun.file.bind(Bun);
			const files = spyOn(Bun, "file").mockImplementation(((target: unknown, options?: unknown) =>
				typeof target === "number"
					? {
							stream: () =>
								new ReadableStream({
									start(controller) {
										controller.error(new Error("broken report"));
									},
								}),
						}
					: file(target as string, options as never)) as unknown as typeof Bun.file);
			let failure: unknown;
			let ended: boolean[] = [];
			try {
				failure = await execFailure(["/bin/sh", "-c", `echo ran >> ${runs}`], { toolOomScore: true });
				ended = children.map(child => child.exitCode !== null || child.signalCode !== null);
			} finally {
				files.mockRestore();
				spawns.mockRestore();
				await endAll(children);
			}
			expect(failure).toMatchObject({ message: expect.stringContaining("broken report") });
			// One spawn, the launcher, ended before the exec returned.
			expect(ended).toEqual([true]);
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: a payload that cannot be removed fails the spawn, and strands its open descriptor. The program
	// runs itself instead, without the launcher, and the descriptor is closed.
	it(
		"runs the program itself, the payload's descriptor closed, where the payload cannot be removed",
		async () => {
			const made: string[] = [];
			const removal = spyOn(TempDir.prototype, "remove").mockImplementation(function (this: TempDir) {
				made.push(this.path());
				return Promise.reject(new Error("refused removal"));
			});
			const handles: FileHandle[] = [];
			const open = fs.promises.open.bind(fs.promises);
			const opened = spyOn(fs.promises, "open").mockImplementation((async (
				...args: Parameters<typeof fs.promises.open>
			) => {
				const handle = await open(...args);
				handles.push(handle);
				return handle;
			}) as typeof fs.promises.open);
			const children: Subprocess[] = [];
			const spawned: string[] = [];
			const spawns = recordSpawns(children, cmd => {
				spawned.push(cmd[0]);
				return cmd;
			});
			let stdout: string | undefined;
			try {
				stdout = (await exec(["/bin/sh", "-c", "echo out"], { toolOomScore: true })).stdout;
			} finally {
				spawns.mockRestore();
				opened.mockRestore();
				removal.mockRestore();
				for (const dir of made) await fs.promises.rm(dir, { recursive: true, force: true });
				await endAll(children);
			}
			expect(stdout).toBe("out\n");
			expect(made.length).toBe(1);
			// The payload's one handle, closed.
			expect(handles.map(handle => handle.fd)).toEqual([-1]);
			// The program's own spawn: no launcher.
			expect(spawned).toEqual(["/bin/sh"]);
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: a launcher that cannot start (no `/proc`, a runtime that cannot run there) fails the program's
	// spawn, or runs the program twice. The program then runs, once, without it.
	it(
		"runs the program itself where its launcher cannot start or run",
		async () => {
			using dir = TempDir.createSync("@omp-oom-fallback-");
			const runs = dir.join("runs");
			const command = ["/bin/sh", "-c", `echo ran >> ${runs}; echo out`];
			for (const [what, launcher] of [
				["no launcher image", [dir.join("no-such-exe")]],
				["a launcher that ends before its exec", ["/bin/sh", "-c", "exit 3"]],
			] as const) {
				await fs.promises.rm(runs, { force: true });
				const children: Subprocess[] = [];
				const spawned: string[] = [];
				const spawns = recordSpawns(children, cmd => {
					spawned.push(cmd[0]);
					return cmd[0] === LAUNCHER ? [...launcher] : cmd;
				});
				try {
					const result = await exec(command, { toolOomScore: true });
					expect(result.stdout, what).toBe("out\n");
				} finally {
					spawns.mockRestore();
					await endAll(children);
				}
				expect(spawned, what).toEqual([LAUNCHER, "/bin/sh"]);
				expect(await Bun.file(runs).text(), what).toBe("ran\n");
			}
		},
		RUN_TIMEOUT_MS,
	);

	// Failure mode: a program that starts and exits 127 is taken for one that could not start.
	it(
		"reports a program that exits 127 as one that ran",
		async () => {
			using dir = TempDir.createSync("@omp-oom-exit-");
			const script = dir.join("exits-127");
			await fs.promises.writeFile(script, "#!/bin/sh\necho ran >&2\nexit 127\n", { mode: 0o755 });
			const result = await exec([script], { toolOomScore: true, allowNonZero: true });
			expect([result.exitCode, result.stderr]).toEqual([127, "ran\n"]);
		},
		RUN_TIMEOUT_MS,
	);
});
