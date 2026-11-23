import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type SandboxPolicy, SandboxProcess, sandboxDiscoverPaths, sandboxSupport } from "../native/index.js";

const support = sandboxSupport();
// Windows runtime coverage is the smoke probe; these fixtures are POSIX.
const posixUnsupported = !support.supported || process.platform === "win32";

// Mirrors the native lookup: absolute PATH entries, then the standard system directories.
const NETWORK_COMMANDS = [
	"unshare",
	"slirp4netns",
	"nsenter",
	"ip",
	"iptables",
	"ip6tables",
	"iptables-restore",
	"ip6tables-restore",
];
const SYSTEM_DIRECTORIES = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];

describe("sandboxSupport network diagnostics", () => {
	test("network fields are consistent with proxy", () => {
		expect(Array.isArray(support.networkMissing)).toBe(true);
		if (support.proxy) {
			expect(support.networkMissing).toEqual([]);
			expect(support.networkReason).toBeUndefined();
			return;
		}
		expect(typeof support.networkReason).toBe("string");
		expect(support.networkReason?.length).toBeGreaterThan(0);
		// MXC's network warnings live in networkReason, not in the generic warnings.
		for (const warning of support.warnings) {
			expect(support.networkReason).not.toContain(warning);
		}
	});

	test.skipIf(support.backend !== "bubblewrap" || support.proxy || process.platform === "win32")(
		"networkMissing is the set of network commands absent from PATH and the system directories",
		() => {
			const absolutePath = (process.env.PATH ?? "").split(path.delimiter).filter(dir => path.isAbsolute(dir));
			const search = [...absolutePath, ...SYSTEM_DIRECTORIES].join(path.delimiter);
			const expected = NETWORK_COMMANDS.filter(command => Bun.which(command, { PATH: search }) === null);
			expect([...support.networkMissing].sort()).toEqual(expected.sort());
		},
	);
});

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
	let env: Record<string, string>;
	const bunDir = path.dirname(process.execPath);

	beforeAll(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-sandbox-")));
		workspace = path.join(root, "workspace");
		await fs.mkdir(workspace);
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
		expect(exit.exitCode).not.toBe(0);
		child.kill();
	});

	// bwrap runs with --die-with-parent (PR_SET_PDEATHSIG, tied to the forking
	// thread). A spawning thread retired after Tokio's 10 s blocking-pool
	// keep-alive used to SIGKILL the whole sandbox.
	test("a contained process outlives the 10 s blocking-pool keep-alive", async () => {
		const result = await run(["/bin/sh", "-c", "sleep 12; echo survived"], policy());
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("survived\n");
	}, 30_000);

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
