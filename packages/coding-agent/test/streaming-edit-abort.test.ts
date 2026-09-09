import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Agent, AgentEvent } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EditTool } from "@oh-my-pi/pi-coding-agent/edit";
import { StreamingEditGuard } from "@oh-my-pi/pi-coding-agent/session/stream-guards";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

function createGuard(
	streamingAbort: boolean,
	cwd = process.cwd(),
	settings = Settings.isolated({ "edit.streamingAbort": streamingAbort }),
): { guard: StreamingEditGuard; aborts: { count: number } } {
	const aborts = { count: 0 };
	const guard = new StreamingEditGuard({
		agent: {
			abort() {
				aborts.count++;
			},
		} as Agent,
		settings,
		sessionManager: { getCwd: () => cwd } as SessionManager,
		obfuscator: undefined,
		model: () => undefined,
		isDisposed: () => false,
		promptGeneration: () => 0,
		localProtocolOptions: () => ({}),
		emitNotice() {},
		schedulePostPromptTask() {},
		discardAssistantTurn() {},
	});
	return { guard, aborts };
}

function previewEvent(
	streaming: boolean,
	files: Array<{ path: string; error?: string }>,
	toolName = "edit",
): AgentEvent {
	return {
		type: "tool_stream_update",
		toolCallId: "call-edit-1",
		toolName,
		update: { generation: 1, streaming, files },
	};
}

describe("streaming edit abort", () => {
	test("aborts from a final preview emitted by EditTool.openArgStream", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "stream-preview-"));
		try {
			await Bun.write(path.join(cwd, "sample.txt"), "alpha\n");
			const settings = Settings.isolated({ "edit.mode": "patch", "edit.streamingAbort": true });
			const { guard, aborts } = createGuard(true, cwd, settings);
			const toolSession = {
				cwd,
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				enableLsp: false,
				settings,
				getArtifactsDir: () => null,
				getSessionId: () => null,
				getPlanModeState: () => undefined,
			} as unknown as ToolSession;
			const tool = new EditTool(toolSession, "patch");
			const args = { path: "sample.txt", edits: [{ diff: "@@\n-missing\n+replacement\n" }] };
			const finalPreview = Promise.withResolvers<void>();
			const stream = tool.openArgStream({
				toolCallId: "native-stream",
				toolName: "edit",
				emit: update => {
					guard.maybeAbort({
						type: "tool_stream_update",
						toolCallId: "native-stream",
						toolName: "edit",
						update,
					});
					if (update && typeof update === "object" && "streaming" in update && update.streaming === false) {
						finalPreview.resolve();
					}
				},
			});
			const encoded = JSON.stringify(args);
			for (let offset = 0; offset < encoded.length; offset += 7) stream.push(encoded.slice(offset, offset + 7));
			stream.end(args);
			await finalPreview.promise;

			expect(aborts.count).toBe(1);
			expect(guard.abortTriggered).toBe(true);
			stream.cancel();
		} finally {
			await removeWithRetries(cwd);
		}
	});

	test("aborts on an error from the native final preview", () => {
		const { guard, aborts } = createGuard(true);
		guard.maybeAbort(
			previewEvent(false, [
				{ path: "src/ok.ts" },
				{ path: "src/broken.ts", error: "Failed to find expected lines in src/broken.ts" },
			]),
		);
		expect(aborts.count).toBe(1);
		expect(guard.abortTriggered).toBe(true);
	});

	test("does not abort for transient streaming errors", () => {
		const { guard, aborts } = createGuard(true);
		guard.maybeAbort(previewEvent(true, [{ path: "src/broken.ts", error: "partial input" }]));
		expect(aborts.count).toBe(0);
		expect(guard.abortTriggered).toBe(false);
	});

	test("ignores non-edit updates and disabled streaming abort", () => {
		const enabled = createGuard(true);
		enabled.guard.maybeAbort(previewEvent(false, [{ path: "a.ts", error: "bad" }], "read"));
		expect(enabled.aborts.count).toBe(0);

		const disabled = createGuard(false);
		disabled.guard.maybeAbort(previewEvent(false, [{ path: "a.ts", error: "bad" }]));
		expect(disabled.aborts.count).toBe(0);
	});

	test("reset permits a later final preview to abort", () => {
		const { guard, aborts } = createGuard(true);
		const event = previewEvent(false, [{ path: "a.ts", error: "bad" }]);
		guard.maybeAbort(event);
		guard.reset();
		guard.maybeAbort(event);
		expect(aborts.count).toBe(2);
	});
});
