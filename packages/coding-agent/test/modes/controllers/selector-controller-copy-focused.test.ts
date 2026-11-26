/**
 * The `/copy` picker lists the transcript on screen: a focused subagent's branch,
 * not the main session's.
 *
 * Failure mode if this regresses: picking a turn from a focused view copies text
 * from the main conversation the user is not looking at.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import * as clipboard from "@oh-my-pi/pi-coding-agent/utils/clipboard";
import { createRoot } from "@oh-my-pi/pi-tui";
import * as copySelectorModule from "../../../src/ui/overlays/pickers/copy-selector";

function sessionWithReply(reply: string) {
	const entries: SessionMessageEntry[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: "2024-01-01T00:00:00Z",
			message: { role: "user", content: "go", timestamp: 1 } as AgentMessage,
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: "2024-01-01T00:00:01Z",
			message: {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				stopReason: "stop",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				timestamp: 2,
			} as unknown as AgentMessage,
		},
	];
	return {
		sessionManager: { getBranch: () => entries, getCwd: () => "/tmp" },
		getToolByName: () => undefined,
		hasBuiltInTool: () => false,
		extensionRunner: undefined,
	};
}

describe("SelectorController.showCopySelector", () => {
	beforeEach(async () => {
		await Settings.init({ inMemory: true, cwd: process.cwd() });
	});
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("copies a turn picked from the focused subagent's transcript", async () => {
		const copySpy = spyOn(clipboard, "copyToClipboard").mockResolvedValue(undefined);
		let picker: copySelectorModule.CopySelectorProps | undefined;
		spyOn(copySelectorModule, "CopySelector").mockImplementation(props => {
			picker = props;
			return [];
		});
		const close = vi.fn();
		const main = sessionWithReply("main reply");
		const ctx = {
			shell: {
				focus: vi.fn(),
				nextFrame: async () => {},
				overlays: {
					show: vi.fn((factory: () => unknown) => {
						createRoot(factory);
						return { node: {}, closed: false, close };
					}),
				},
			},
			composer: { setNotice: vi.fn() },
			session: main,
			sessionManager: main.sessionManager,
			viewSession: sessionWithReply("worker reply"),
			showStatus: vi.fn(),
		} as unknown as InteractiveModeContext;

		await new SelectorController(ctx).showCopySelector();
		if (!picker) throw new Error("Expected the copy picker");
		const listed = JSON.stringify(picker.entries);
		expect(listed).toContain("worker reply");
		expect(listed).not.toContain("main reply");
		picker.onPick("worker reply", "reply", "turn" as never);

		expect(copySpy).toHaveBeenCalledWith("worker reply");
		expect(close).toHaveBeenCalledTimes(1);
	});
});
