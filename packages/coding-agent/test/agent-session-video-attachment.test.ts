/**
 * Video source paths must reach the model without appearing in the visible
 * user bubble. The user sees `[Video #N]` plus the contact sheet; a hidden,
 * user-attributed companion gives the agent the original path for `read` frame
 * selectors.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createVideoPreviewImage } from "@oh-my-pi/pi-coding-agent/utils/video";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const SOURCE_PATH = "/tmp/private-project/demo.mp4";

describe("AgentSession video attachments", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(":memory:");
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: createMockModel({ responses: [{ content: ["Done"] }] }).stream,
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage),
		});
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
	});

	it("hides the source path from the user message while retaining it in model context", async () => {
		if (!session) throw new Error("Session was not initialized");
		const preview: ImageContent = createVideoPreviewImage(
			{ type: "image", data: TINY_PNG, mimeType: "image/png" },
			SOURCE_PATH,
		);

		await session.prompt("Review [Video #1]", { images: [preview] });

		const hidden = session.messages.find(
			message => message.role === "custom" && message.customType === "video-attachment",
		);
		expect(hidden?.role).toBe("custom");
		if (hidden?.role !== "custom") throw new Error("Expected hidden video attachment context");
		expect(hidden.display).toBe(false);
		expect(hidden.attribution).toBe("user");
		expect(hidden.content).toContain(SOURCE_PATH);

		const user = session.messages.find(message => message.role === "user");
		expect(user?.role).toBe("user");
		if (user?.role !== "user" || typeof user.content === "string") throw new Error("Expected user content blocks");
		const visibleText = user.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n");
		expect(visibleText).toBe("Review [Video #1]");
		expect(visibleText).not.toContain(SOURCE_PATH);

		const modelText: string[] = [];
		for (const message of convertToLlm(session.messages.filter(message => message.role !== "assistant"))) {
			if (typeof message.content === "string") {
				modelText.push(message.content);
				continue;
			}
			for (const block of message.content) {
				if (block.type === "text") modelText.push(block.text);
			}
		}
		expect(modelText.join("\n")).toContain(SOURCE_PATH);
	});
});
