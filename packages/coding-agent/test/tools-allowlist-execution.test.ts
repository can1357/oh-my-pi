/**
 * `--tools` governs every path that can run a tool, not only the tools the
 * primary model is offered (PR #17970 review, round 2): the advisor, the Cursor
 * execution bridge, the private auto-learn capture, and a `write` that a child
 * or clone session re-registers as the device transport. Each case drives a
 * real session with a scripted model and checks the real filesystem.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { TanCommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/tan-command-controller";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as settingsStream from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import { ToolAllowList } from "@oh-my-pi/pi-coding-agent/tools/tool-allowlist";
import { type } from "@oh-my-pi/omptype";
import type { AsyncJobRun } from "@oh-my-pi/pi-coding-agent/async/job-manager";

let dir: string;
let auth: AuthStorage;
let registry: ModelRegistry;
const sessions: AgentSession[] = [];
const model = getBundledModel("openai", "gpt-4o-mini")!;

beforeAll(async () => {
	dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-allowlist-exec-"));
	auth = await AuthStorage.create(path.join(dir, "auth.db"));
	auth.keys.setRuntime("openai", "test-key");
	registry = new ModelRegistry(auth, path.join(dir, "models.yml"));
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	auth.close();
	await fs.rm(dir, { recursive: true, force: true });
});

async function create(
	options: Partial<CreateAgentSessionOptions>,
	settings: Record<string, unknown> = {},
): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd: dir,
		agentDir: dir,
		authStorage: auth,
		modelRegistry: registry,
		model,
		settings: Settings.isolated({
			"async.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"advisor.enabled": false,
			...settings,
		}),
		agentRegistry: new AgentRegistry(),
		sessionManager: SessionManager.inMemory(dir),
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		skipPythonPreflight: true,
		cacheWarming: false,
		autoApprove: true,
		...options,
	});
	sessions.push(session);
	return session;
}

/** Drive one model turn that calls `write` on `target`, then read the file. */
async function attemptWrite(session: AgentSession, target: string): Promise<string> {
	const mock = createMockModel({
		provider: "openai",
		responses: [
			{ content: [{ type: "toolCall", name: "write", arguments: { path: target, content: "forbidden write" } }] },
			{ content: ["done"] },
		],
	});
	session.agent.streamFn = mock.stream;
	await session.agent.prompt("attempt a file write");
	return await Bun.file(target)
		.text()
		.catch(() => "ABSENT");
}

const fixtureDevice = {
	name: "mcp__fixture_probe",
	label: "Probe",
	description: "Harmless fixture device",
	parameters: type({}),
	mcpServerName: "fixture",
	mcpToolName: "probe",
	execute: async () => ({ content: [{ type: "text", text: "fixture" }] }),
} as unknown as CustomTool;

describe("write is only the device transport when --tools does not list it", () => {
	const policy = ToolAllowList.parse(["read", "task", "mcp:fixture"]);

	it("for a child with the parent's list and default tools", async () => {
		const child = await create({ requireYieldTool: true, toolAllowList: policy, mcpTools: [fixtureDevice] });
		expect(await attemptWrite(child, path.join(dir, "default-child.txt"))).toBe("ABSENT");
	});

	it("for a child whose own list names write", async () => {
		const child = await create({
			toolNames: ["read", "write"],
			requireYieldTool: true,
			toolAllowList: policy,
			mcpTools: [fixtureDevice],
		});
		expect(await attemptWrite(child, path.join(dir, "explicit-child.txt"))).toBe("ABSENT");
	});

	// The real `/tan` controller: the clone gets the parent's enabled names, which
	// include `write` as the device transport, so without the parent's list it
	// could write files.
	it("for a /tan clone", async () => {
		const parent = await create(
			{ toolNames: ["read", "task"], toolAllowList: policy, mcpTools: [fixtureDevice] },
			{ "async.enabled": true },
		);
		expect(parent.getEnabledToolNames()).toContain("write");
		const target = path.join(dir, "tan-clone.txt");
		let run: AsyncJobRun | undefined;
		vi.spyOn(parent.asyncJobManager!, "register").mockImplementation((_type, _label, job) => {
			run = job;
			return "job-tan";
		});
		vi.spyOn(parent, "sendCustomMessage").mockResolvedValue(true);
		vi.spyOn(SessionManager, "forkFrom").mockResolvedValue(SessionManager.inMemory(dir));
		const realCreate = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const result = await realCreate({
				...options,
				agentDir: dir,
				agentRegistry: new AgentRegistry(),
				disableExtensionDiscovery: true,
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				skipPythonPreflight: true,
				cacheWarming: false,
			});
			sessions.push(result.session);
			result.session.agent.streamFn = createMockModel({
				provider: "openai",
				responses: [
					{ content: [{ type: "toolCall", name: "write", arguments: { path: target, content: "tan write" } }] },
					{ content: ["done"] },
				],
			}).stream;
			return result;
		});
		const ctx = {
			session: parent,
			sessionManager: {
				getHeader: () => undefined,
				getSessionFile: () => path.join(dir, "tan-parent.jsonl"),
				getCwd: () => dir,
				getSessionDir: () => dir,
				getArtifactsDir: () => path.join(dir, "tan-parent"),
				getSessionId: () => "tan-parent",
				ensureOnDisk: async () => {},
				flush: async () => {},
			},
			settings: Settings.isolated({ "async.enabled": true }),
			mcpManager: undefined,
			showStatus: () => {},
			showWarning: () => {},
			showError: (message: string) => {
				throw new Error(message);
			},
			rebuildChatFromMessages: () => {},
		} as unknown as InteractiveModeContext;
		expect(await new TanCommandController(ctx).start("write the marker")).toBe(true);
		if (!run) throw new Error("/tan registered no job");
		await run({
			jobId: "job-tan",
			signal: new AbortController().signal,
			reportProgress: async () => {},
			markRunning: () => {},
		});
		expect(await Bun.file(target).exists()).toBe(false);
	});

	it("but writes files when the list names write", async () => {
		const session = await create({
			toolNames: ["read", "write"],
			toolAllowList: ToolAllowList.parse(["read", "write"]),
		});
		expect(await attemptWrite(session, path.join(dir, "allowed.txt"))).toBe("forbidden write");
	});
});

