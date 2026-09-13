import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSpeculativeToolExecutionConfig } from "@oh-my-pi/pi-coding-agent/speculation/host";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map(directory => removeWithRetries(directory)));
});

function createSession(cwd: string, settings: Settings): ToolSession {
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
	};
}

// NOTE: `Settings.isolated` seeds the `overrides` layer, which shadows later
// `set` (global layer) in merge order. Keys under test are therefore left at
// schema defaults so `set` — the same layer the live settings UI writes —
// takes effect, matching production.
describe("createSpeculativeToolExecutionConfig", () => {
	it("reflects a mid-session enable without recreate", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-live-config-"));
		temporaryDirectories.push(directory);
		const settings = Settings.isolated({});
		const session = createSession(directory, settings);
		const config = createSpeculativeToolExecutionConfig(session.settings, session, {
			hasHandlers: () => false,
		});

		expect(config.enabled).toBe(false);

		settings.set("tools.speculativeExecution.enabled", true);

		expect(config.enabled).toBe(true);
	});

	it("propagates maxInFlight changes to the same config object", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-live-config-"));
		temporaryDirectories.push(directory);
		const settings = Settings.isolated({});
		const session = createSession(directory, settings);
		const config = createSpeculativeToolExecutionConfig(session.settings, session, {
			hasHandlers: () => false,
		});

		expect(config.maxInFlight).toBe(2);

		settings.set("tools.speculativeExecution.maxInFlight", 5);

		expect(config.maxInFlight).toBe(5);
	});

	it("keeps one host across toggles while authorization follows the live flag", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "speculative-live-config-"));
		temporaryDirectories.push(directory);
		await fs.writeFile(path.join(directory, "note.txt"), "content");
		const settings = Settings.isolated({
			"images.autoResize": false,
			"tools.approvalMode": "yolo",
		});
		const session = createSession(directory, settings);
		const tool = new ReadTool(session);
		const assessment = await tool.speculation.finalized?.assess({ args: { path: "note.txt" } });
		if (!assessment?.eligible) throw new Error("expected local read assessment to succeed");
		const config = createSpeculativeToolExecutionConfig(session.settings, session, {
			hasHandlers: () => false,
		});
		const context = {
			candidateId: "live-toggle-read",
			source: "direct" as const,
			dependencies: [],
			tool,
			toolCall: {
				type: "toolCall" as const,
				id: "live-toggle-read",
				name: "read",
				arguments: { path: "note.txt" },
			},
			args: { path: "note.txt" },
			effect: assessment.effect,
		};
		const host = config.host;

		expect(await host?.authorize(context)).toMatchObject({ allowed: false });

		settings.set("tools.speculativeExecution.enabled", true);

		expect(config.host).toBe(host);
		expect(await host?.authorize(context)).toMatchObject({ allowed: true });

		settings.set("tools.speculativeExecution.enabled", false);

		expect(config.host).toBe(host);
		expect(await host?.authorize(context)).toMatchObject({ allowed: false });
	});
});
