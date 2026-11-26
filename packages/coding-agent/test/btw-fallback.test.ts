import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { BtwController } from "@oh-my-pi/pi-coding-agent/modes/controllers/btw-controller";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { BtwPanelComponent } from "@oh-my-pi/pi-tui/overlays/btw-panel";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(() => initTheme());
afterEach(() => vi.restoreAllMocks());

describe("/btw configured fallback", () => {
	it.each([false, true])("429 walks configured routes and leaves parent unchanged, resumed=%s", async resumed => {
		await scenario(resumed, "fallback");
	});
	it("healthy primary renders without fallback", async () => {
		await scenario(true, "healthy");
	});
	it("exhaustion reports one error and terminates cyclic chains", async () => {
		await scenario(true, "exhausted");
	});

	async function scenario(resumed: boolean, result: "fallback" | "healthy" | "exhausted") {
		const dir = TempDir.createSync("omp-btw-fallback-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: dir.path() });
		const auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", "fixture-primary");
		auth.keys.setRuntime("openai", "fixture-fallback");
		const registry = new ModelRegistry(auth);
		const primary = registry.find("anthropic", "claude-sonnet-4-5")!;
		const secondary = registry.find("openai", "gpt-4o-mini")!;
		const primaryRoute = `${primary.provider}/${primary.id}`;
		const secondaryRoute = `${secondary.provider}/${secondary.id}`;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.fallbackChains": { [primaryRoute]: [secondaryRoute], [secondaryRoute]: [primaryRoute] },
			"retry.modelFallback": true,
		});
		let manager = SessionManager.create(dir.path(), dir.path());
		manager.appendModelChange(primaryRoute, "default");
		manager.appendMessage({ role: "user", content: "We were fixing the cache", timestamp: 1 });
		await manager.ensureOnDisk();
		if (resumed) {
			const file = manager.getSessionFile()!;
			await manager.close();
			manager = await SessionManager.open(file, dir.path());
		}
		const attempts: string[] = [];
		const mock = createMockModel();
		const sideStreamFn: StreamFn = async (model, context, options) => {
			attempts.push(`${model.provider}/${model.id}`);
			// Authentication stays model-aware and resolves in the parent's credential scope.
			expect(typeof options?.apiKey).toBe("function");
			const key =
				typeof options?.apiKey === "function"
					? await options.apiKey({ lastChance: false, error: undefined })
					: undefined;
			expect(typeof key === "string" ? key : key?.apiKey).toBe(
				model.provider === "anthropic" ? "fixture-primary" : "fixture-fallback",
			);
			expect(options?.sessionId).not.toBe(manager.getSessionId());
			expect(options?.parentSessionId).toBe(manager.getSessionId());
			if (result === "exhausted" || (result === "fallback" && model === primary)) {
				mock.push({ throw: new Error("429 rate_limit_error: rate limit exceeded") });
			} else mock.push({ content: ["We were fixing the cache."] });
			return mock.stream(model, context, options);
		};
		const session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: primary,
					systemPrompt: ["Test"],
					tools: [],
					messages: manager.buildSessionContext().messages,
				},
			}),
			sessionManager: manager,
			settings,
			modelRegistry: registry,
			sideStreamFn,
		});
		const mode = new InteractiveMode(session, "test");
		mode.ui.requestRender = vi.fn();
		mode.ui.requestComponentRender = vi.fn();
		const controller = new BtwController(mode);
		const settled = Promise.withResolvers<void>();
		const complete = vi
			.spyOn(BtwPanelComponent.prototype, "markComplete")
			.mockImplementation(() => settled.resolve());
		const failed = vi.spyOn(BtwPanelComponent.prototype, "markError").mockImplementation(() => settled.resolve());
		const answer = vi.spyOn(BtwPanelComponent.prototype, "setAnswer");
		const before = structuredClone(session.messages);
		const entries = structuredClone(manager.getEntries());
		try {
			expect(await controller.start("I stepped away. Where were we?")).toBe(true);
			await settled.promise;
			await controller.flush();
			expect(attempts).toEqual(result === "healthy" ? [primaryRoute] : [primaryRoute, secondaryRoute]);
			if (result === "exhausted") {
				expect(failed).toHaveBeenCalledTimes(1);
				expect(failed.mock.calls[0]?.[0]).toContain("No eligible fallback");
				expect(complete).not.toHaveBeenCalled();
			} else {
				expect(failed.mock.calls).toEqual([]);
				expect(answer).toHaveBeenCalledWith("We were fixing the cache.");
				expect(complete).toHaveBeenCalledTimes(1);
				expect(failed).not.toHaveBeenCalled();
			}
			expect(session.model).toBe(primary);
			expect(session.messages).toEqual(before);
			// Usage accounting may append completion entries; conversation/model entries stay unchanged.
			expect(manager.getEntries().filter(e => e.type !== "model_usage")).toEqual(
				entries.filter(e => e.type !== "model_usage"),
			);
			console.log(`redacted routes (${resumed ? "resumed" : "fresh"}, ${result}): ${attempts.join(" -> ")}`);
		} finally {
			await controller.dispose();
			mode.stop();
			await session.dispose();
			auth.close();
			dir.removeSync();
			resetSettingsForTest();
		}
	}
});
