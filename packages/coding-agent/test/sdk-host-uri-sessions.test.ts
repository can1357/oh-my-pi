/**
 * RPC host URI schemes belong to the session `set_host_uri_schemes` reached and to the
 * task subagents it spawns on its thread; no other session resolves them.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession, type CreateAgentSessionOptions } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { SingleResult } from "@oh-my-pi/pi-coding-agent/task/task-details";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "Do the assigned work.",
	source: "bundled",
};

function subprocessResult(id: string): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "Inspect the target.",
		assignment: "Inspect the target.",
		exitCode: 0,
		output: "done",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
}

/** Text of a read through `session`'s own read tool; a failure's message when it throws. */
async function readThrough(session: AgentSession, url: string): Promise<string> {
	const read = session.getToolByName("read");
	if (!read) throw new Error("Expected a read tool");
	try {
		const result = await read.execute(`read-${url}`, { path: url });
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

afterEach(() => {
	vi.restoreAllMocks();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
});

describe("RPC host URI schemes across sessions", () => {
	it("reach the RPC session's tools and its task subagents, never a sibling session", async () => {
		const tempDir = TempDir.createSync("@pi-host-uri-sessions-");
		const authStorage = createInMemoryAuthStorage();
		const sessions: AgentSession[] = [];
		try {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled test model");
			authStorage.keys.setRuntime("anthropic", "test-key");
			const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
			const settings = Settings.isolated({
				"async.enabled": false,
				"compaction.enabled": false,
				"task.isolation.enabled": false,
				"todo.enabled": false,
			});
			const base: CreateAgentSessionOptions = {
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				authStorage,
				modelRegistry,
				settings,
				model,
				toolNames: ["read", "task"],
				disableExtensionDiscovery: true,
			};
			const open = async (options: Partial<CreateAgentSessionOptions> = {}): Promise<AgentSession> => {
				const { session } = await createAgentSession({
					...base,
					sessionManager: SessionManager.inMemory(tempDir.path()),
					...options,
				});
				sessions.push(session);
				return session;
			};

			const rpcSession = await open();
			vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [taskAgent], projectAgentsDir: null });
			const dispatched: executorModule.ExecutorOptions[] = [];
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				dispatched.push(options);
				return subprocessResult(options.id ?? "task");
			});
			const task = rpcSession.getToolByName("task");
			if (!task) throw new Error("Expected a task tool");
			await task.execute("spawn", {
				context: "The host serves db:// rows.",
				tasks: [{ agent: "task", name: "Child", task: "Read the row." }],
			});
			const childOptions = dispatched[0];
			if (!childOptions) throw new Error("Expected one dispatched subagent");
			// The child is built from the spawn's options, as the executor builds it on the parent's thread.
			const child = await open({ parentHostUriSources: childOptions.parentHostUriSources, taskDepth: 1 });
			const sibling = await open();

			// The host registers its scheme after both sessions exist, the way rpc-mode wires set_host_uri_schemes.
			const requests: string[] = [];
			const bridge: RpcHostUriBridge = new RpcHostUriBridge(frame => {
				if (frame.type !== "host_uri_request") return;
				requests.push(frame.url);
				bridge.handleResult({ type: "host_uri_result", id: frame.id, content: `payload of ${frame.url}` });
			}, rpcSession.urlSchemes.hostUris);
			bridge.setSchemes([{ scheme: "db" }]);

			expect(await readThrough(rpcSession, "db://rows/1")).toContain("payload of db://rows/1");
			expect(await readThrough(child, "db://rows/2")).toContain("payload of db://rows/2");
			expect(await readThrough(sibling, "db://rows/3")).not.toContain("payload of");
			expect(requests).toEqual(["db://rows/1", "db://rows/2"]);
		} finally {
			for (const session of sessions.reverse()) await session.dispose();
			authStorage.close();
			tempDir.removeSync();
		}
	});
});
