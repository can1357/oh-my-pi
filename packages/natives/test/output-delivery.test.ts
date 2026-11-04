import { afterEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { executeShell, PtySession, Shell } from "../native/index.js";

// A run must not resolve as if its output all arrived when the output
// callback failed. Needs this PR's Rust; PR CI loads the published natives leaf.
const skip = process.platform === "win32" || process.env.GITHUB_EVENT_NAME === "pull_request";

const spaced = "printf x; sleep 0.05; printf y; sleep 0.05; printf z; sleep 0.05; printf w";

let scratch: string | undefined;
afterEach(async () => {
	if (scratch) {
		await fs.rm(scratch, { recursive: true, force: true });
		scratch = undefined;
	}
});

describe.skipIf(skip)("output delivery", () => {
	it("fails a Shell.run whose output callback throws", async () => {
		const shell = new Shell();
		let out = "";
		const run = shell.run({ command: spaced }, (_error, chunk) => {
			out += chunk;
			throw new Error("callback failed");
		});
		await expect(run).rejects.toThrow("Command output was not all delivered: the output callback failed");
		expect(out).toBe("x");
	});

	it("fails an executeShell whose output callback throws", async () => {
		const run = executeShell({ command: spaced }, () => {
			throw new Error("callback failed");
		});
		await expect(run).rejects.toThrow("Command output was not all delivered: the output callback failed");
	});

	it("fails a terminal run whose output callback throws instead of reporting it cancelled", async () => {
		const session = new PtySession();
		const run = session.start(
			{ command: "printf a; sleep 0.1; printf b", shell: "/bin/sh", timeoutMs: 30_000 },
			() => {
				throw new Error("callback failed");
			},
		);
		await expect(run).rejects.toThrow("Command output was not all delivered: the output callback failed");
	});

	it("keeps failing a terminal run whose callback threw when a kill follows", async () => {
		scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pty-throw-kill-"));
		const marker = path.join(scratch, "term");
		const session = new PtySession();
		// The callback's failure stops the command first: its TERM trap writes
		// the marker, and only then does the kill arrive.
		let watch: ReturnType<typeof setInterval> | undefined;
		const killed = Promise.withResolvers<void>();
		const run = session.start(
			{
				command: `trap '' HUP; trap 'touch "${marker}"; while :; do sleep 0.05; done' TERM; printf READY; sleep 120`,
				shell: "/bin/sh",
				timeoutMs: 30_000,
			},
			() => {
				watch ??= setInterval(() => {
					if (existsSync(marker)) {
						clearInterval(watch);
						session.kill();
						killed.resolve();
					}
				}, 1);
				throw new Error("callback failed");
			},
		);
		try {
			await expect(run).rejects.toThrow("Command output was not all delivered: the output callback failed");
		} finally {
			clearInterval(watch);
		}
		await killed.promise;
	}, 20_000);

	it("delivers a partial character the terminal holds when a daemon keeps the terminal open", async () => {
		scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pty-partial-char-"));
		const pidFile = path.join(scratch, "daemon.pid");
		const session = new PtySession();
		let out = "";
		try {
			const result = await session.startArgv(
				{
					application: "/bin/sh",
					args: [
						"-c",
						`stty raw -echo; printf '\\342\\202'; (trap '' HUP; exec sleep 20) & echo $! > '${pidFile}'`,
					],
					timeoutMs: 30_000,
				},
				(_error, chunk) => {
					out += chunk;
				},
			);
			expect(result.exitCode).toBe(0);
			expect(out).toContain("\uFFFD");
		} finally {
			const pid = Number.parseInt(await Bun.file(pidFile).text(), 10);
			if (pid > 0) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {}
			}
		}
	});
});
