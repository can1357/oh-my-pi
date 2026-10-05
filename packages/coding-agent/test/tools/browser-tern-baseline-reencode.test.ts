import { afterEach, describe, expect, it } from "bun:test";
import { TernTab } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/tern-tab";
import { TernSocketClient } from "@oh-my-pi/pi-coding-agent/tools/browser/tern/wire";
import { type FakeAnswer, type FakeDaemon, startFakeDaemon } from "./tern-fake-daemon";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { encodePng } from "@oh-my-pi/pi-coding-agent/tools/browser/screenshot";
import { RunOutput } from "@oh-my-pi/pi-coding-agent/tools/browser/run-output";

/** A 1200x1100 noisy capture: large enough that the screenshot resize settings must re-encode it. */
function largeCapture(): Buffer {
	const width = 1200;
	const height = 1100;
	const pixels = new Uint8Array(width * height * 4);
	let seed = 987654321;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const index = (y * width + x) * 4;
			seed = (seed * 1103515245 + 12345) & 0x7fffffff;
			pixels[index] = Math.floor((x / width) * 255);
			pixels[index + 1] = Math.floor((y / height) * 255);
			pixels[index + 2] = seed % 256;
			pixels[index + 3] = 255;
		}
	}
	return encodePng({ width, height, pixels });
}

let daemon: FakeDaemon | undefined;
let client: TernSocketClient | undefined;

afterEach(async () => {
	client?.close();
	client = undefined;
	await daemon?.close();
	daemon = undefined;
});

/** A daemon whose `capture` op always answers with the same large PNG. */
async function startPage(capture: Buffer): Promise<FakeDaemon> {
	daemon = await startFakeDaemon((op): FakeAnswer => {
		switch (op.op) {
			case "open":
				return { ok: { block: 7, url: "about:blank" } };
			case "events":
				return { ok: { events: [], next: 0, dropped: 0 } };
			case "state":
				return {
					ok: { url: "https://example.test/", title: "Example", loading: false, width: 1200, height: 1100 },
				};
			case "eval":
				return { ok: {} };
			case "capture":
				return { ok: { data: capture.toString("base64") } };
			default:
				return { ok: {} };
		}
	});
	return daemon;
}

describe("TernTab baseline round trip", () => {
	it("saves a capture large enough to be re-encoded as a PNG diffScreenshot can read", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tern-baseline-cwd-"));
		const capture = largeCapture();
		const fake = await startPage(capture);
		client = new TernSocketClient({ socketPath: fake.socketPath });
		const tab = await TernTab.open(client, {
			name: "main",
			pane: 3,
			viewport: { width: 1200, height: 1100 },
			timeoutMs: 5_000,
			allowedDomains: ["example.test"],
		});
		// No browserScreenshotDir: this is the configuration where the saved bytes
		// take the resize/re-encode branch instead of the original capture.
		tab.setRunContext({
			session: { cwd },
			output: new RunOutput(),
			screenshots: [],
			signal: new AbortController().signal,
			timeoutMs: 5_000,
		});
		try {
			const baseline = await tab.screenshot({ path: "baseline.png", silent: true });
			if (typeof baseline !== "string")
				throw new Error(`Expected a destination path, got ${JSON.stringify(baseline)}`);
			expect(baseline).toBe(path.join(cwd, "baseline.png"));

			// The caller asked for a PNG and must get PNG bytes under that name.
			const written = await fs.readFile(baseline);
			expect([...written.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

			// The page did not change between the baseline and the diff, so the
			// comparison must succeed and report no change.
			const diff = await tab.diffScreenshot(baseline);
			expect(diff.pixelChangeRatio).toBe(0);
			expect(diff.changed).toBe(false);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	}, 120_000);
});
