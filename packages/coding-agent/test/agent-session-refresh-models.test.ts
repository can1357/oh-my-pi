import { afterAll, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("AgentSession.refreshModels ordering", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	afterAll(async () => {
		await session?.dispose();
		authStorage.close();
		await tempDir.remove();
	});

	it("forces the static rebuild before the online discovery pass", async () => {
		tempDir = TempDir.createSync("@pi-refresh-models-");
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		await Bun.write(tempDir.join("models.yml"), YAML.stringify({ models: [] }));

		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const settings = Settings.isolated({});
		const primaryMock = createMockModel({ provider: "anthropic" });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryMock, systemPrompt: [], tools: [] },
			streamFn: primaryMock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});

		const order: string[] = [];
		vi.spyOn(modelRegistry, "awaitBackgroundRefresh").mockImplementation(async () => {
			order.push("awaitBackgroundRefresh");
		});
		vi.spyOn(modelRegistry, "reapplyModelPolicies").mockImplementation(async () => {
			order.push("reapply");
		});
		vi.spyOn(modelRegistry, "refresh").mockImplementation(async () => {
			order.push("refresh");
		});

		await session.refreshModels("offline");

		// awaitBackgroundRefresh serializes against startup's in-flight discovery;
		// reapplyModelPolicies forces the mtime-gated static rebuild; refresh then
		// discovers against the fresh provider set. Any other order would reuse the
		// stale provider set or let an out-of-order refresh re-add a disabled provider.
		expect(order).toEqual(["awaitBackgroundRefresh", "reapply", "refresh"]);
	});
});
