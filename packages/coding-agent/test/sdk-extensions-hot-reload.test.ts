import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock, setDefaultTimeout } from "bun:test";
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
import type { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Session startup stamps the source checkout's uncommitted-diff hash; these tests do not
// depend on it and reading it stalls on some checkouts, so skip it.
mock.module("@oh-my-pi/pi-coding-agent/session/runtime-identity", () => ({
	...runtimeIdentity,
	loadRuntimeIdentity: async () => {},
}));
const { createAgentSession } = await import("@oh-my-pi/pi-coding-agent/sdk");

interface ExtensionOptions {
	/** Throws while the factory runs. */
	factoryThrows?: boolean;
	/** Throws from the `session_start` handler. */
	startThrows?: boolean;
	/** Registers a tool with this name. */
	tool?: string;
}

// Each test builds a full session and re-imports real modules; that outruns bun's 5 s default.
setDefaultTimeout(30_000);

// `AgentSession.refreshExtensions` re-reads the extension sources and applies the difference to
// the live session: an extension file added, edited, or deleted mid-session takes effect without
// restarting, and one that is malformed never disturbs the others.
describe("extensions hot reload", () => {
	let rootDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let cwd: string;
	let extensionsDir: string;
	let lifecycleLog: string;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		rootDir = path.join(os.tmpdir(), `pi-extensions-hot-reload-${Snowflake.next()}`);
		fs.mkdirSync(rootDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(rootDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(rootDir, "models.yml"));
	});

	beforeEach(() => {
		cwd = fs.mkdtempSync(path.join(rootDir, "cwd-"));
		extensionsDir = path.join(cwd, "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
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
	/** Writes an extension whose behavior is stamped with `tag`, so each version is told apart in the log. */
	function writeExtension(file: string, tag: string, options: ExtensionOptions = {}): string {
		const filePath = path.join(extensionsDir, file);
		const log = (line: string): string =>
			`fs.appendFileSync(${JSON.stringify(lifecycleLog)}, ${JSON.stringify(line)} + "\\n");`;
		const source = [
			'import * as fs from "node:fs";',
			"export default function (pi) {",
			`\t${log(`load:${tag}`)}`,
			options.factoryThrows ? `\tthrow new Error(${JSON.stringify(`factory failed ${tag}`)});` : "",
			'\tpi.on("session_start", async (_event, ctx) => {',
			options.startThrows ? `\t\tthrow new Error(${JSON.stringify(`start failed ${tag}`)});` : "",
			`\t\t${log(`start:${tag}`)}`,
			`\t\tctx.setInterval(() => { ${log(`tick:${tag}`)} }, 15);`,
			"\t});",
			`\tpi.on("session_shutdown", () => { ${log(`shutdown:${tag}`)} });`,
			`\tpi.events.on("probe", () => { ${log(`probe:${tag}`)} });`,
			options.tool
				? `\tpi.registerTool({ name: ${JSON.stringify(options.tool)}, label: ${JSON.stringify(options.tool)}, description: ${JSON.stringify(`tool ${tag}`)}, parameters: pi.typebox.Type.Object({}), async execute() { return { content: [{ type: "text", text: ${JSON.stringify(tag)} }] }; } });`
				: "",
			"}",
		]
			.filter(Boolean)
			.join("\n");
		fs.writeFileSync(filePath, source);
		// Same-size rewrites inside one mtime tick must still read as a change.
		const bumped = new Date(Date.now() + ++writes * 1000);
		fs.utimesSync(filePath, bumped, bumped);
		return filePath;
	}

	function writeBrokenExtension(file: string): string {
		const filePath = path.join(extensionsDir, file);
		fs.writeFileSync(filePath, "export default function (pi) {{{ this is not typescript\n");
		const bumped = new Date(Date.now() + ++writes * 1000);
		fs.utimesSync(filePath, bumped, bumped);
		return filePath;
	}

	async function startSession(
		overrides: Record<string, unknown> = {},
	): Promise<{ session: AgentSession; notices: string[]; eventBus: EventBus }> {
		const { session, eventBus } = await createAgentSession({
			cwd,
			agentDir: path.join(rootDir, "agent"),
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false, ...overrides }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
			enableMCP: false,
			enableLsp: false,
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [extensionsDir],
		});
		sessions.push(session);
		// The interactive, RPC, and ACP modes announce the session to extensions once it exists;
		// the runner replays that event to extensions added or swapped in later.
		await session.extensionRunner?.emit({ type: "session_start" });
		const notices: string[] = [];
		session.subscribe((event: AgentSessionEvent) => {
			if (event.type === "notice") notices.push(event.message);
		});
		return { session, notices, eventBus };
	}

	function readLifecycle(): string[] {
		return fs.existsSync(lifecycleLog) ? fs.readFileSync(lifecycleLog, "utf8").split("\n").filter(Boolean) : [];
	}

	function clearLifecycle(): void {
		fs.writeFileSync(lifecycleLog, "");
	}

	// These tests exercise real extension timers and the polling watcher on the platform clock,
	// so a deterministic fake clock cannot stand in for the wait.
	const sleep = (ms: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, ms);
		return promise;
	};

	it("loads an extension file added mid-session and starts it", async () => {
		const { session, notices } = await startSession();
		const added = writeExtension("late.ts", "late-1");

		const summary = await session.refreshExtensions();

		expect(summary).toMatchObject({ added: [added], replaced: [], removed: [], errors: [] });
		expect(readLifecycle()).toEqual(["load:late-1", "start:late-1"]);
		expect(notices).toContain("extensions reloaded: +1 ~0 -0\n  + late.ts");
	});

	it("re-imports an edited extension: new code takes effect and the old instance shuts down", async () => {
		const file = writeExtension("probe.ts", "v1");
		const { session, notices, eventBus } = await startSession();
		clearLifecycle();

		writeExtension("probe.ts", "v2");
		const summary = await session.refreshExtensions();

		expect(summary).toMatchObject({ added: [], replaced: [file], removed: [], errors: [] });
		// The new module is imported and its factory run first (staged, so a failure there leaves v1
		// untouched); v1 shuts down only once v2 is about to start.
		expect(readLifecycle().filter(line => !line.startsWith("tick:"))).toEqual(["load:v2", "shutdown:v1", "start:v2"]);
		expect(notices).toContain("extensions reloaded: +0 ~1 -0\n  ~ probe.ts");

		// Exactly one live handler: the old instance's bus listener is gone.
		clearLifecycle();
		eventBus.emit("probe", {});
		await sleep(5);
		expect(readLifecycle().filter(line => line.startsWith("probe:"))).toEqual(["probe:v2"]);
	});

	it("clears the old instance's timers so nothing ticks twice after a reload", async () => {
		writeExtension("ticker.ts", "t1");
		const { session } = await startSession();
		await sleep(60);
		expect(readLifecycle().some(line => line === "tick:t1")).toBe(true);

		writeExtension("ticker.ts", "t2");
		await session.refreshExtensions();
		clearLifecycle();
		await sleep(80);

		const ticks = readLifecycle().filter(line => line.startsWith("tick:"));
		expect(ticks.length).toBeGreaterThan(0);
		expect(ticks.every(line => line === "tick:t2")).toBe(true);
	});

	it("skips a syntax-error extension, reports it, and leaves every other extension untouched", async () => {
		const good = writeExtension("good.ts", "g1");
		const { session, notices } = await startSession();
		clearLifecycle();

		const broken = writeBrokenExtension("broken.ts");
		writeExtension("good.ts", "g2");
		const added = writeExtension("fresh.ts", "f1");
		const summary = await session.refreshExtensions();

		expect(summary?.replaced).toEqual([good]);
		expect(summary?.added).toEqual([added]);
		expect(summary?.errors.map(error => error.path)).toEqual([broken]);
		expect(summary?.errors[0]?.error).toBeTruthy();
		const lifecycle = readLifecycle();
		expect(lifecycle).toContain("start:g2");
		expect(lifecycle).toContain("start:f1");
		expect(notices.some(notice => notice.startsWith("extensions reloaded: +1 ~1 -0, 1 failed"))).toBe(true);
		expect(notices.some(notice => notice.includes("broken.ts:"))).toBe(true);
	});

	it("keeps the old instance when the edited extension no longer imports", async () => {
		const file = writeExtension("steady.ts", "s1");
		const { session, eventBus } = await startSession();
		clearLifecycle();

		writeBrokenExtension("steady.ts");
		const summary = await session.refreshExtensions();

		expect(summary?.replaced).toEqual([]);
		expect(summary?.errors.map(error => error.path)).toEqual([file]);
		// Never shut down, never replaced.
		expect(readLifecycle().filter(line => line.startsWith("shutdown:") || line.startsWith("start:"))).toEqual([]);
		eventBus.emit("probe", {});
		await sleep(5);
		expect(readLifecycle()).toContain("probe:s1");
	});

	it("keeps the old instance when the new one's factory throws", async () => {
		const file = writeExtension("steady.ts", "s1");
		const { session, eventBus } = await startSession();
		clearLifecycle();

		writeExtension("steady.ts", "s2", { factoryThrows: true });
		const summary = await session.refreshExtensions();

		expect(summary?.replaced).toEqual([]);
		expect(summary?.errors).toEqual([{ path: file, error: expect.stringContaining("factory failed s2") }]);
		clearLifecycle();
		eventBus.emit("probe", {});
		await sleep(5);
		expect(readLifecycle().filter(line => line.startsWith("probe:"))).toEqual(["probe:s1"]);
	});

	it("keeps the old instance running when the new one's session_start throws", async () => {
		const file = writeExtension("steady.ts", "s1");
		const { session, eventBus } = await startSession();
		clearLifecycle();

		writeExtension("steady.ts", "s2", { startThrows: true });
		const summary = await session.refreshExtensions();

		expect(summary?.replaced).toEqual([]);
		expect(summary?.errors).toEqual([{ path: file, error: expect.stringContaining("start failed s2") }]);
		// The rejected instance was shut down and dropped; the old one was restarted and is the only listener.
		clearLifecycle();
		eventBus.emit("probe", {});
		await sleep(5);
		expect(readLifecycle().filter(line => line.startsWith("probe:"))).toEqual(["probe:s1"]);
		await sleep(50);
		const ticks = readLifecycle().filter(line => line.startsWith("tick:"));
		expect(ticks.every(line => line === "tick:s1")).toBe(true);
	});

	it("does not add a new extension whose session_start throws", async () => {
		const { session, eventBus } = await startSession();
		const broken = writeExtension("start-fails.ts", "x1", { startThrows: true });

		const summary = await session.refreshExtensions();

		expect(summary?.added).toEqual([]);
		expect(summary?.errors.map(error => error.path)).toEqual([broken]);
		clearLifecycle();
		eventBus.emit("probe", {});
		await sleep(5);
		expect(readLifecycle().filter(line => line.startsWith("probe:"))).toEqual([]);
	});

	it("unloads an extension whose file was deleted", async () => {
		const file = writeExtension("doomed.ts", "d1", { tool: "doomed_tool" });
		const { session, notices, eventBus } = await startSession();
		expect(session.getAllToolNames()).toContain("doomed_tool");
		clearLifecycle();

		fs.rmSync(file);
		const summary = await session.refreshExtensions();

		expect(summary).toMatchObject({ added: [], replaced: [], removed: [file], errors: [] });
		expect(readLifecycle()).toContain("shutdown:d1");
		expect(session.getAllToolNames()).not.toContain("doomed_tool");
		expect(notices).toContain("extensions reloaded: +0 ~0 -1\n  - doomed.ts");
		clearLifecycle();
		eventBus.emit("probe", {});
		await sleep(5);
		expect(readLifecycle()).toEqual([]);
	});

	it("swaps the tools an extension registers", async () => {
		writeExtension("tooly.ts", "a", { tool: "tooly_tool" });
		const { session } = await startSession();
		expect(session.getToolByName("tooly_tool")?.description).toBe("tool a");

		writeExtension("tooly.ts", "b", { tool: "tooly_tool" });
		await session.refreshExtensions();

		expect(session.getToolByName("tooly_tool")?.description).toBe("tool b");
	});

	it("skips unchanged extensions with changedOnly", async () => {
		writeExtension("calm.ts", "c1");
		const { session, notices } = await startSession();
		clearLifecycle();

		const summary = await session.refreshExtensions({ changedOnly: true });

		expect(summary).toMatchObject({ added: [], replaced: [], removed: [], errors: [] });
		expect(readLifecycle()).toEqual([]);
		expect(notices.some(notice => notice.startsWith("extensions"))).toBe(false);
	});

	it("picks up edits on its own with hotReload.extensions on", async () => {
		writeExtension("auto.ts", "a1");
		const { notices } = await startSession({ "hotReload.extensions": true });
		// The watcher records its baseline asynchronously after startup and only then begins polling
		// (every 2 s); let one poll go by so the edit below lands after the baseline.
		await sleep(2_500);
		clearLifecycle();

		writeExtension("auto.ts", "a2");
		const deadline = Date.now() + 10_000;
		while (
			Date.now() < deadline &&
			(!readLifecycle().includes("start:a2") ||
				!notices.some(notice => notice.startsWith("extensions reloaded: +0 ~1 -0")))
		) {
			await sleep(100);
		}

		expect(readLifecycle()).toContain("start:a2");
		expect(notices.some(notice => notice.startsWith("extensions reloaded: +0 ~1 -0"))).toBe(true);
	}, 20_000);
});
