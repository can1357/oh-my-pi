/**
 * Images the user attaches to a prompt, and `@file` image mentions, reach the
 * model through the same normalization step. `images.autoResize` must decide
 * whether that step resizes them; it previously always resized to 1568px.
 *
 * Failure mode if this regresses: with auto-resize off, a 3840x2160 screenshot
 * is silently downscaled to 1568x882 before it is stored in the session, so the
 * model and the transcript never see the full-size image the user kept on.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createSession(autoResize: boolean): Promise<AgentSession> {
	const authStorage = await AuthStorage.create(":memory:");
	cleanups.push(() => authStorage.close());
	authStorage.keys.setRuntime("anthropic", "test-key");
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"images.autoResize": autoResize,
	});
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		}),
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: new ModelRegistry(authStorage),
	});
	cleanups.push(() => session.dispose());
	return session;
}

/** A 3840x2160 PNG, upscaled from the tiny seed. */
async function makeLargePng(): Promise<string> {
	const seed = Buffer.from(TINY_PNG, "base64");
	const upscaled = await new Bun.Image(seed).resize(3840, 2160, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

async function dimensions(data: string): Promise<{ width: number; height: number }> {
	const metadata = await new Bun.Image(Buffer.from(data, "base64")).metadata();
	return { width: metadata.width, height: metadata.height };
}

describe("image attachments honour images.autoResize", () => {
	it("keeps a directly attached image at full size when images.autoResize is off", async () => {
		const session = await createSession(false);
		const data = await makeLargePng();

		await session.prompt("What is in this image?", { images: [{ type: "image", data, mimeType: "image/png" }] });

		const user = session.messages.find(message => message.role === "user");
		if (user?.role !== "user" || typeof user.content === "string") throw new Error("Expected user content blocks");
		const image = user.content.find(block => block.type === "image");
		if (image?.type !== "image") throw new Error("Expected a stored image block");
		expect(await dimensions(image.data)).toEqual({ width: 3840, height: 2160 });
	});

	it("resizes a directly attached image to a 1568px longest edge when images.autoResize is on", async () => {
		const session = await createSession(true);
		const data = await makeLargePng();

		await session.prompt("What is in this image?", { images: [{ type: "image", data, mimeType: "image/png" }] });

		const user = session.messages.find(message => message.role === "user");
		if (user?.role !== "user" || typeof user.content === "string") throw new Error("Expected user content blocks");
		const image = user.content.find(block => block.type === "image");
		if (image?.type !== "image") throw new Error("Expected a stored image block");
		const size = await dimensions(image.data);
		expect(Math.max(size.width, size.height)).toBe(1568);
	});
});
