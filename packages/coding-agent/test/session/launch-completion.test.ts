import { describe, expect, it } from "bun:test";
import type { DaemonCompletionNotification } from "../../src/launch/protocol";
import { buildLaunchCompletionBatchMessage } from "../../src/session/launch-completion";

function completion(exitReason: string): DaemonCompletionNotification {
	return {
		event: "daemon-completed",
		completionId: "completion-id",
		owner: "owner-session",
		daemon: {
			name: "watcher",
			id: "daemon-id",
			state: "failed",
			createdAt: 1,
			startedAt: 2,
			exitedAt: 3,
			exitCode: 58,
			exitReason,
			restartCount: 0,
			outputBytes: 0,
			persist: false,
			detached: false,
		},
	};
}

describe("launch completion messages", () => {
	it("includes the supervisor diagnostic in model-visible completion text", () => {
		const message = buildLaunchCompletionBatchMessage([
			completion("process exited with code 58 without a reported termination reason"),
		]);

		expect(message.content).toContain(
			"Supervised process watcher failed with exit code 58; reason: process exited with code 58 without a reported termination reason.",
		);
	});

	it("sanitizes control characters and line breaks in a runtime reason", () => {
		const message = buildLaunchCompletionBatchMessage([completion("\u001b[31mfirst\r\n\tsecond\u001b[0m")]);

		expect(message.content).toBe("Supervised process watcher failed with exit code 58; reason: first second.");
	});
});
