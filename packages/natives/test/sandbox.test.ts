import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SandboxPolicy, SandboxProcess, sandboxDiscoverPaths, sandboxSupport } from "../native/index.js";

const support = sandboxSupport();
// Windows runtime coverage is the smoke probe; these fixtures are POSIX.
const posixUnsupported = !support.supported || process.platform === "win32";

interface Collected {
	stdout: string;
	stderr: string;
	exitCode: number | undefined;
}

interface Stream {
	chunks: Uint8Array[];
	eofs: number;
	done: Promise<void>;
	onChunk: (err: Error | null, chunk: Uint8Array) => void;
}

function stream(): Stream {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const state: Stream = {
		chunks: [],
		eofs: 0,
		done: promise,
		onChunk: (err, chunk) => {
			if (err) {
				reject(err);
				return;
			}
			if (chunk.length === 0) {
				state.eofs += 1;
				resolve();
				return;
			}
			state.chunks.push(chunk);
		},
	};
	return state;
}

const decode = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));

describe.skipIf(posixUnsupported)("SandboxProcess", () => {
	let root: string;
	let workspace: string;
	let outside: string;
	let env: Record<string, string>;
	const bunDir = path.dirname(process.execPath);

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sandbox-")));
		workspace = path.join(root, "workspace");
		outside = path.join(root, "outside");
		await fs.mkdir(workspace);
		await fs.mkdir(path.join(outside, "secret"), { recursive: true });
		await Bun.write(path.join(outside, "public.txt"), "public\n");
		await Bun.write(path.join(outside, "secret", "key.txt"), "secret\n");
		env = { PATH: "/usr/bin:/bin", HOME: workspace, TMPDIR: workspace, LANG: "C" };
	});

	afterAll(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function policy(overrides: Partial<SandboxPolicy> = {}): SandboxPolicy {
		return {
			readwritePaths: [workspace],
			readonlyPaths: [],
			deniedPaths: [],
			network: "deny",
			...overrides,
		};
	}

	async function run(
		argv: string[],
		sandboxPolicy: SandboxPolicy,
		options: { stdin?: string; env?: Record<string, string> } = {},
	): Promise<Collected> {
		const out = stream();
		const err = stream();
		const child = await SandboxProcess.spawn(
			{ argv, cwd: workspace, env: options.env ?? env, policy: sandboxPolicy },
			out.onChunk,
			err.onChunk,
		);
		expect(child.pid).toBeGreaterThan(0);
		if (options.stdin !== undefined) {
			await child.write(new TextEncoder().encode(options.stdin));
		}
		child.closeStdin();
		const [exit] = await Promise.all([child.wait(), out.done, err.done]);
		expect(out.eofs).toBe(1);
		expect(err.eofs).toBe(1);
		return { stdout: decode(out.chunks), stderr: decode(err.chunks), exitCode: exit.exitCode ?? undefined };
	}

	function connectArgv(port: number): string[] {
		const script = `console.log("connecting"); await Bun.connect({ hostname: "127.0.0.1", port: ${port}, socket: { data() {} } }); process.exit(0);`;
		return [process.execPath, "-e", script];
	}

	test("write inside a read-write root succeeds", async () => {
		const target = path.join(workspace, "inside.txt");
		const result = await run(["/bin/sh", "-c", 'printf ok > "$1"', "sh", target], policy());
		expect(result.exitCode).toBe(0);
		expect(await Bun.file(target).text()).toBe("ok");
	});

	test("write outside the read-write roots fails", async () => {
		const target = path.join(outside, "escape.txt");
		const result = await run(["/bin/sh", "-c", 'printf no > "$1"', "sh", target], policy());
		expect(result.exitCode).not.toBe(0);
		expect(await Bun.file(target).exists()).toBe(false);
	});

	test("denied path under a read-only root is unreadable", async () => {
		const sandboxPolicy = policy({ readonlyPaths: [outside], deniedPaths: [path.join(outside, "secret")] });
		const allowed = await run(["/bin/cat", path.join(outside, "public.txt")], sandboxPolicy);
		expect(allowed.exitCode).toBe(0);
		expect(allowed.stdout).toBe("public\n");
		const denied = await run(["/bin/cat", path.join(outside, "secret", "key.txt")], sandboxPolicy);
		expect(denied.exitCode).not.toBe(0);
		expect(denied.stdout).toBe("");
	});

	test("deny network fails a connect", async () => {
		const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		try {
			const result = await run(connectArgv(server.port), policy({ readonlyPaths: [bunDir] }));
			// The marker proves the child ran up to the connect attempt.
			expect(result.stdout).toBe("connecting\n");
			expect(result.exitCode).not.toBe(0);
		} finally {
			server.stop(true);
		}
	});

	// Bubblewrap runs every network mode in a private namespace: host loopback
	// is never reachable from it.
	test.skipIf(support.backend === "bubblewrap")("allow network permits a host-loopback connect", async () => {
		const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
		try {
			const result = await run(connectArgv(server.port), policy({ network: "allow", readonlyPaths: [bunDir] }));
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	test("stdin round-trips through the contained process", async () => {
		const result = await run(["/bin/cat"], policy(), { stdin: "hello\nsandbox\n" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello\nsandbox\n");
	});

	test("multi-chunk output arrives complete and in order", async () => {
		const result = await run(["/usr/bin/seq", "1", "200000"], policy());
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${Array.from({ length: 200_000 }, (_, i) => i + 1).join("\n")}\n`);
	});

	test("the child sees exactly the passed env and cwd", async () => {
		const marker = `a b'"$HOME\`x\`\\ü`;
		const result = await run(["/bin/sh", "-c", 'printf "%s|%s|" "$OMP_MARK" "${LOGNAME-unset}"; pwd -P'], policy(), {
			env: { ...env, OMP_MARK: marker },
		});
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(`${marker}|unset|${workspace}\n`);
	});

	test("kill ends a sleeping process tree and wait resolves", async () => {
		const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
		const out = stream();
		const forward = out.onChunk;
		out.onChunk = (error, chunk) => {
			forward(error, chunk);
			if (chunk.length > 0) markReady();
		};
		const err = stream();
		const child = await SandboxProcess.spawn(
			{ argv: ["/bin/sh", "-c", "sleep 60 & echo ready; sleep 60; wait"], cwd: workspace, env, policy: policy() },
			out.onChunk,
			err.onChunk,
		);
		await ready;
		child.kill();
		child.kill();
		const exit = await child.wait();
		await Promise.all([out.done, err.done]);
		expect(exit.timedOut).toBe(false);
		expect(exit.exitCode).not.toBe(0);
		child.kill();
	});

	test("argv with spaces, quotes and $ reaches the child byte-exact", async () => {
		const args = ["a b", "it's", '"double"', "$HOME", "`id`", "$(id)", "", "back\\slash", "ünï"];
		const result = await run(["/usr/bin/printf", "[%s]\\n", ...args], policy());
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe(args.map(arg => `[${arg}]\n`).join(""));
	});

	test("spawn rejects an invalid request", async () => {
		const noop = () => {};
		await expect(SandboxProcess.spawn({ argv: [], env, policy: policy() }, noop, noop)).rejects.toThrow(
			/argv must not be empty/,
		);
		await expect(
			SandboxProcess.spawn({ argv: ["/bin/true"], env, policy: policy({ network: "proxy" }) }, noop, noop),
		).rejects.toThrow(/proxyUrl/);
	});

	test("sandboxDiscoverPaths reads the passed env", async () => {
		const bin = path.join(root, "tools-bin");
		const tmp = path.join(root, "tools-tmp");
		await fs.mkdir(bin);
		await fs.mkdir(tmp);
		const discovered = sandboxDiscoverPaths({ PATH: bin, HOME: workspace, TMPDIR: tmp });
		expect(discovered.readonlyPaths).toEqual([bin]);
		expect(discovered.readwritePaths).toEqual([tmp]);
	});
});

test("sandboxSupport reports the host backend or a reason", () => {
	if (support.supported) {
		const expected: Record<string, typeof support.backend> = {
			darwin: "seatbelt",
			linux: "bubblewrap",
			win32: "processcontainer",
		};
		expect(support.backend).toBe(expected[process.platform]);
		expect(support.reason).toBeUndefined();
	} else {
		expect(support.reason).toBeString();
		expect(support.backend).toBeUndefined();
	}
});
