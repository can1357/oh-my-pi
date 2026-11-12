import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import * as runtimeIdentity from "@oh-my-pi/pi-coding-agent/session/runtime-identity";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Session startup stamps the source checkout's uncommitted-diff hash; these tests do not
// depend on it and reading it stalls on some checkouts, so skip it.
mock.module("@oh-my-pi/pi-coding-agent/session/runtime-identity", () => ({
	...runtimeIdentity,
	loadRuntimeIdentity: async () => {},
}));
const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");

// `AgentSession.refreshCustomTools` re-reads `.omp/tools/` and applies the difference to the
// live session: a tool file added, edited, or deleted mid-session shows up in the registry
// without restarting.
describe("custom tools hot reload", () => {
	let rootDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let cwd: string;
	let toolsDir: string;
	let lifecycleLog: string;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		rootDir = path.join(os.tmpdir(), `pi-tools-hot-reload-${Snowflake.next()}`);
		fs.mkdirSync(rootDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(rootDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(rootDir, "models.yml"));
	});

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(rootDir, "cwd-"));
		toolsDir = path.join(cwd, ".omp", "tools");
		fs.mkdirSync(toolsDir, { recursive: true });
		lifecycleLog = path.join(cwd, "lifecycle.log");
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(rootDir)) removeSyncWithRetries(rootDir);
	});

	let writes = 0;
	function writeToolFile(file: string, name: string, description: string): string {
		const filePath = path.join(toolsDir, file);
		const source = [
			'import * as fs from "node:fs";',
			"export default api => ({",
			`\tname: ${JSON.stringify(name)},`,
			`\tlabel: ${JSON.stringify(name)},`,
			`\tdescription: ${JSON.stringify(description)},`,
			"\tparameters: api.arktype({}),",
			"\tonSession(event) {",
			`\t\tfs.appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(`${name}:${description}:`)} + event.reason + "\\n");`,
			"\t},",
			"\tasync execute() {",
			`\t\treturn { content: [{ type: "text", text: ${JSON.stringify(description)} }] };`,
			"\t},",
			"});",
		].join("\n");
		fs.writeFileSync(filePath, source);
		// Same-size rewrites inside one mtime tick must still read as a change.
		const bumped = new Date(Date.now() + ++writes * 1000);
		fs.utimesSync(filePath, bumped, bumped);
		return filePath;
	}

	async function startSession(
		overrides: Record<string, unknown> = {},
		options: { discoverSkills?: boolean } = {},
	): Promise<{ session: AgentSession; notices: string[] }> {
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(rootDir, "agent"),
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "plan.enabled": false, ...overrides }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			...(options.discoverSkills ? {} : { skills: [] }),
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
		});
		sessions.push(session);
		const notices: string[] = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "notice") notices.push(event.message);
		});
		return { session, notices };
	}

	function readLifecycle(): string[] {
		return fs.existsSync(lifecycleLog) ? fs.readFileSync(lifecycleLog, "utf8").trim().split("\n") : [];
	}

	it("registers a tool file added mid-session", async () => {
		const { session, notices } = await startSession();
		expect(session.getAllToolNames()).not.toContain("hot_probe");

		writeToolFile("hot_probe.ts", "hot_probe", "first version");
		const summary = await session.refreshCustomTools();

		expect(summary).toMatchObject({ added: ["hot_probe"], replaced: [], removed: [], errors: [] });
		expect(session.getAllToolNames()).toContain("hot_probe");
		expect(session.getToolByName("hot_probe")?.description).toBe("first version");
		expect(notices).toContain("tools reloaded: +1 ~0 -0");
		expect(readLifecycle()).toEqual(["hot_probe:first version:start"]);
	});

	it("replaces a tool whose file was edited, shutting the old one down first", async () => {
		writeToolFile("hot_probe.ts", "hot_probe", "first version");
		const { session, notices } = await startSession();
		expect(session.getToolByName("hot_probe")?.description).toBe("first version");

		writeToolFile("hot_probe.ts", "hot_probe", "second version");
		const summary = await session.refreshCustomTools();

		expect(summary).toMatchObject({ added: [], replaced: ["hot_probe"], removed: [], errors: [] });
		expect(session.getToolByName("hot_probe")?.description).toBe("second version");
		expect(notices).toContain("tools reloaded: +0 ~1 -0");
		const log = readLifecycle();
		expect(log.indexOf("hot_probe:first version:shutdown")).toBeGreaterThanOrEqual(0);
		expect(log.indexOf("hot_probe:first version:shutdown")).toBeLessThan(
			log.indexOf("hot_probe:second version:start"),
		);
	});

	it("removes a tool whose file was deleted", async () => {
		const file = writeToolFile("hot_probe.ts", "hot_probe", "first version");
		const { session, notices } = await startSession();
		expect(session.getAllToolNames()).toContain("hot_probe");

		fs.rmSync(file);
		const summary = await session.refreshCustomTools();

		expect(summary).toMatchObject({ added: [], replaced: [], removed: ["hot_probe"], errors: [] });
		expect(session.getAllToolNames()).not.toContain("hot_probe");
		expect(session.getToolByName("hot_probe")).toBeUndefined();
		expect(notices).toContain("tools reloaded: +0 ~0 -1");
		expect(readLifecycle()).toContain("hot_probe:first version:shutdown");
	});

	it("reports a throwing module and still loads the others", async () => {
		const { session, notices } = await startSession();

		fs.writeFileSync(path.join(toolsDir, "broken.ts"), "throw new Error('broken at import');");
		writeToolFile("fine.ts", "fine_tool", "fine");
		const summary = await session.refreshCustomTools();

		expect(summary?.added).toEqual(["fine_tool"]);
		expect(summary?.errors).toHaveLength(1);
		expect(summary?.errors[0]?.error).toContain("broken at import");
		expect(session.getAllToolNames()).toContain("fine_tool");
		expect(notices.join("\n")).toContain("broken.ts: ");
	});

	it("picks up edits on its own with hotReload.tools on", async () => {
		writeToolFile("hot_probe.ts", "hot_probe", "first version");
		const { session, notices } = await startSession({ "hotReload.tools": true });
		expect(session.getToolByName("hot_probe")?.description).toBe("first version");

		// Let the watcher record its baseline before the edit lands.
		await Bun.sleep(100);
		writeToolFile("hot_probe.ts", "hot_probe", "edited while watching");
		const deadline = Date.now() + 10_000;
		while (
			(session.getToolByName("hot_probe")?.description !== "edited while watching" ||
				!notices.includes("tools reloaded: +0 ~1 -0")) &&
			Date.now() < deadline
		) {
			await Bun.sleep(100);
		}

		expect(session.getToolByName("hot_probe")?.description).toBe("edited while watching");
		expect(notices).toContain("tools reloaded: +0 ~1 -0");
	}, 20_000);

	it("reloads skills on its own with hotReload.skills on while hotReload.tools is off", async () => {
		const skillDir = path.join(cwd, ".omp", "skills", "hot-skill");
		fs.mkdirSync(skillDir, { recursive: true });
		const skillFile = path.join(skillDir, "SKILL.md");
		fs.writeFileSync(
			skillFile,
			["---", "name: hot-skill", "description: first skill description", "---", "Body v1"].join("\n"),
		);
		writeToolFile("hot_probe.ts", "hot_probe", "initial tool");
		const { session } = await startSession(
			{ "hotReload.tools": false, "hotReload.skills": true },
			{ discoverSkills: true },
		);
		expect(session.skills.find(s => s.name === "hot-skill")?.description).toBe("first skill description");

		await Bun.sleep(100);
		const bumped = new Date(Date.now() + 10_000);
		fs.writeFileSync(
			skillFile,
			["---", "name: hot-skill", "description: updated skill description", "---", "Body v2"].join("\n"),
		);
		fs.utimesSync(skillFile, bumped, bumped);
		writeToolFile("hot_probe.ts", "hot_probe", "edited while watching");

		const deadline = Date.now() + 10_000;
		while (
			session.skills.find(s => s.name === "hot-skill")?.description !== "updated skill description" &&
			Date.now() < deadline
		) {
			await Bun.sleep(100);
		}

		expect(session.skills.find(s => s.name === "hot-skill")?.description).toBe("updated skill description");
		expect(session.getToolByName("hot_probe")?.description).toBe("initial tool");
	}, 20_000);

	it("stays quiet when nothing changed", async () => {
		writeToolFile("hot_probe.ts", "hot_probe", "first version");
		const { session, notices } = await startSession();

		const summary = await session.refreshCustomTools();

		expect(summary).toMatchObject({ added: [], replaced: [], removed: [], errors: [] });
		expect(notices).toEqual([]);
	});
});
