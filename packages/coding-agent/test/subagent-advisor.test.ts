/**
 * Per-agent settings migrations, advisor defaults for spawned sessions, and
 * discovery of nested per-subagent `__advisor.jsonl` transcripts.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { registerPersistedSubagents } from "@oh-my-pi/pi-coding-agent/registry/persisted-agents";
import { CURRENT_SESSION_VERSION } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";

describe("per-agent settings migrations", () => {
	let agentDir = "";
	afterEach(() => {
		if (agentDir) fs.rmSync(agentDir, { recursive: true, force: true });
	});

	const load = async (configYml: string): Promise<Settings> => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-advisor-migration-"));
		fs.writeFileSync(path.join(agentDir, "config.yml"), configYml);
		return await Settings.loadReadOnly({ agentDir, cwd: agentDir });
	};

	it("migrates nested advisor.subagents=true to task.agentAdvisor task=on", async () => {
		const settings = await load("advisor:\n  subagents: true\n");
		expect(settings.get("task.agentAdvisor")).toEqual({ task: "on" });
	});

	it("migrates flat advisor.subagents=true", async () => {
		const settings = await load('"advisor.subagents": true\n');
		expect(settings.get("task.agentAdvisor")).toEqual({ task: "on" });
	});

	it("migrates advisor.subagents=false to task=off so a lower layer keeps overriding", async () => {
		// Migration runs per config file: a project-level `false` must survive as
		// an explicit "off" or a migrated global `true` would win the merge.
		const settings = await load("advisor:\n  subagents: false\n");
		expect(settings.get("task.agentAdvisor")).toEqual({ task: "off" });
	});

	it("keeps an explicit task.agentAdvisor entry over the legacy toggle", async () => {
		const settings = await load('advisor:\n  subagents: true\ntask:\n  agentAdvisor:\n    task: "off"\n');
		expect(settings.get("task.agentAdvisor")).toEqual({ task: "off" });
	});

	it("normalizes boolean per-agent prewalk and advisor overrides", async () => {
		const settings = await load(
			"task:\n  agentPrewalk:\n    librarian: true\n    task: false\n  agentAdvisor:\n    librarian: false\n    task: true\n",
		);
		expect(settings.get("task.agentPrewalk")).toEqual({ librarian: "on", task: "off" });
		expect(settings.get("task.agentAdvisor")).toEqual({ librarian: "off", task: "on" });
	});
});

describe("createSubagentSettings advisor default", () => {
	it("forces the advisor off for subagents even when the parent has it enabled", () => {
		const parent = Settings.isolated({ "advisor.enabled": true });
		expect(createSubagentSettings(parent).get("advisor.enabled")).toBe(false);
	});

	it("lets a per-agent opt-in re-enable the advisor with its own advisor model role", () => {
		const parent = Settings.isolated({ "advisor.enabled": false, modelRoles: { smol: "openai/gpt-5-mini" } });
		const child = createSubagentSettings(parent, {
			"advisor.enabled": true,
			modelRoles: { ...parent.getModelRoles(), advisor: "moonshot/k3" },
		});
		expect(child.get("advisor.enabled")).toBe(true);
		expect(child.getModelRole("advisor")).toBe("moonshot/k3");
		// Other roles from the parent snapshot survive the advisor override.
		expect(child.getModelRole("smol")).toBe("openai/gpt-5-mini");
	});
});

/** Minimal current-version session JSONL: header + one user/assistant exchange. */
function sessionFixtureJsonl(id: string): string {
	const timestamp = new Date().toISOString();
	const header = { type: "session", version: CURRENT_SESSION_VERSION, id, timestamp, cwd: "/tmp" };
	const userEntry = {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp,
		message: { role: "user", content: "hello", timestamp: 1 },
	};
	const assistantEntry = {
		type: "message",
		id: "m2",
		parentId: "m1",
		timestamp,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test-model",
			usage: {},
			stopReason: "stop",
			timestamp: 2,
		},
	};
	return `${JSON.stringify(header)}\n${JSON.stringify(userEntry)}\n${JSON.stringify(assistantEntry)}\n`;
}

describe("subagent advisor transcript discovery", () => {
	it("registers nested per-subagent __advisor.jsonl transcripts under their owning subagent", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-subagent-advisor-"));
		try {
			// Main session advisor: <session>/__advisor.jsonl. Subagent advisor:
			// one level deeper, <session>/<SubId>/__advisor.jsonl — the recorder
			// derives the directory from the subagent's own session file.
			fs.writeFileSync(path.join(dir, "main.jsonl"), sessionFixtureJsonl("main"));
			fs.mkdirSync(path.join(dir, "main", "Sub1"), { recursive: true });
			fs.writeFileSync(path.join(dir, "main", "__advisor.jsonl"), sessionFixtureJsonl("main-advisor"));
			fs.writeFileSync(path.join(dir, "main", "Sub1.jsonl"), sessionFixtureJsonl("sub1"));
			fs.writeFileSync(path.join(dir, "main", "Sub1", "__advisor.jsonl"), sessionFixtureJsonl("sub1-advisor"));

			const registry = new AgentRegistry();
			await registerPersistedSubagents(registry, path.join(dir, "main.jsonl"));

			expect(registry.get("Sub1")?.kind).toBe("sub");
			const mainAdvisor = registry.get(`${MAIN_AGENT_ID}/advisor`);
			expect(mainAdvisor?.kind).toBe("advisor");
			expect(mainAdvisor?.parentId).toBe(MAIN_AGENT_ID);
			const subAdvisor = registry.get("Sub1/advisor");
			expect(subAdvisor?.kind).toBe("advisor");
			expect(subAdvisor?.parentId).toBe("Sub1");
			expect(subAdvisor?.sessionFile).toBe(path.join(dir, "main", "Sub1", "__advisor.jsonl"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
