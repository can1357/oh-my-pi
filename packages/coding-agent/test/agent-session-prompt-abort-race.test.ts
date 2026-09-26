/**
 * abort() can land while an idle prompt() is still normalizing images or
 * building the vision-model description for a text-only model — both awaits
 * complete before PromptOptions.onPromptAdmitted fires. #promptWithMessage
 * captures its own #promptGeneration snapshot fresh at entry, so without an
 * earlier check it cannot see that abort() already superseded this submission
 * and would dispatch a brand-new turn as if the abort never happened. This
 * must instead drop the prompt, matching setPromptDropped's existing
 * "abort/preflight denial raced turn setup" contract.
 */
import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";

describe("AgentSession prompt admission racing abort", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
	});

	it("drops an idle prompt instead of dispatching it when abort lands mid-normalization", async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");

		const streamCalls: string[] = [];
		const mock = createMockModel({
			responses: [
				() => {
					streamCalls.push("started");
					return { content: ["should not run"] };
				},
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
			modelRegistry,
		});

		const normalizeStarted = Promise.withResolvers<void>();
		const releaseNormalize = Promise.withResolvers<void>();
		const normalizeSpy = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
			normalizeStarted.resolve();
			await releaseNormalize.promise;
			return images;
		});

		const dropped: string[] = [];
		session.setPromptDropped(prompt => dropped.push(prompt.text));

		let admitted = false;
		const promptPromise = session.prompt("go while normalizing", {
			onPromptAdmitted: () => {
				admitted = true;
			},
		});

		try {
			await normalizeStarted.promise;
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			releaseNormalize.resolve();

			expect(await promptPromise).toBe(true);
			expect(admitted).toBe(false);
			expect(dropped).toEqual(["go while normalizing"]);
			expect(streamCalls).toEqual([]);
		} finally {
			normalizeSpy.mockRestore();
		}
	});
});
