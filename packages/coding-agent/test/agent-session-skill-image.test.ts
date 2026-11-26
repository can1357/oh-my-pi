import { afterEach, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm, type CustomMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createTestImageDescriptions } from "./helpers/image-description";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

const skill: Pick<CustomMessage, "customType" | "content" | "display" | "attribution" | "details"> = {
	customType: "skill-prompt",
	content: [
		{ type: "text", text: "Expanded skill. What is in the image?" },
		{ type: "image", data: PNG, mimeType: "image/png" },
	],
	display: true,
	attribution: "user",
	details: { name: "review", args: "describe" },
};

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0)) await dispose();
});

/** A session on the text-only `zai/glm-5.3`, with the vision role describing images as "A red square." */
function setup() {
	const tempDir = TempDir.createSync("@skill-image-");
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("zai", "test-key");
	const registry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		modelRoles: { vision: "zai/glm-5.3-flash:max", default: "zai/glm-5.3:max" },
	});
	const descriptions = createTestImageDescriptions({
		modelRegistry: registry,
		settings,
		artifactsDir: tempDir.path(),
		description: "A red square.",
	});
	const mock = createMockModel({ handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: getBundledModel("zai", "glm-5.3"),
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		convertToLlm,
		streamFn: mock.stream,
		transformProviderContext: descriptions.transform,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry: registry,
		toolRegistry: new Map(),
	});
	cleanup.push(async () => {
		await session.dispose();
		authStorage.close();
		tempDir.removeSync();
	});
	return { session, mock, visionCalls: descriptions.calls };
}

/** The skill prompt in the request the text-only model received, with its image replaced by the description. */
function expectDescribedSkill(messages: readonly Message[] | undefined) {
	const prompt = messages?.find(message => JSON.stringify(message.content).includes("Expanded skill."));
	expect(prompt).toBeDefined();
	expect(JSON.stringify(prompt?.content)).toContain("A red square.");
	expect(JSON.stringify(prompt?.content)).not.toContain('"type":"image"');
}

it("describes a pasted image in an idle user-invoked skill for the text-only model", async () => {
	const { session, mock, visionCalls } = setup();
	await session.promptCustomMessage(skill);
	expect(visionCalls).toHaveLength(1);
	expectDescribedSkill(mock.calls[0]?.context.messages);
	// The transcript keeps the image itself.
	expect(session.messages.at(0)).toMatchObject({
		role: "custom",
		content: [{ type: "text" }, { type: "image" }],
	});
});

it("drops an image-bearing skill when aborted while its image is normalized", async () => {
	const { session, mock, visionCalls } = setup();
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const hold = spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async images => {
		if (!images?.length) return images;
		started.resolve();
		await release.promise;
		return images;
	});
	cleanup.push(async () => hold.mockRestore());

	const dispatched = session.promptCustomMessage(skill);
	await started.promise;
	await session.abort();
	release.resolve();
	await dispatched;
	await session.waitForIdle();

	expect(mock.calls).toHaveLength(0);
	expect(visionCalls).toHaveLength(0);
	expect(session.messages).toHaveLength(0);
});

it("describes a queued user-invoked skill image when it is delivered", async () => {
	const { session, mock, visionCalls } = setup();
	await session.withQueueDrainPaused(async () => {
		await session.promptCustomMessage(skill, { streamingBehavior: "followUp", queueOnly: true });
		expect(session.getQueuedMessages().followUp).toHaveLength(1);
		expect(visionCalls).toHaveLength(0);
	});
	await session.waitForIdle();
	expect(visionCalls).toHaveLength(1);
	expectDescribedSkill(mock.calls[0]?.context.messages);
});
