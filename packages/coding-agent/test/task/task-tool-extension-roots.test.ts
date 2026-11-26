/**
 * In one process and one directory, a merge-mode session whose explicit extension root holds an agent builds its task
 * tool first; a later session there under other extension roots gets a task tool that neither offers that agent nor
 * spawns it, as created and without a discovery being published.
 */
import { afterAll, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

/** The agent of the first session's explicit extension root (`<root>/agents/*.md`). */
const EXPLICIT_AGENT = "explicit-root-agent";
/** The agent supplied only through the second session's extension-roots provider. */
const CALLBACK_AGENT = "callback-root-agent";
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

/**
 * Whether a session's task tool lists the explicit root's agent, its callback-supplied agent, and what a task call
 * naming the explicit agent answers: `unknown agent` where the call is refused for that, else the call's text.
 */
interface TaskToolView {
	readonly offers: boolean;
	readonly callback: boolean;
	readonly spawn?: string;
}

describe("a session's task tool after another session in its directory discovered an agent under other roots", () => {
	let tempDir: TempDir | undefined;
	let cwd: string;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage | undefined;
	let homedirSpy: Mock<typeof os.homedir> | undefined;
	let first: AgentSession | undefined;
	let firstView: TaskToolView | undefined;
	const sessions: AgentSession[] = [];
	const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

	/** Builds a session in the shared directory; `roots` sets how it gets its extension roots. */
	async function build(roots: Partial<sdkModule.CreateAgentSessionOptions>): Promise<AgentSession> {
		const { session } = await sdkModule.createAgentSession({
			cwd,
			agentDir: getAgentDir(),
			modelRegistry,
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({
				"async.enabled": false,
				"advisor.enabled": false,
				"compaction.enabled": false,
				"retry.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			toolNames: ["task"],
			spawns: "*",
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			rules: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			...roots,
		});
		sessions.push(session);
		return session;
	}

	/** What `session`'s task tool offers; with `call`, also the answer to a task call naming the explicit agent. */
	async function view(session: AgentSession, call: boolean): Promise<TaskToolView> {
		const tool = session.getToolByName("task");
		if (!tool) throw new Error("The session has no task tool");
		const offers = tool.description.includes(EXPLICIT_AGENT);
		const callback = tool.description.includes(CALLBACK_AGENT);
		if (!call) return { offers, callback };
		// A subagent the call would start ends at its build, before any model call.
		const createSpy = spyOn(sdkModule, "createAgentSession").mockImplementation(async () => {
			throw new Error("The task call started a subagent");
		});
		try {
			const result = await tool.execute("explicit-agent-call", {
				agent: EXPLICIT_AGENT,
				name: "ExplicitProbe",
				task: "Report.",
				solutionSpace: "one fix: probe only",
			});
			const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
			const unknown = result.isError === true && text.includes(`Unknown agent "${EXPLICIT_AGENT}"`);
			return { offers, callback, spawn: unknown ? "unknown agent" : text };
		} finally {
			createSpy.mockRestore();
		}
	}

	beforeAll(async () => {
		tempDir = await TempDir.create("@task-tool-extension-roots-");
		cwd = tempDir.join("project");
		// User-level discovery reads the process-global agent dir and home: point both at the fixture.
		setAgentDir(tempDir.join("home/.omp/agent"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir.join("home"));
		await Promise.all([
			Bun.write(
				tempDir.join(`explicit-root/agents/${EXPLICIT_AGENT}.md`),
				`---\nname: ${EXPLICIT_AGENT}\ndescription: Agent of the explicit root.\n---\n\nCheck the rows.\n`,
			),
			Bun.write(
				tempDir.join(`callback-root/agents/${CALLBACK_AGENT}.md`),
				`---\nname: ${CALLBACK_AGENT}\ndescription: Agent of the callback root.\n---\n\nCheck the rows.\n`,
			),
			Bun.write(tempDir.join("project/README.md"), "The shared directory.\n"),
		]);
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		// The first task tool built in the directory: merge mode, with the explicit root.
		first = await build({ additionalExtensionPaths: [tempDir.join("explicit-root")] });
		firstView = await view(first, false);
	}, 60_000);

	afterAll(async () => {
		try {
			await Promise.allSettled(sessions.splice(0).map(session => session.dispose()));
			authStorage?.close();
			closeModelCache();
		} finally {
			homedirSpy?.mockRestore();
			for (const key of ENV_KEYS) {
				if (originalEnv[key] === undefined) delete process.env[key];
				else process.env[key] = originalEnv[key];
			}
			__resetDirsFromEnvForTests();
			if (tempDir) await tempDir.remove();
		}
	});

	it("explicit-only with no explicit root: its task tool neither offers nor spawns the first session's explicit agent", async () => {
		const explicitOnly = await build({ disableExtensionDiscovery: true });
		expect({ first: firstView, explicitOnly: await view(explicitOnly, true) }).toEqual({
			first: { offers: true, callback: false },
			explicitOnly: { offers: false, callback: false, spawn: "unknown agent" },
		});
	}, 60_000);

	it("a session's task tool offers its own callback roots, not the first session's explicit root", async () => {
		if (!first || !tempDir) throw new Error("The first session was not built");
		const firstRoots = first.effectiveExtensionRoots;
		const callbackRoot = tempDir.join("callback-root");
		const ownRoots = await build({
			extensionRoots: () => ({ ...firstRoots, explicit: [callbackRoot] }),
		});
		expect({ first: firstView, ownRoots: await view(ownRoots, true) }).toEqual({
			first: { offers: true, callback: false },
			ownRoots: { offers: false, callback: true, spawn: "unknown agent" },
		});
	}, 60_000);
});
