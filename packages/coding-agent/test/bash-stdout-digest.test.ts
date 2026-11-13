import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { executeBashStdoutDigest } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const MAX_BYTES = 8192;

function sha256(bytes: Uint8Array): string {
	return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

describe("executeBashStdoutDigest", () => {
	let tempDir: string;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-stdout-digest-"));
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		resetSettingsForTest();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	const digest = (command: string, signal?: AbortSignal) =>
		executeBashStdoutDigest(command, { cwd: tempDir, timeout: 10_000, maxBytes: MAX_BYTES, signal });

	it("hashes raw stdout bytes, so distinct invalid UTF-8 outputs stay distinct", async () => {
		// Lossy UTF-8 decoding maps both bytes to U+FFFD; the raw digests must differ.
		fs.writeFileSync(path.join(tempDir, "ff.bin"), new Uint8Array([0xff]));
		fs.writeFileSync(path.join(tempDir, "fe.bin"), new Uint8Array([0xfe]));
		const ff = await digest("cat ff.bin");
		const fe = await digest("cat fe.bin");

		expect(ff.exitCode).toBe(0);
		expect(fe.exitCode).toBe(0);
		expect(ff.hash).toBe(sha256(new Uint8Array([0xff])));
		expect(fe.hash).toBe(sha256(new Uint8Array([0xfe])));
		expect(ff.hash).not.toBe(fe.hash);
	});

	it("discards stderr without reinterpreting the command", async () => {
		const result = await digest("printf out; printf err >&2");

		expect(result.exitCode).toBe(0);
		expect(result.overflow).toBe(false);
		expect(result.hash).toBe(sha256(new TextEncoder().encode("out")));
	});

	it("counts the byte ceiling in raw bytes, not decoded text", async () => {
		// 8192 invalid bytes decode to 8192 U+FFFD (24576 UTF-8 bytes); the
		// ceiling must still see exactly 8192.
		const atLimit = new Uint8Array(MAX_BYTES).fill(0xff);
		fs.writeFileSync(path.join(tempDir, "at-limit.bin"), atLimit);
		fs.writeFileSync(path.join(tempDir, "over-limit.bin"), new Uint8Array(MAX_BYTES + 1).fill(0xff));

		const within = await digest("cat at-limit.bin");
		expect(within.overflow).toBe(false);
		expect(within.exitCode).toBe(0);
		expect(within.hash).toBe(sha256(atLimit));

		const over = await digest("cat over-limit.bin");
		expect(over.overflow).toBe(true);
	});

	it.skipIf(process.platform === "win32")(
		"settles a cancelled run only after its process tree has terminated",
		async () => {
			const started = path.join(tempDir, "started");
			const cleaned = path.join(tempDir, "cleaned");
			// The TERM trap outlives the abort: it sleeps, then records cleanup.
			// A result that returned before native termination would resolve while
			// `cleaned` is still absent, letting a next check overlap this tree.
			const script = `trap 'sleep 0.3; : > ${shellQuote(cleaned)}; exit 0' TERM; : > ${shellQuote(started)}; while :; do sleep 0.05; done`;
			const controller = new AbortController();
			const run = digest(`sh -c ${shellQuote(script)}`, controller.signal);

			// A real child process signals readiness only through the filesystem.
			const deadline = Date.now() + 5_000;
			while (!fs.existsSync(started) && Date.now() < deadline) await Bun.sleep(10);
			expect(fs.existsSync(started)).toBe(true);

			controller.abort();
			const result = await run;

			expect(result.cancelled).toBe(true);
			expect(result.exitCode).toBeUndefined();
			expect(fs.existsSync(cleaned)).toBe(true);
		},
		15_000,
	);
});
