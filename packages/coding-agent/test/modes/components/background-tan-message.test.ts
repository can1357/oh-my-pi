import { beforeAll, describe, expect, it } from "bun:test";
import { createBackgroundTanDispatchBlock } from "@oh-my-pi/pi-coding-agent/modes/components/background-tan-message";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";

function dispatchMessage(details: { jobId: string; work: string; sessionFile: string }): CustomMessage<unknown> {
	return {
		role: "custom",
		customType: BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
		// The persisted content is the full system-notice the model reads; the
		// renderer must NOT surface it in the transcript.
		content: '<system-notice reason="background_task_dispatched">raw block</system-notice>',
		display: true,
		details,
		attribution: "user",
		timestamp: Date.now(),
	} as CustomMessage<unknown>;
}

describe("createBackgroundTanDispatchBlock", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders one compact line with the job id and work preview, not the raw notice", () => {
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-42", work: "investigate the cache reuse path", sessionFile: "/x/Tan-1.jsonl" }),
		);

		const lines = block.render(120).filter(line => line.trim().length > 0);

		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("job-42");
		expect(lines[0]).toContain("investigate the cache reuse path");
		expect(lines[0]).not.toContain("system-notice");
	});

	it("truncates an overlong work preview so the line stays a single pill", () => {
		const block = createBackgroundTanDispatchBlock(
			dispatchMessage({ jobId: "job-7", work: "x".repeat(200), sessionFile: "/x/Tan-2.jsonl" }),
		);

		const line = block.render(120).find(rendered => rendered.includes("job-7")) ?? "";

		expect(line).toContain("…");
		expect(line).not.toContain("x".repeat(80));
	});
});