describe("other paths that run tools", () => {
	it("gives the advisor only tools the list allows", async () => {
		await Bun.write(
			path.join(dir, "WATCHDOG.yml"),
			"advisors:\n  - name: probe\n    model: openai/gpt-4o-mini\n    tools: [read, write]\n",
		);
		try {
			const session = await create({ toolNames: ["read"], toolAllowList: ToolAllowList.parse(["read"]) });
			session.setAdvisorEnabled(true);
			const advisor = session.getAdvisorAgent()!;
			expect(advisor.state.tools.map(tool => tool.name)).not.toContain("write");
			const target = path.join(dir, "advisor.txt");
			const mock = createMockModel({
				provider: "openai",
				responses: [
					{ content: [{ type: "toolCall", name: "write", arguments: { path: target, content: "advisor" } }] },
					{ content: ["finished"] },
				],
			});
			advisor.streamFn = mock.stream;
			await advisor.prompt("write the marker");
			expect(await Bun.file(target).exists()).toBe(false);
			session.setAdvisorEnabled(false);
		} finally {
			await fs.rm(path.join(dir, "WATCHDOG.yml"), { force: true });
		}
	});

	it("refuses a Cursor exec frame for a tool the list does not allow", async () => {
		const marker = path.join(dir, "cursor.txt");
		const probeSend = {
			name: "probe_send",
			label: "Send",
			description: "Writes a marker when invoked",
			parameters: type({}),
			execute: async () => {
				await Bun.write(marker, "sent");
				return { content: [{ type: "text", text: "sent marker" }] };
			},
		} as unknown as CustomTool;
		const session = await create({
			toolNames: ["read"],
			toolAllowList: ToolAllowList.parse(["read"]),
			customTools: [probeSend],
		});
		const mock = createMockModel({ provider: "openai", responses: [{ content: ["frame done"] }] });
		let frame: unknown;
		session.agent.streamFn = async (streamModel, context, options) => {
			const handlers = options?.cursorExecHandlers;
			frame = await handlers?.mcp?.({
				toolName: "probe_send",
				name: "probe_send",
				providerIdentifier: "omp",
				toolCallId: "frame-1",
				args: {},
				rawArgs: {},
			});
			return mock.stream(streamModel, context, options);
		};
		await session.agent.prompt("deliver a server exec frame");
		expect(frame).toBeDefined();
		expect(JSON.stringify(frame)).not.toContain("sent marker");
		expect(await Bun.file(marker).exists()).toBe(false);
	});

	it("offers the private auto-learn capture no tool the list does not allow", async () => {
		const offered: string[][] = [];
		const original = settingsStream.createSettingsAwareStreamFn;
		const mock = createMockModel({
			provider: "openai",
			handler: context => {
				const names = context.tools?.map(tool => tool.name) ?? [];
				offered.push(names);
				if (names.includes("manage_skill")) {
					return {
						content: [
							{
								type: "toolCall",
								name: "manage_skill",
								arguments: { action: "create", name: "allowlist-probe", description: "probe", body: "probe" },
							},
						],
					};
				}
				return { content: ["done"] };
			},
		});
		vi.spyOn(settingsStream, "createSettingsAwareStreamFn").mockImplementation((settings, _base, slow) =>
			original(settings, (streamModel, context, options) => mock.stream(streamModel, context, options), slow),
		);
		const session = await create(
			{ toolNames: ["read"], toolAllowList: ToolAllowList.parse(["read"]) },
			{
				"autolearn.enabled": true,
				"autolearn.autoContinue": true,
				"autolearn.minToolCalls": 0,
				"memory.backend": "off",
			},
		);
		await session.prompt("learn nothing");
		await session.waitForIdle();
		// The capture, when it runs, starts right after the turn.
		await Bun.sleep(1_000);
		expect(offered.flat()).not.toContain("manage_skill");
		expect(await Bun.file(path.join(dir, "managed-skills", "allowlist-probe", "SKILL.md")).exists()).toBe(false);
	}, 60_000);
});
