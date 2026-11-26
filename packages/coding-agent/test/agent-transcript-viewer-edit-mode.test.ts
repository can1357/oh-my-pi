/**
 * Contract: the Agent Hub transcript viewer parses a subagent's `edit` calls in the mode the
 * subagent's edit tool read them in (the parent's settings resolved for the model that wrote
 * each reply), so cards name their target files instead of `…`.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgEditModelVariants } from "@oh-my-pi/pi-coding-agent/edit/settings";
import { agentTranscriptSource } from "@oh-my-pi/pi-coding-agent/modes/agent-hub-runtime";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import "../src/ui/tools";
import { AgentTranscriptViewer } from "../src/ui/overlays/panels/agent-transcript-viewer";
import { AgentTranscriptViewerModel } from "../src/ui/overlays/panels/agent-transcript-viewer-model";
import { mountLayer } from "./helpers/layer-terminal";

const AGENT_ID = "Main/worker";
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function editReply(id: string, provider: string, model: string, input: string): object {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `${id}-call`, name: "edit", arguments: { input } }],
			api: "anthropic-messages",
			provider,
			model,
			stopReason: "toolUse",
			usage,
			timestamp: Date.now(),
		},
	};
}

describe("Agent hub transcript viewer edit cards", () => {
	let tmpDir: string;

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-viewer-edit-mode-"));
	});

	afterEach(() => {
		resetSettingsForTest();
		removeSyncWithRetries(tmpDir);
	});

	it("names each reply's edit target in the mode its model selects", () => {
		// Default `edit.mode` is hashline; the GPT reply's model variant writes sloppy envelopes.
		cfgEditModelVariants.set(settings, { "gpt-5": "sloppy" });
		const sessionFile = path.join(tmpDir, "session.jsonl");
		const entries = [
			{ type: "session", version: 3, id: AGENT_ID, timestamp: new Date().toISOString() },
			editReply("hl", "anthropic", "claude-sonnet-4-5", "[src/hashline-target.ts#A1B2]\nPUT 3\n+hello\n"),
			editReply("sl", "openai", "gpt-5.5", "*** Edit File: src/sloppy-target.ts\n*** Find\nold\n*** Replace\nnew\n"),
		];
		fs.writeFileSync(sessionFile, `${entries.map(entry => JSON.stringify(entry)).join("\n")}\n`);
		const agents = new AgentRegistry();
		agents.register({
			id: AGENT_ID,
			displayName: AGENT_ID,
			kind: "sub",
			parentId: "Main",
			session: null,
			sessionFile,
			status: "parked",
		});
		const model = new AgentTranscriptViewerModel({
			transcript: agentTranscriptSource,
			agentId: AGENT_ID,
			registry: agents,
			terminalRows: () => 40,
			expandKeys: ["ctrl+o"],
			hubKeys: ["ctrl+s"],
			onClose: () => {},
			onHubClose: () => {},
			settings,
		});
		const viewer = mountLayer(() => AgentTranscriptViewer({ model }), { columns: 120, rows: 40 });
		try {
			const heads = viewer
				.render(120)
				.map(row => Bun.stripANSI(row))
				.filter(row => row.includes("Edit:"));
			expect(heads).toEqual([
				expect.stringContaining("src/hashline-target.ts"),
				expect.stringContaining("src/sloppy-target.ts"),
			]);
		} finally {
			viewer.dispose();
			model.dispose();
		}
	});
});
