import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("advisor runtime vs swapped model records", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	let tempDir: TempDir;
	let session: AgentSession;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-advisor-meta-");
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			advisorTools: [],
		});
	});

	afterEach(async () => {
		await session.dispose();
		try {
			await tempDir.remove();
		} catch {}
	});

	function enableAdvisor(): void {
		session.settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		session.toggleAdvisorEnabled();
	}

	function swapAdvisorRecord(): Model {
		// A models.yml metadata edit re-issues the same provider/id as a new
		// record (here: moved baseUrl); the selector string is unchanged.
		const relocated: Model = { ...model, baseUrl: "https://relocated.invalid/v1" };
		const getAvailable = spyOn(modelRegistry, "getAvailable").mockReturnValue([relocated]);
		try {
			session.reapplyModelRoles();
		} finally {
			getAvailable.mockRestore();
		}
		return relocated;
	}

	it("rebuilds a live advisor when a metadata-only edit swaps the model record", () => {
		enableAdvisor();
		const before = session.getAdvisorAgent();
		if (!before) throw new Error("Expected advisor agent to exist");

		const relocated = swapAdvisorRecord();

		const after = session.getAdvisorAgent();
		if (!after) throw new Error("Expected advisor agent to exist after reapply");
		expect(after).not.toBe(before);
		expect(after.state.model).toBe(relocated);
	});

	it("keeps the advisor runtime when the registry still resolves the same record", () => {
		enableAdvisor();
		const before = session.getAdvisorAgent();
		if (!before) throw new Error("Expected advisor agent to exist");

		session.reapplyModelRoles();

		const after = session.getAdvisorAgent();
		expect(after).toBe(before);
	});
});
