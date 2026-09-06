import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function makeTempDir(prefix: string): string {
	const dir = TempDir.createSync(prefix);
	tempDirs.push(dir);
	return dir.path();
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => dir.remove()));
});

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("subagent session_init approval provenance", () => {
	it("forces yolo mode while preserving the user's tools.approval map", () => {
		const base = Settings.isolated({
			"tools.approvalMode": "always-ask",
			"tools.approval": { bash: "prompt", eval: "prompt", read: "allow" },
		});

		const sub = createSubagentSettings(base);

		// The forced mode is the documented subagent contract; the per-tool policy
		// map must survive it untouched, which is exactly what reports like #10124
		// need to be able to confirm from a transcript.
		expect(sub.get("tools.approvalMode")).toBe("yolo");
		expect(sub.get("tools.approval")).toEqual({ bash: "prompt", eval: "prompt", read: "allow" });
	});

	it("persists approvalMode/approval/hasUI on the session_init entry", async () => {
		const cwd = makeTempDir("@pi-init-approval-");
		const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const base = Settings.isolated({
			"tools.approvalMode": "always-ask",
			"tools.approval": { eval: "prompt" },
		});
		const sub = createSubagentSettings(base);

		manager.appendSessionInit({
			systemPrompt: "sp",
			task: "write a file with eval",
			tools: ["read", "eval"],
			approvalMode: (sub.get("tools.approvalMode") ?? "yolo") as string,
			approval: sub.get("tools.approval") as Record<string, unknown> | undefined,
			// Subagents run headless: no TTY is attached, so the transcript has to
			// record that no prompt could have been surfaced to a human even when
			// the inherited policy map would otherwise have asked for one.
			hasUI: false,
		});
		// Flush buffered entries so the record is readable off disk.
		manager.appendMessage(assistantMessage("flush"));

		const raw = await Bun.file(sessionFile).text();
		const entries = raw
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as Record<string, unknown>);
		const init = entries.find(entry => entry.type === "session_init");
		if (!init) throw new Error("Expected a session_init entry");

		expect(init.approvalMode).toBe("yolo");
		expect(init.approval).toEqual({ eval: "prompt" });
		expect(init.hasUI).toBe(false);
	});
});
