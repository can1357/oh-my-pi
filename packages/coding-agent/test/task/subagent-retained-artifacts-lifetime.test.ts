import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";

const HOST_PATH = path.resolve(import.meta.dir, "../fixtures/retained-artifacts-host.ts");
const REPO_ROOT = path.resolve(import.meta.dir, "../../../..");
const HOST_TIMEOUT_MS = 60_000;

const tmpRoots: string[] = [];

async function exists(target: string): Promise<boolean> {
	try {
		await fs.stat(target);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

/**
 * Run the host fixture until it reports its retained artifacts directory.
 * `end` decides how the process dies: by returning from main, or by the signal
 * the caller sends once the directory is known.
 */
async function runHost(mode: "exit" | "sigterm" | "no-retain" | "throw" | "abort"): Promise<{ artifactsDir: string }> {
	const tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-retained-artifacts-test-"));
	tmpRoots.push(tmpdir);
	const child = Bun.spawn([process.execPath, HOST_PATH, mode], {
		cwd: REPO_ROOT,
		env: { ...process.env, TMPDIR: tmpdir, NO_COLOR: "1" },
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
	const decoder = new TextDecoder();
	// Real timer, deliberately: this is a kill switch for a genuine child
	// process, not a wait for a condition. Without it a host that never prints
	// survives the test run; fake timers cannot reach another process's clock.
	const deadline = setTimeout(() => child.kill("SIGKILL"), HOST_TIMEOUT_MS);
	let buffered = "";
	try {
		while (!buffered.includes("\n")) {
			const { value, done } = await reader.read();
			if (done) break;
			buffered += decoder.decode(value, { stream: true });
		}
	} finally {
		clearTimeout(deadline);
		reader.releaseLock();
	}
	const line = buffered.split("\n").find(entry => entry.startsWith("ARTIFACTS "));
	if (!line) {
		const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
		child.kill("SIGKILL");
		throw new Error(`host fixture produced no artifacts directory:\n${stderr}`);
	}
	if (mode === "sigterm") child.kill("SIGTERM");
	await child.exited;
	return { artifactsDir: line.slice("ARTIFACTS ".length).trim() };
}

afterEach(async () => {
	for (const root of tmpRoots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe("retained subagent artifacts outlive the run, never the process", () => {
	it(
		"removes a retained temporary artifacts directory when its host exits normally",
		async () => {
			const { artifactsDir } = await runHost("exit");

			expect(path.basename(artifactsDir)).toStartWith("omp-eval-agent-");
			expect(await exists(artifactsDir)).toBe(false);
		},
		HOST_TIMEOUT_MS,
	);

	it(
		"removes a retained temporary artifacts directory when its host is terminated",
		async () => {
			const { artifactsDir } = await runHost("sigterm");

			expect(await exists(artifactsDir)).toBe(false);
		},
		HOST_TIMEOUT_MS,
	);

	for (const mode of ["no-retain", "throw", "abort"] as const) {
		it(
			`removes a ${mode} lease before the run returns`,
			async () => {
				// The host asserts the before-exit column; this process checks after exit.
				const { artifactsDir } = await runHost(mode);
				expect(await exists(artifactsDir)).toBe(false);
			},
			HOST_TIMEOUT_MS,
		);
	}
});
