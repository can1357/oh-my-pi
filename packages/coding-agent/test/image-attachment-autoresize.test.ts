/**
 * Images the user attaches to a prompt, and `@file` image mentions, reach the
 * model through the same normalization step. `images.autoResize` must decide
 * whether that step resizes them; it previously always resized to 1568px.
 *
 * Failure mode if this regresses: with auto-resize off, a 3840x2160 screenshot
 * is silently downscaled to 1568x882 before it is stored in the session, so the
 * model and the transcript never see the full-size image the user kept on. The
 * same holds when that WebP is replayed to a model that cannot decode WebP.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const TINY_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function createSession(autoResize: boolean): Promise<{ session: AgentSession; mock: MockModel }> {
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
	return { session, mock };
}

/** A 3840x2160 PNG, upscaled from the tiny seed. */
async function makeLargePng(): Promise<string> {
	const seed = Buffer.from(TINY_PNG, "base64");
	const upscaled = await new Bun.Image(seed).resize(3840, 2160, { filter: "nearest" }).png().bytes();
	return Buffer.from(upscaled).toBase64();
}

/** A 2048x1024 WebP, upscaled from the tiny seed. */
async function makeLargeWebP(): Promise<string> {
	const seed = Buffer.from(TINY_PNG, "base64");
	const upscaled = await new Bun.Image(seed).resize(2048, 1024, { filter: "nearest" }).webp({ quality: 90 }).bytes();
	return Buffer.from(upscaled).toBase64();
}

async function dimensions(data: string): Promise<{ width: number; height: number }> {
	const metadata = await new Bun.Image(Buffer.from(data, "base64")).metadata();
	return { width: metadata.width, height: metadata.height };
}

/** The `[mimeType, base64]` pair of every inline image in a provider request body. */
function imageDataUrls(body: string): Array<[string, string]> {
	const pattern = new RegExp("data:(image/[a-z+.-]+);base64,([A-Za-z0-9+/=]+)", "g");
	return [...body.matchAll(pattern)].map((match): [string, string] => [match[1]!, match[2]!]);
}

/** An OpenAI-compatible vision model; `"stb"` marks a local decoder that cannot read WebP. */
function buildVisionModel(imageInputDecoder?: "stb") {
	return buildModel({
		id: "vision-test",
		name: "Vision test",
		api: "openai-completions",
		provider: "managed-primary",
		baseUrl: "http://localhost:8001/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(imageInputDecoder ? { imageInputDecoder } : {}),
	});
}

/** A one-chunk chat completion, so each provider request ends cleanly. */
function sseDone(): Response {
	const chunk = {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 0,
		model: "vision-test",
		choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
		usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

describe("image attachments honour images.autoResize", () => {
	it("keeps a directly attached image at full size when images.autoResize is off", async () => {
		const { session, mock } = await createSession(false);
		const data = await makeLargePng();

		await session.prompt("What is in this image?", { images: [{ type: "image", data, mimeType: "image/png" }] });

		// The block the stream receives, not the copy stored in session.messages.
		const sent = mock.calls[0]?.context.messages.find(message => message.role === "user");
		if (sent?.role !== "user" || typeof sent.content === "string") throw new Error("Expected user content blocks");
		const image = sent.content.find(block => block.type === "image");
		if (image?.type !== "image") throw new Error("Expected an image block in the streamed request");
		expect(image.data).toBe(data);
		expect(image.mimeType).toBe("image/png");
	});

	it("resizes a directly attached image to a 1568px longest edge when images.autoResize is on", async () => {
		const { session } = await createSession(true);
		const data = await makeLargePng();

		await session.prompt("What is in this image?", { images: [{ type: "image", data, mimeType: "image/png" }] });

		const user = session.messages.find(message => message.role === "user");
		if (user?.role !== "user" || typeof user.content === "string") throw new Error("Expected user content blocks");
		const image = user.content.find(block => block.type === "image");
		if (image?.type !== "image") throw new Error("Expected a stored image block");
		const size = await dimensions(image.data);
		expect(Math.max(size.width, size.height)).toBe(1568);
	});

	it("replays a WebP attachment at full size to a model that cannot decode WebP", async () => {
		using tempDir = TempDir.createSync("@pi-image-autoresize-replay-");
		const bodies: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
					bodies.push(String(init?.body ?? ""));
					return sseDone();
				},
				{ preconnect: globalThis.fetch.preconnect },
			),
		);
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("managed-primary", "test-key");
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "images.autoResize": false }),
			model: buildVisionModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			taskDepth: 1,
			agentId: "SubAgent",
		});
		cleanups.push(() => session.dispose());
		const data = await makeLargeWebP();

		await session.prompt("What is in this image?", { images: [{ type: "image", data, mimeType: "image/webp" }] });
		const admitted = bodies.find(body => body.includes("What is in this image?")) ?? "";
		expect(imageDataUrls(admitted)).toEqual([["image/webp", data]]);

		await session.setModel(buildVisionModel("stb"), "default", { persist: false });
		await session.prompt("Describe the earlier screenshot.");
		const replayed = bodies.find(body => body.includes("Describe the earlier screenshot.")) ?? "";
		const images = imageDataUrls(replayed);
		expect(images).toHaveLength(1);
		const [mimeType, replayedData] = images[0]!;
		expect(mimeType).not.toBe("image/webp");
		expect(await dimensions(replayedData)).toEqual({ width: 2048, height: 1024 });
	});
});
