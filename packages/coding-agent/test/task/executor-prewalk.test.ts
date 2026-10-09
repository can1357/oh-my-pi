import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createTaskModelFixture, type TaskModelFixture } from "../helpers/model-fixtures";
import { wrapRoleRouteStream } from "@oh-my-pi/pi-coding-agent/task/role-routing";

let fixture: TaskModelFixture;
let cwd: TempDir;
const sessions: AgentSession[] = [];

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	fixture = createTaskModelFixture();
	cwd = TempDir.createSync("omp-subagent-prewalk-");
});

afterEach(async () => {
	await AgentLifecycleManager.global().dispose();
	await Promise.all(sessions.splice(0).map(session => session.dispose()));
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	fixture.close();
	await cwd.remove();
});

/** Record actual scripted requests after the session's real prewalk handoff. */
function installRecordingSession() {
	const requests: string[] = [];
	vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
		if (!options?.model || !options.sessionManager || !options.roleRoute) throw new Error("Expected admitted worker");
		const mock = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "write", arguments: {} }] },
				{ content: [{ type: "toolCall", name: "yield", arguments: {} }] },
				{ content: ["done"] },
			],
		});
		const tools: AgentTool[] = ["read", "write", "yield"].map(name => ({
			name,
			label: name,
			description: name,
			parameters: type({}),
			execute: async () => ({
				content: [{ type: "text", text: "ok" }],
				details: { status: "success", data: { completed: true } },
			}),
		}));
		const agent = new Agent({
			getApiKey: () => "test-only-key",
			initialState: { model: options.model, tools, systemPrompt: ["prewalk fixture"], messages: [] },
			convertToLlm,
			streamFn: wrapRoleRouteStream(
				() => options.roleRoute,
				(model, context, streamOptions) => {
					requests.push(`${model.provider}/${model.id}`);
					return mock.stream(model, context, streamOptions);
				},
				fixture.modelRegistry,
			),
		});
		const session = new AgentSession({
			agent,
			sessionManager: options.sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry: fixture.modelRegistry,
			roleRoute: options.roleRoute,
			prewalk: options.prewalk,
			toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
		});
		sessions.push(session);
		return { session, extensionsResult: {}, setToolUIContext: () => {} } as never;
	});
	return requests;
}

describe("governed subagent prewalk handoff", () => {
	for (const mode of ["frontmatter", "agent override", "task setting"] as const) {
		it(`serves on the approved prewalk candidate selected by ${mode}`, async () => {
			const requests = installRecordingSession();
			const settings = Settings.isolated({
				modelRoles: { smol: fixture.selectors.fallback },
				...(mode === "agent override" ? { "task.agentPrewalk": { task: "on" } } : {}),
				...(mode === "task setting" ? { "task.prewalk": true } : {}),
			});
			const agent: AgentDefinition = {
				name: "task",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
				model: [fixture.selectors.primary, fixture.selectors.fallback],
				...(mode === "frontmatter" ? { prewalk: fixture.selectors.fallback } : {}),
			};
			const result = await runSubprocess({
				cwd: cwd.path(),
				agent,
				task: "work",
				index: 0,
				id: "prewalk-approved",
				settings,
				modelRegistry: fixture.modelRegistry,
				enableLsp: false,
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(requests).toEqual([fixture.selectors.primary, fixture.selectors.fallback]);
			expect(result.resolvedModelIdentity).toBe(fixture.selectors.fallback);
		});
	}

	for (const mode of ["override off", "identical target", "unarmed"] as const) {
		it(`stays on the approved primary with prewalk ${mode}`, async () => {
			const requests = installRecordingSession();
			const result = await runSubprocess({
				cwd: cwd.path(),
				task: "work",
				index: 0,
				id: "prewalk-disabled",
				agent: {
					name: "task",
					description: "test",
					systemPrompt: "test",
					source: "bundled",
					model: [fixture.selectors.primary, fixture.selectors.fallback],
					...(mode === "unarmed"
						? {}
						: { prewalk: mode === "identical target" ? fixture.selectors.primary : fixture.selectors.fallback }),
				},
				settings: Settings.isolated(mode === "override off" ? { "task.agentPrewalk": { task: "off" } } : {}),
				modelRegistry: fixture.modelRegistry,
				enableLsp: false,
			});
			expect(result.exitCode, result.stderr).toBe(0);
			expect(requests).toEqual([fixture.selectors.primary, fixture.selectors.primary]);
			expect(result.resolvedModelIdentity).toBe(fixture.selectors.primary);
		});
	}

	it("does not let a prewalk setting widen a literal approved model closure", async () => {
		const requests = installRecordingSession();
		const result = await runSubprocess({
			cwd: cwd.path(),
			task: "work",
			index: 0,
			id: "prewalk-outside-pin",
			agent: {
				name: "task",
				description: "test",
				systemPrompt: "test",
				source: "bundled",
				model: [fixture.selectors.primary],
				prewalk: true,
			},
			settings: Settings.isolated({ modelRoles: { smol: fixture.selectors.fallback } }),
			modelRegistry: fixture.modelRegistry,
			enableLsp: false,
		});
		expect(result.exitCode, result.stderr).toBe(1);
		expect(result.stderr).toContain("Host role");
		expect(requests).toEqual([fixture.selectors.primary]);
	});
});
