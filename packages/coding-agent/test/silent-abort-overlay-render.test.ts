/**
 * Regression: the agent-hub chat transcript must not render SILENT_ABORT_MARKER verbatim.
 *
 * Codex review flagged that the old observer overlay rendered `errorMessage`
 * without filtering the silent-abort sentinel; the hub chat view now renders
 * assistant messages through AssistantMessageComponent. This test exercises the
 * full chat-rebuild path through a real JSONL session file and an isolated
 * agent registry.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentTranscriptViewer } from "@oh-my-pi/pi-coding-agent/modes/components/agent-transcript-viewer";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { TUI } from "@oh-my-pi/pi-tui";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const SESSION_ID = "test-session-1";

function makeJsonlSessionFile(dirPath: string, entries: object[]): string {
	const filePath = path.join(dirPath, "session.jsonl");
	const lines = entries.map(e => JSON.stringify(e));
	fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf-8");
	return filePath;
}

function makeSubagentRegistry(sessions: ObservableSession[]) {
	return {
		getSessions: () => sessions,
		getSession: (id: string) => sessions.find(session => session.id === id),
		onChange: () => () => {},
		setMainSession: () => {},
		getActiveSubagentCount: () => sessions.filter(s => s.status === "active").length,
	} as unknown as import("@oh-my-pi/pi-coding-agent/modes/session-observer-registry").SessionObserverRegistry;
}

function makeViewer(sessionFile: string, observed: ObservableSession[]): AgentTranscriptViewer {
	const agents = new AgentRegistry();
	agents.register({
		id: SESSION_ID,
		displayName: SESSION_ID,
		kind: "sub",
		parentId: "Main",
		session: null,
		sessionFile,
		status: "parked",
	});
	const ui = { requestRender: () => {}, requestComponentRender: () => {} } as unknown as TUI;
	return new AgentTranscriptViewer({
		agentId: SESSION_ID,
		registry: agents,
		observers: makeSubagentRegistry(observed),
		ui,
		cwd: path.dirname(sessionFile),
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		requestRender: () => {},
		onClose: () => {},
		onHubClose: () => {},
	});
}

describe("Agent hub silent-abort regression", () => {
	let tmpDir: string;

	beforeAll(() => {
		initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-overlay-test-"));
	});

	afterEach(() => {
		resetSettingsForTest();
		removeSyncWithRetries(tmpDir);
	});

	it("renders no error line for silent-abort assistant messages with empty content", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-1",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-1",
				parentId: "msg-user-1",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "aborted",
					errorMessage: SILENT_ABORT_MARKER,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const viewer = makeViewer(sessionFile, [
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const rendered = viewer.render(120);
		viewer.dispose();
		const renderedText = rendered.join("\n");

		// The sentinel MUST NOT appear verbatim in any rendered line
		expect(renderedText).not.toContain(SILENT_ABORT_MARKER);
		// No error line at all for a silent abort
		expect(renderedText).not.toContain("Error:");
	});

	it("renders no error line for bit-classified silent aborts without marker text", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-bit",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-bit",
				parentId: "msg-user-bit",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "aborted",
					errorId: AIError.create(AIError.Flag.SilentAbort),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const viewer = makeViewer(sessionFile, [
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "active",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const rendered = viewer.render(120);
		viewer.dispose();
		expect(rendered.join("\n")).not.toContain("Error:");
	});

	it("renders normal error messages with an Error: line", () => {
		const sessionFile = makeJsonlSessionFile(tmpDir, [
			{ type: "session", version: 3, id: SESSION_ID, timestamp: new Date().toISOString() },
			{
				type: "message",
				id: "msg-user-2",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "hello", timestamp: Date.now() },
			},
			{
				type: "message",
				id: "msg-assistant-2",
				parentId: "msg-user-2",
				timestamp: new Date().toISOString(),
				message: {
					role: "assistant",
					content: [],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					stopReason: "error",
					errorMessage: "Connection timed out",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					timestamp: Date.now(),
				},
			},
		]);

		const viewer = makeViewer(sessionFile, [
			{
				id: SESSION_ID,
				kind: "subagent",
				label: "Test Subagent",
				status: "failed",
				sessionFile,
				lastUpdate: Date.now(),
			},
		]);

		const rendered = viewer.render(120);
		viewer.dispose();
		const renderedText = rendered.join("\n");

		// AssistantMessageComponent renders the error as "Error: <message>"
		expect(renderedText).toContain("Error: Connection timed out");
	});
});
