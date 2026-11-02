import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAgentIdentity,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionAdvisors from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Extensions need to know which agent they run in: the same factory is rebound to every
// subagent, and hooks such as a Claude-style SubagentStart must act only there.
describe("ExtensionContext.agent", () => {
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ext-agent-identity-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(
		extension: ExtensionFactory,
		options: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			...options,
		});
		return session;
	}

	async function agentSeenByExtensions(options: Partial<CreateAgentSessionOptions>): Promise<ExtensionAgentIdentity> {
		let seen: ExtensionAgentIdentity | undefined;
		const session = await createSession(pi => {
			pi.on("before_agent_start", (_event, ctx) => {
				seen = ctx.agent;
			});
		}, options);
		try {
			await session.extensionRunner!.emitBeforeAgentStart("hi", undefined, []);
			return seen!;
		} finally {
			await session.dispose();
		}
	}

	test("a top-level session reports itself as the main agent", async () => {
		expect(await agentSeenByExtensions({})).toEqual({ kind: "main", id: "Main", name: "main", depth: 0 });
	});

	test("a subagent session reports its kind, id, definition name, depth and parent", async () => {
		expect(
			await agentSeenByExtensions({
				taskDepth: 2,
				parentTaskPrefix: "0-Explore",
				agentId: "0-Explore",
				agentDisplayName: "Explore",
				agentName: "Explore",
				parentAgentId: "Main",
			}),
		).toEqual({ kind: "sub", id: "0-Explore", name: "explore", depth: 2, parentId: "Main" });
	});

	test("a spawned session outside the task tool is a subagent at depth 0", async () => {
		// `/tan` clones pass a parent prefix but no task depth or agent definition.
		expect(
			await agentSeenByExtensions({
				parentTaskPrefix: "Main-tan-1",
				agentId: "Main-tan-1",
				agentDisplayName: "tan",
				parentAgentId: "Main",
			}),
		).toEqual({ kind: "sub", id: "Main-tan-1", name: "sub", depth: 0, parentId: "Main" });
	});

	// Advisors share the session's runner for approval enforcement; an extension scoping
	// tool hooks to the main agent (e.g. injecting hints into tool results) must not act
	// on the advisor's own investigation (issue #13598).
	test("an advisor's tool calls report the advisor, not the session's agent", async () => {
		const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
		let advisorTools: AgentTool[] = [];
		const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
			host: sessionAdvisors.SessionAdvisorsHost,
			options: sessionAdvisors.SessionAdvisorsOptions,
		) {
			advisorTools = options.tools ?? [];
			return new RealSessionAdvisors(host, options);
		} as never);
		const seen: Array<{ event: string; toolCallId: string; agent: ExtensionAgentIdentity }> = [];
		fs.writeFileSync(path.join(tempDir, "probe.txt"), "needle\n");
		let session: AgentSession;
		try {
			session = await createSession(pi => {
				pi.on("tool_call", (event, ctx) => {
					seen.push({ event: event.type, toolCallId: event.toolCallId, agent: ctx.agent });
				});
				pi.on("tool_result", (event, ctx) => {
					seen.push({ event: event.type, toolCallId: event.toolCallId, agent: ctx.agent });
				});
			});
		} finally {
			advisorsSpy.mockRestore();
		}
		try {
			const advisorGrep = advisorTools.find(tool => tool.name === "grep");
			await advisorGrep!.execute("advisor-call", { pattern: "needle", path: tempDir });
			await session.getToolByName("read")!.execute("main-call", { path: path.join(tempDir, "probe.txt") });
		} finally {
			await session.dispose();
		}

		const advisor: ExtensionAgentIdentity = {
			kind: "sub",
			id: "advisor",
			name: "advisor",
			depth: 0,
			parentId: "Main",
		};
		const main: ExtensionAgentIdentity = { kind: "main", id: "Main", name: "main", depth: 0 };
		expect(seen).toEqual([
			{ event: "tool_call", toolCallId: "advisor-call", agent: advisor },
			{ event: "tool_result", toolCallId: "advisor-call", agent: advisor },
			{ event: "tool_call", toolCallId: "main-call", agent: main },
			{ event: "tool_result", toolCallId: "main-call", agent: main },
		]);
	});
});
