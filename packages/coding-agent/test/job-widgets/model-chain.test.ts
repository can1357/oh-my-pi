import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
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
		const author = createModelJobWidgetAuthor(options);
		const request = { jobId: "job-1", brief: { kind: "bash" as const, command: "make" }, sources: [] };

		expect(await author(request, new AbortController().signal)).toEqual({ rules: [] });
		expect(sent).toEqual([primary.id, backup.id]);
		expect(costGate.spent).toBe(0.75);
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
});
