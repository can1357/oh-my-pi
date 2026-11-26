/**
 * Contract: the Agent Hub opens a transcript viewer as a fullscreen overlay whose keys reach the
 * viewer — the draft editor holds focus when the agent takes messages, and a read-only advisor's
 * viewer still answers Esc and the scroll keys instead of trapping the user.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { fullscreenMenuView, transcriptFocus } from "../src/modes/controllers/selector-views";
import { type AgentKind, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createTestTerminal, type TestTerminal } from "@oh-my-pi/pi-tui/testing/terminal";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { AgentTranscriptViewer } from "../src/ui/overlays/panels/agent-transcript-viewer";
import { AgentTranscriptViewerModel } from "../src/ui/overlays/panels/agent-transcript-viewer-model";

interface Mounted {
	readonly term: TestTerminal;
	readonly model: AgentTranscriptViewerModel;
	readonly onClose: Mock<() => void>;
	readonly onHubClose: Mock<() => void>;
}

let mounted: Mounted | undefined;

function mount(kind: AgentKind): Mounted {
	const registry = new AgentRegistry();
	registry.register({
		id: "Main/agent",
		displayName: "agent",
		kind,
		parentId: "Main",
		session: null,
		status: "parked",
	});
	const onClose = vi.fn<() => void>();
	const onHubClose = vi.fn<() => void>();
	const model = new AgentTranscriptViewerModel({
		transcript: agentTranscriptSource,
		agentId: "Main/agent",
		registry,
		lifecycle: () => ({
			ensureLive: () => Promise.reject(new Error("not revived in this test")),
		}),
		terminalRows: () => 24,
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		onClose,
		onHubClose,
	});
	const term = createTestTerminal(
		() => ({ layer: fullscreenMenuView("agent-transcript", AgentTranscriptViewer({ model })) }),
		{ columns: 80, rows: 24, theme: currentTheme() },
	);
	const root = term.surface.layer()[0];
	if (!root) throw new Error("viewer did not mount");
	term.focus(transcriptFocus(root));
	term.render();
	mounted = { term, model, onClose, onHubClose };
	return mounted;
}

describe("Agent Hub transcript viewer focus", () => {
	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		mounted?.term.dispose();
		mounted?.model.dispose();
		mounted = undefined;
		resetSettingsForTest();
	});

	it("closes a read-only advisor viewer on Esc and hands the hub key back", () => {
		const { term, model, onClose, onHubClose } = mount("advisor");
		expect(model.sendable).toBe(false);

		term.press("escape");
		expect(onClose).toHaveBeenCalledTimes(1);

		term.press("ctrl+s");
		expect(onHubClose).toHaveBeenCalledTimes(1);
	});

	it("types into the draft of an agent that takes messages", () => {
		const { term, model, onClose } = mount("sub");
		expect(model.sendable).toBe(true);

		term.type("hi");
		expect(model.draft.text).toBe("hi");

		// Esc clears the draft before it closes the viewer.
		term.press("escape");
		expect(model.draft.text).toBe("");
		expect(onClose).not.toHaveBeenCalled();
	});
});
