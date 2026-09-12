import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AppleSpeechClient } from "@oh-my-pi/pi-coding-agent/stt/apple-speech-client";
import { isAppleSpeechSdkVersionSupported } from "@oh-my-pi/pi-coding-agent/stt/apple-speech-compiler";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const FAKE_SIDECAR = `#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const command = process.argv[2];
const locale = process.argv[3] ?? "auto";
const emit = value => process.stdout.write(JSON.stringify(value) + "\\n");
if (command === "prepare" && locale.startsWith("wait:")) {
  const marker = locale.slice("wait:".length);
  writeFileSync(marker, "started");
  process.on("SIGTERM", () => {
    writeFileSync(marker + ".terminated", "terminated");
    process.exit(0);
  });
  await Promise.withResolvers().promise;
  process.exit(2);
}
if (command === "status" || command === "prepare") {
  emit({
    success: true,
    available: true,
    supported: true,
    installed: command === "prepare",
    locale,
    display_name: "Fake SpeechAnalyzer",
    system_managed: true,
  });
  process.exit(0);
}
if (command !== "stream") process.exit(64);
emit({ type: "ready", locale });
if (locale.startsWith("exit:")) {
  writeFileSync(locale.slice("exit:".length), "exiting");
  process.stderr.write("fake sidecar stopped early\\n");
  process.exit(7);
}
if (locale.startsWith("late-fail:")) {
  writeFileSync(locale.slice("late-fail:".length), "exiting");
  process.stdout.end();
  // Real-delay exception: the client only exposes its 25 ms drain grace
  // internally, so the fake must outlive it on the platform clock to prove a
  // late process failure still rejects instead of succeeding as partial text.
  await Bun.sleep(100);
  process.stderr.write("fake sidecar failed late\\n");
  process.exit(9);
}
const chunks = [];
for await (const chunk of Bun.stdin.stream()) chunks.push(Buffer.from(chunk));
const audio = Buffer.concat(chunks);
if (audio.byteLength !== 16 || audio.readFloatLE(0) !== 0.25 || audio.readFloatLE(4) !== -0.25) {
  emit({ type: "error", error: "raw Float32 audio mismatch" });
  process.exit(1);
}
emit({ type: "partial", text: "hello" });
emit({ type: "segment", text: "hello world", index: 0 });
emit({ type: "done", text: "hello world" });
`;

// Bounded poll (ts-no-test-timers exception): the marker file is created by an
// external sidecar process on the platform clock, so fake timers cannot drive
// it. The timeout bounds the wait instead of hanging on a missed fs event.
async function waitForFileCreation(file: string, timeoutMs = 10_000): Promise<void> {
	const start = Date.now();
	for (;;) {
		if (await Bun.file(file).exists()) return;
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${file}`);
		await Bun.sleep(25);
	}
}

describe("AppleSpeechClient sidecar protocol", () => {
	let directory = "";
	let executable = "";
	let client: AppleSpeechClient;

	beforeAll(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-apple-speech-test-"));
		executable = path.join(directory, "fake-speech-analyzer");
		await Bun.write(executable, FAKE_SIDECAR);
		await fs.chmod(executable, 0o755);
		client = new AppleSpeechClient(async () => executable);
	});

	afterAll(async () => {
		await removeWithRetries(directory);
	});

	it("round-trips status and system-managed locale preparation", async () => {
		const status = await client.status("zh-Hant");
		expect(status).toEqual({
			success: true,
			available: true,
			supported: true,
			installed: false,
			locale: "zh-Hant",
			displayName: "Fake SpeechAnalyzer",
			systemManaged: true,
		});

		const prepared = await client.prepare("zh-Hant");
		expect(prepared.installed).toBe(true);
		expect(prepared.locale).toBe("zh-Hant");
	});

	it("rejects and terminates locale preparation when aborted", async () => {
		const alreadyAborted = new AbortController();
		alreadyAborted.abort();
		const unresolvedClient = new AppleSpeechClient(async () => {
			throw new Error("resolver must not run");
		});
		await expect(unresolvedClient.prepare("en", alreadyAborted.signal)).rejects.toHaveProperty("name", "AbortError");

		const marker = path.join(directory, "prepare");
		const abort = new AbortController();
		const started = waitForFileCreation(marker);
		const preparing = client.prepare(`wait:${marker}`, abort.signal);
		await started;
		const terminated = waitForFileCreation(`${marker}.terminated`);
		abort.abort();

		await expect(preparing).rejects.toHaveProperty("name", "AbortError");
		await terminated;
	});

	it("waits for ready, sends raw mono Float32 audio, and forwards live results", async () => {
		const partials: string[] = [];
		const segments: Array<{ text: string; index: number }> = [];
		const stream = await client.startStream("en_GB", {
			onPartial: text => partials.push(text),
			onSegment: (text, index) => segments.push({ text, index }),
		});
		stream.pushAudio(Float32Array.of(0.25, -0.25, 1, -1));

		expect(await stream.stop()).toBe("hello world");
		expect(partials).toEqual(["hello"]);
		expect(segments).toEqual([{ text: "hello world", index: 0 }]);
	});

	it("rejects when the native stream exits before a final result", async () => {
		const marker = path.join(directory, "stream-exit");
		const exiting = waitForFileCreation(marker);
		const stream = await client.startStream(`exit:${marker}`);
		await exiting;
		await expect(stream.stop()).rejects.toThrow(/fake sidecar stopped early|exited before completing/);
	});

	it("rejects when the process fails after stdout closes", async () => {
		const marker = path.join(directory, "stream-late-fail");
		const exiting = waitForFileCreation(marker);
		const stream = await client.startStream(`late-fail:${marker}`);
		await exiting;
		await expect(stream.stop()).rejects.toThrow(/failed late|exited before completing/);
	});
});

describe("Apple speech SDK gating", () => {
	it("requires the macOS 26 SDK without rejecting newer SDKs", () => {
		expect(isAppleSpeechSdkVersionSupported("15.5")).toBe(false);
		expect(isAppleSpeechSdkVersionSupported("26.0")).toBe(true);
		expect(isAppleSpeechSdkVersionSupported("27.1")).toBe(true);
		expect(isAppleSpeechSdkVersionSupported("unknown")).toBe(false);
	});
});
