import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AcpSessionFactoryOptions, createAcpSessionFactory } from "@oh-my-pi/pi-coding-agent/main";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

/**
 * Contract test for the production `omp acp` session factory: the per-session
 * task/extension EventBus created in the factory must ride the returned
 * handle, or `_omp/agents/progress` subscriptions can never fire outside of
 * tests (the harness fabricates its own bus and would otherwise mask this).
 */
describe("createAcpSessionFactory handle contract", () => {
	test("threads the session's task-event bus through the returned ACP handle", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-acp-factory-"));
		// Handle-level contract only: the pipeline never touches more than
		// sessionId through this path, so a stub satisfies the interface by fiat.
		const fakeSession = { sessionId: "factory-contract" } as unknown as AgentSession;
		let capturedOptions: Record<string, unknown> | undefined;
		const settingsStub = {
			cloneForCwd: async () => ({ get: () => undefined }),
		};
		const args = {
			baseOptions: {},
			settings: settingsStub,
			authStorage: {},
			modelRegistry: {},
			parsedArgs: {},
			rawArgs: [],
			createSession: async (options: Record<string, unknown>) => {
				capturedOptions = options;
				return { session: fakeSession };
			},
		} as unknown as AcpSessionFactoryOptions;

		const factory = createAcpSessionFactory(args);
		const handle = await factory(cwd);

		expect(handle.session).toBe(fakeSession);
		// The bus built by the factory is the one handed to the agent-session
		// pipeline AND the one exposed on the handle — a single shared instance.
		expect(handle.eventBus).toBeInstanceOf(EventBus);
		expect(capturedOptions?.eventBus).toBe(handle.eventBus);
		// ACP clients own MCP configuration exclusively; the factory must keep
		// disk discovery off so host servers cannot shadow client-supplied ones.
		expect(capturedOptions?.enableMCP).toBe(false);

		await fs.rm(cwd, { recursive: true, force: true });
	});
});
