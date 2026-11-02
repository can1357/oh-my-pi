import { afterEach, describe, expect, it, vi } from "bun:test";
import { type DownloadActivity, onDownloadActivity } from "@oh-my-pi/pi-coding-agent/downloads/activity";
import { ModelDownloadActivity } from "@oh-my-pi/pi-coding-agent/downloads/model-downloads";

function record(): { activities: DownloadActivity[]; stop: () => void } {
	const activities: DownloadActivity[] = [];
	const stop = onDownloadActivity(activity => activities.push(activity));
	return { activities, stop };
}

describe("ModelDownloadActivity", () => {
	let stop: (() => void) | undefined;
	afterEach(() => {
		stop?.();
		vi.restoreAllMocks();
	});

	it("never tracks a cached load that reads its files right away", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const recorder = record();
		stop = recorder.stop;
		const downloads = new ModelDownloadActivity(key => key);

		downloads.observe({ modelKey: "m", status: "initiate", name: "repo", file: "tokenizer.json" });
		downloads.observe({ modelKey: "m", status: "progress", file: "tokenizer.json", loaded: 10, total: 100 });
		downloads.observe({ modelKey: "m", status: "progress", file: "tokenizer.json", loaded: 100, total: 100 });
		// Session build after the burst is silent, however long it takes.
		now.mockReturnValue(5_000);
		downloads.observe({ modelKey: "m", status: "ready" });

		expect(recorder.activities).toEqual([]);
	});

	it("sums bytes across files once a download outlasts the cache-read window", () => {
		const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
		const recorder = record();
		stop = recorder.stop;
		const downloads = new ModelDownloadActivity(() => "LFM2.5 230M");

		downloads.observe({ modelKey: "m", status: "progress", file: "config.json", loaded: 50, total: 50 });
		now.mockReturnValue(2_000);
		downloads.observe({ modelKey: "m", status: "download", name: "repo", file: "onnx/model.onnx" });
		downloads.observe({ modelKey: "m", status: "progress", file: "onnx/model.onnx", loaded: 150, total: 950 });
		downloads.observe({ modelKey: "m", status: "ready" });

		expect(recorder.activities).toMatchObject([
			{ label: "LFM2.5 230M", detail: "model.onnx", loaded: 200, total: 1000, state: "running" },
			{ label: "LFM2.5 230M", state: "done" },
		]);
	});

	it("shows a runtime install immediately and fails the load with the client's reason", () => {
		vi.spyOn(Date, "now").mockReturnValue(1_000);
		const recorder = record();
		stop = recorder.stop;
		const downloads = new ModelDownloadActivity(() => "Kokoro-82M");

		downloads.observe({ modelKey: "m", status: "initiate", name: "kokoro-js@1.2.1" });
		downloads.observe({ modelKey: "m", status: "error" }, "bun install exited 1");

		expect(recorder.activities.at(0)?.detail).toBe("installing kokoro-js@1.2.1");
		expect(recorder.activities.at(-1)).toMatchObject({ state: "failed", error: "bun install exited 1" });
	});

	it("reports a first-use failure that precedes any progress once, and never after the model loaded", () => {
		const recorder = record();
		stop = recorder.stop;
		const downloads = new ModelDownloadActivity(() => "Whisper small");

		downloads.observe({ modelKey: "offline", status: "error" }, "TypeError: Unable to connect\n    at fetch");
		downloads.observe({ modelKey: "offline", status: "error" }, "TypeError: Unable to connect\n    at fetch");
		downloads.observe({ modelKey: "loaded", status: "ready" });
		downloads.observe({ modelKey: "loaded", status: "error" }, "decode failed");

		expect(recorder.activities.filter(activity => activity.state === "failed")).toEqual([
			expect.objectContaining({ error: "TypeError: Unable to connect" }),
		]);
	});
});
