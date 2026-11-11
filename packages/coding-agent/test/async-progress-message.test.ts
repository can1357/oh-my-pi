import { describe, expect, test } from "bun:test";
import type { AsyncJob } from "@oh-my-pi/pi-coding-agent/async";
import { PROGRESS_LIMITS } from "@oh-my-pi/pi-coding-agent/async/progress-limits";
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
	return { jobId, text, seq, job: job(jobId), elapsedMs: 5_000, epoch: 0, delivery: "ambient" };
}

function content(message: { content: unknown } | null): string {
	if (!message || typeof message.content !== "string") throw new Error("Expected text content");
	return message.content;
}

describe("async progress messages", () => {
	test("preserves every permitted event while batching updates by job", () => {
		const longEvent = "x".repeat(500);
		const message = buildAsyncProgressBatchMessage([
			entry("bg_1", "first", 1),
			entry("bg_1", `second\n${longEvent}`, 2),
			entry("bg_2", "important", 1),
		]);
		const jobs = message?.details?.jobs ?? [];

		expect(message?.customType).toBe(ASYNC_PROGRESS_MESSAGE_TYPE);
		expect(jobs).toHaveLength(2);
		expect(jobs[0]?.text).toBe(`first\nsecond\n${longEvent}`);
		expect(jobs[1]?.text).toBe("important");
		expect(content(message)).toContain(`<output>\nfirst\nsecond\n${longEvent}\n</output>`);
		expect(content(message)).toContain("<output>\nimportant\n</output>");
		expect(content(message)).toContain('<job-progress id="bg_1" type="bash" elapsed="5.0s">');
		expect(content(message)).toEndWith("</system-notice>");
	});

	test("retains the outer output around rate-limited progress events", () => {
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_chatty", "line 1\nline 2\nline 98\nline 99", 21),
				artifactId: "chatty-output",
				suppressedEvents: 9,
			},
		]);
		const xml = content(message);
		const suppressed = '<suppressed reason="rate-limit" events="9" full-output="artifact://chatty-output" />';

		expect(xml).toContain(
			`<output>\n<head>\nline 1\nline 2\n</head>\n${suppressed}\n<tail>\nline 98\nline 99\n</tail>\n</output>`,
		);
		expect(xml).not.toContain("<system-reminder>");
	});

	test("emits scheduled reminders even when only suppressed output remains", () => {
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_chatty", "", 62),
				artifactId: "chatty-output",
				suppressedEvents: 9,
				reminder: "chatty-monitor",
			},
		]);
		const xml = content(message);

		expect(xml).toContain(
			'<output>\n<suppressed reason="rate-limit" events="9" full-output="artifact://chatty-output" />\n</output>',
		);
		expect(xml).toContain("<system-reminder>");
		expect(xml).toEndWith("</system-reminder>");
	});

	test("bounds model output and points truncated progress at its stable artifact", () => {
		const middle = "middle-data\n".repeat(500);
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_4", `HEAD\n${middle}TAIL`),
				artifactId: "async-output-4",
			},
		]);

		expect(message?.details?.jobs[0]).toMatchObject({
			jobId: "bg_4",
			artifactId: "async-output-4",
			truncated: true,
		});
		const preview = message?.details?.jobs[0];
		expect(preview?.text).toBeUndefined();
		expect(preview?.head).toStartWith("HEAD");
		expect(preview?.tail).toEndWith("TAIL");
		expect(preview?.head).not.toContain("TAIL");
		expect(preview?.tail).not.toContain("HEAD");
		expect(Buffer.byteLength(`${preview?.head ?? ""}${preview?.tail ?? ""}`, "utf8")).toBeLessThanOrEqual(
			PROGRESS_LIMITS.PREVIEW_BYTES,
		);
		expect(content(message)).toContain("<output>\n<head>\nHEAD");
		expect(content(message)).toContain(
			'<suppressed reason="preview-limit" full-output="artifact://async-output-4" />',
		);
		expect(content(message)).toContain("TAIL\n</tail>\n</output>");
	});

	test("keeps a fitting source-truncated line verbatim behind a suppression marker", () => {
		const line = `${"H".repeat(250)}${"T".repeat(250)}`;
		const message = buildAsyncProgressBatchMessage([
			{
				...entry("bg_5", line),
				artifactId: "async-output-5",
				sourceTruncated: true,
			},
		]);

		expect(message?.details?.jobs[0]).toMatchObject({
			text: line,
			artifactId: "async-output-5",
			truncated: true,
		});
		expect(content(message)).toContain(
			`<suppressed reason="preview-limit" full-output="artifact://async-output-5" />\n${line}\n</output>`,
		);
		expect(content(message)).not.toContain("<head>");
	});

	test("advertises only available proc retunes for each progress source", () => {
		const chattyJob: AsyncProgressEntry = {
			...entry("bg_chatty", "", 62),
			artifactId: "chatty-output",
			suppressedEvents: 9,
			reminder: "chatty-monitor",
		};
		const chattyProcess: AsyncProgressEntry = {
			...entry("monitor-web", "still compiling", 62),
			job: undefined,
			source: { id: "daemon-web", type: "process", label: "web", startedAt: 0 },
			artifactId: "monitor-output",
			suppressedEvents: 4,
			reminder: "chatty-monitor",
		};

		const bashOnly = content(buildAsyncProgressBatchMessage([chattyJob], { procWrite: true }));
		expect(bashOnly).toContain("proc://<job-id>/progress");
		expect(bashOnly).not.toContain("proc://<name>/progress");

		const serviceOnly = content(buildAsyncProgressBatchMessage([chattyProcess], { procWrite: true }));
		expect(serviceOnly).toContain("proc://<name>/progress");
		expect(serviceOnly).not.toContain("proc://<job-id>/progress");

		const withoutWrite = content(buildAsyncProgressBatchMessage([chattyJob, chattyProcess]));
		expect(withoutWrite).not.toContain("proc://");
		expect(withoutWrite).toContain("<system-reminder>");
	});
});
