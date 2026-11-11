import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import {
	ASYNC_PROGRESS_MESSAGE_TYPE,
	type AsyncProgressEntry,
	buildAsyncProgressBatchMessage,
} from "@oh-my-pi/pi-coding-agent/session/async-job-delivery";

function job(id: string): AsyncJob {
	return {
		id,
		type: "bash",
		status: "running",
		startTime: 0,
		label: id,
		abortController: new AbortController(),
		promise: Promise.resolve(),
	};
}

function entry(jobId: string, text: string, seq = 1): AsyncProgressEntry {
	return {
		jobId,
		text,
		seq,
		job: job(jobId),
		elapsedMs: 5_000,
		epoch: 0,
		delivery: "ambient",
	};
}

function content(message: { content: unknown } | null): string {
	if (!message || typeof message.content !== "string") throw new Error("Expected text content");
	return message.content;
}

describe("async progress messages", () => {
	test("emits grouped progress as structured events without policy guidance", () => {
		const message = buildAsyncProgressBatchMessage([
			entry("bg_1", "first", 1),
			entry("bg_1", "second", 2),
			entry("bg_2", "important", 1),
		]);
		const jobs = message?.details?.jobs ?? [];
		const rendered = content(message);

		expect(message?.customType).toBe(ASYNC_PROGRESS_MESSAGE_TYPE);
		expect(jobs).toHaveLength(2);
		expect(jobs[0]?.text).toBe("first\nsecond");
		expect(rendered).toContain("<system-notice>");
		expect(rendered).toContain('<job-progress id="bg_1" type="bash" elapsed="5.0s">');
		expect(rendered).toContain("<output>\nfirst\nsecond\n</output>");
		expect(rendered).toContain('<job-progress id="bg_2" type="bash" elapsed="5.0s">');
		expect(rendered).toEndWith("</system-notice>");
		expect(rendered).not.toContain("Resume your work");
		expect(rendered).not.toContain("<system-reminder>");
	});
});
