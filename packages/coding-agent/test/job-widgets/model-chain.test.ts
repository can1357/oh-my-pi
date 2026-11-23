import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { cfgOffline } from "@oh-my-pi/pi-coding-agent/config/auxiliary-model-policy";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createModelJobWidgetAuthor } from "@oh-my-pi/pi-coding-agent/job-widgets/author";
import { createModelJobCaptionWriter } from "@oh-my-pi/pi-coding-agent/job-widgets/caption";
import { CostGate } from "@oh-my-pi/pi-coding-agent/session/cost-gate";
import { createAssistantMessage } from "../helpers/agent-session-setup";
import { rejectionOf } from "../helpers/rejection";

function chainModel(id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
		api: "test-widget-chain",
		provider: "llama.cpp",
		baseUrl: "http://127.0.0.1:8080/v1",
	} as ModelSpec<Api>) as Model<Api>;
}

const primary = chainModel("widget-primary");
const backup = chainModel("widget-backup");

function failed(): AssistantMessage {
	const message = createAssistantMessage("");
	message.content = [];
	message.stopReason = "error";
	message.errorMessage = "primary route down";
	message.usage.cost.total = 0.25;
	return message;
}

function answered(text: string): AssistantMessage {
	const message = createAssistantMessage(text);
	message.usage.cost.total = 0.5;
	return message;
}

/** `widget` assigned to `primary` with `backup` as its configured fallback; `primary` always errors. */
function setup(backupReply: AssistantMessage) {
	const settings = Settings.isolated({
		modelRoles: { widget: "llama.cpp/widget-primary" },
		"retry.fallbackChains": { widget: ["llama.cpp/widget-backup"] },
	});
	const modelRegistry = {
		getAvailable: () => [primary, backup],
		getApiKey: async () => "test-key",
		resolver: () => async () => "test-key",
	} as unknown as ModelRegistry;
	const sent: string[] = [];
	vi.spyOn(ai, "completeSimple").mockImplementation(async model => {
		sent.push(model.id);
		return model.id === primary.id ? failed() : backupReply;
	});
	const costGate = new CostGate(settings, 0, () => {});
	const options = { settings, modelRegistry, sessionId: () => "sess", costGate: () => costGate };
	return { options, sent, costGate };
}

describe("job widget model chain", () => {
	afterEach(() => vi.restoreAllMocks());

	it("writes the spec with the role's fallback when the primary errors, charging both attempts", async () => {
		const { options, sent, costGate } = setup(answered('{"rules":[]}'));
		const reported: Array<{ cost: number; stopReason: string; prompt: string }> = [];
		const author = createModelJobWidgetAuthor({
			...options,
			onUsage: (message, prompt) =>
				reported.push({ cost: message.usage.cost.total, stopReason: message.stopReason, prompt }),
		});
		const request = { jobId: "job-1", brief: { kind: "bash" as const, command: "make" }, sources: [] };

		expect(await author(request, new AbortController().signal)).toEqual({ rules: [] });
		expect(sent).toEqual([primary.id, backup.id]);
		expect(costGate.spent).toBe(0.75);
		// Each attempt is reported once, with the same user turn it was sent.
		expect(reported.map(({ cost, stopReason }) => ({ cost, stopReason }))).toEqual([
			{ cost: 0.25, stopReason: "error" },
			{ cost: 0.5, stopReason: "stop" },
		]);
		expect(reported[0]!.prompt).toContain("make");
		expect(reported[1]!.prompt).toBe(reported[0]!.prompt);
	});

	it("fails with the last error once every candidate has failed", async () => {
		const backupFailure = failed();
		backupFailure.errorMessage = "backup route down";
		const { options, sent } = setup(backupFailure);
		const caption = createModelJobCaptionWriter(options);

		const error = await rejectionOf(
			caption({ kind: "bash", command: "make && make test" }, new AbortController().signal),
		);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("backup route down");
		expect(sent).toEqual([primary.id, backup.id]);
	});

	it("offline mode writes nothing unless the chain is on the session model's provider", async () => {
		const { options, sent } = setup(answered('{"rules":[]}'));
		cfgOffline.set(options.settings, true);
		let sessionProvider: string | undefined = "anthropic";
		const author = createModelJobWidgetAuthor({ ...options, getSessionProvider: () => sessionProvider });
		const request = { jobId: "job-1", brief: { kind: "bash" as const, command: "make" }, sources: [] };

		expect(await author(request, new AbortController().signal)).toBeUndefined();
		sessionProvider = undefined;
		expect(await author(request, new AbortController().signal)).toBeUndefined();
		expect(sent).toEqual([]);

		sessionProvider = "llama.cpp";
		expect(await author(request, new AbortController().signal)).toEqual({ rules: [] });
		expect(sent).toEqual([primary.id, backup.id]);
	});
});
