/**
 * Contract: consecutive user submissions on the same channel coalesce into a
 * single queued entry (newline-joined) instead of piling up as separate messages
 * — so rapid text/image sends read as one logical message (one pending chip, one
 * delivery, one editor-restore block).
 *
 * Non-user queued entries (skill invocations / advisor cards) still break the
 * run and keep their own identity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as imageLoading from "@oh-my-pi/pi-coding-agent/utils/image-loading";
import * as imageVisionFallback from "@oh-my-pi/pi-coding-agent/utils/image-vision-fallback";
import { Snowflake } from "@oh-my-pi/pi-utils";

describe("AgentSession queue coalescing", () => {
	let tempDir: string;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-queue-merge-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(
		responses: MockResponse[],
		modelRef: { api: Parameters<typeof getBundledModel>[0]; id: string } = {
			api: "anthropic",
			id: "claude-sonnet-4-5",
		},
		options?: {
			steeringMode?: "all" | "one-at-a-time" | "coalescing";
			followUpMode?: "all" | "one-at-a-time" | "coalescing";
		},
	): Promise<AgentSession> {
		const model = getBundledModel(modelRef.api, modelRef.id)!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"images.describeForTextModels": true,
			steeringMode: options?.steeringMode ?? "coalescing",
			followUpMode: options?.followUpMode ?? "coalescing",
		});
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey(modelRef.api, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return session;
	}

	/**
	 * Run `fn` while the session is genuinely mid-prompt (isStreaming === true), so
	 * queued messages accumulate without the idle auto-drain delivering them. The
	 * queues are cleared afterwards so the outer prompt settles with one response.
	 */
	async function duringStream<T>(target: AgentSession, fn: () => Promise<T>): Promise<T> {
		let done = false;
		let result: T | undefined;
		target.agent.setOnBeforeYield(async () => {
			if (done) return;
			done = true;
			result = await fn();
			target.agent.clearAllQueues();
		});
		await target.prompt("hello");
		return result as T;
	}

	const steeringShapes = (target: AgentSession): string[] =>
		target.agent.peekSteeringQueue().map(m => (m.role === "custom" ? m.customType : m.role));

	it("merges consecutive plain steers into one queued entry", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const steering = await duringStream(target, async () => {
			await target.steer("Line1");
			await target.steer("Line2");
			await target.steer("Line3");
			return target.getQueuedMessages().steering.slice();
		});
		expect(steering).toEqual(["Line1\nLine2\nLine3"]);
	});

	it("merges consecutive plain follow-ups into one queued entry", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const followUp = await duringStream(target, async () => {
			await target.followUp("first");
			await target.followUp("second");
			return target.getQueuedMessages().followUp.slice();
		});
		expect(followUp).toEqual(["first\nsecond"]);
	});

	it("keeps steer and follow-up channels separate", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const queued = await duringStream(target, async () => {
			await target.steer("steer one");
			await target.followUp("follow one");
			await target.steer("steer two");
			await target.followUp("follow two");
			return target.getQueuedMessages();
		});
		expect(queued.steering).toEqual(["steer one\nsteer two"]);
		expect(queued.followUp).toEqual(["follow one\nfollow two"]);
	});

	it("merges a plain steer into an image-bearing tail", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const shapes = await duringStream(target, async () => {
			target.agent.steer({
				role: "user",
				content: [
					{ type: "text", text: "look at [Image #1]" },
					{ type: "image", data: "QUJD", mimeType: "image/png" },
				],
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
			await target.steer("plain follow-up text");
			return {
				count: target.agent.peekSteeringQueue().length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(shapes.count).toBe(1);
		expect(shapes.chips).toEqual(["look at [Image #1]\nplain follow-up text"]);
		expect(shapes.restored).toEqual([
			{
				text: "look at [Image #1]\nplain follow-up text",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("merges a plain steer into an image-bearing tail that has a hidden text-model image notice", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const shapes = await duringStream(target, async () => {
			target.agent.steer({
				role: "custom",
				customType: "image-attachment-description",
				content: [{ type: "text", text: '<image path="local://image.png">described</image>' }],
				display: false,
				attribution: "user",
				timestamp: Date.now(),
			});
			target.agent.steer({
				role: "user",
				content: [
					{ type: "text", text: "look at [Image #1]" },
					{ type: "image", data: "QUJD", mimeType: "image/png" },
				],
				steering: true,
				attribution: "user",
				timestamp: Date.now(),
			});
			await target.steer("plain follow-up text");
			return {
				shapes: steeringShapes(target),
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(shapes.shapes).toEqual(["image-attachment-description", "user"]);
		expect(shapes.chips).toEqual(["look at [Image #1]\nplain follow-up text"]);
		expect(shapes.restored).toEqual([
			{
				text: "look at [Image #1]\nplain follow-up text",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("merges an image-only steer into a plain text tail", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const queued = await duringStream(target, async () => {
			await target.steer("first text");
			await target.steer("", [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
			return {
				count: target.agent.peekSteeringQueue().length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(queued.count).toBe(1);
		expect(queued.chips).toEqual(["first text\n[Image]"]);
		expect(queued.restored).toEqual([
			{
				text: "first text\n[Image]",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("does not merge a plain steer into a non-user (skill-like) tail", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const shapes = await duringStream(target, async () => {
			target.agent.steer({
				role: "custom",
				customType: "skill-prompt",
				content: "/skill:review",
				display: true,
				attribution: "user",
				timestamp: Date.now(),
			});
			await target.steer("plain follow-up text");
			return steeringShapes(target);
		});
		expect(shapes).toEqual(["skill-prompt", "user"]);
	});

	it("does not merge or restore an agent-attributed user steer", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			target.agent.steer({
				role: "user",
				content: "parent instruction",
				attribution: "agent",
				steering: true,
				timestamp: Date.now(),
			});
			await target.steer("plain user steer");
			const chips = target.getQueuedMessages().steering.slice();
			const cleared = target.clearQueue();
			return {
				shapes: steeringShapes(target),
				chips,
				cleared,
				remaining: target.agent.peekSteeringQueue().length,
			};
		});

		expect(result.shapes).toEqual(["user"]);
		expect(result.chips).toEqual(["plain user steer"]);
		expect(result.cleared.steering).toEqual([{ text: "plain user steer", images: undefined }]);
		expect(result.remaining).toBe(1);
	});

	it("merges consecutive image steers into one entry and renumbers image markers", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const queued = await duringStream(target, async () => {
			await target.steer("[Image #1, 638x450]", [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
			await target.steer("[Image #1, 638x450]", [{ type: "image", data: "REVG", mimeType: "image/png" }]);
			await target.steer("[Image #1, 638x450]", [{ type: "image", data: "R0hJ", mimeType: "image/png" }]);
			return {
				count: target.agent.peekSteeringQueue().length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(queued.count).toBe(1);
		expect(queued.chips).toEqual(["[Image #1, 638x450]\n[Image #2, 638x450]\n[Image #3, 638x450]"]);
		expect(queued.restored).toEqual([
			{
				text: "[Image #1, 638x450]\n[Image #2, 638x450]\n[Image #3, 638x450]",
				images: [
					{ type: "image", data: "QUJD", mimeType: "image/png" },
					{ type: "image", data: "REVG", mimeType: "image/png" },
					{ type: "image", data: "R0hJ", mimeType: "image/png" },
				],
			},
		]);
	});

	it("keeps hidden image-description companions when coalescing image steers for text-only models", async () => {
		vi.spyOn(imageVisionFallback, "describeAttachedImagesForTextModel")
			.mockResolvedValueOnce([{ type: "text", text: '<image path="local://first.png">first description</image>' }])
			.mockResolvedValueOnce([
				{ type: "text", text: '<image path="local://second.png">second description</image>' },
			]);
		const target = await createSession(
			[{ content: ["ok"] }],
			{ api: "aimlapi", id: "alibaba/qwen3-coder-480b-a35b-instruct" },
			{ steeringMode: "coalescing" },
		);
		const result = await duringStream(target, async () => {
			await target.steer("[Image #1]", [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
			await target.steer("[Image #1]", [{ type: "image", data: "REVG", mimeType: "image/png" }]);
			return {
				shapes: steeringShapes(target),
				companions: target.agent
					.peekSteeringQueue()
					.flatMap(message =>
						message.role === "custom" && message.customType === "image-attachment-description"
							? [message.content]
							: [],
					),
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(result.shapes).toEqual(["image-attachment-description", "image-attachment-description", "user"]);
		expect(result.companions).toEqual([
			[{ type: "text", text: '<image path="local://first.png">first description</image>' }],
			[{ type: "text", text: '<image path="local://second.png">second description</image>' }],
		]);
		expect(result.chips).toEqual(["[Image #1]\n[Image #2]"]);
		expect(result.restored).toEqual([
			{
				text: "[Image #1]\n[Image #2]",
				images: [
					{ type: "image", data: "QUJD", mimeType: "image/png" },
					{ type: "image", data: "REVG", mimeType: "image/png" },
				],
			},
		]);
	});

	it("merges an image steer after a magic-keyword prompt while keeping the hidden companion", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			await target.prompt("ultrathink go", { streamingBehavior: "steer" });
			await target.steer("[Image #1]", [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
			return {
				shapes: steeringShapes(target),
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(result.shapes).toEqual(["ultrathink-notice", "user"]);
		expect(result.chips).toEqual(["ultrathink go\n[Image #1]"]);
		expect(result.restored).toEqual([
			{
				text: "ultrathink go\n[Image #1]",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("merges a magic-keyword prompt after an image steer into one visible queued entry", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			await target.steer("[Image #1]", [{ type: "image", data: "QUJD", mimeType: "image/png" }]);
			await target.prompt("ultrathink go", { streamingBehavior: "steer" });
			return {
				shapes: steeringShapes(target),
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});
		expect(result.shapes).toEqual(["ultrathink-notice", "user"]);
		expect(result.chips).toEqual(["[Image #1]\nultrathink go"]);
		expect(result.restored).toEqual([
			{
				text: "[Image #1]\nultrathink go",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("coalesces concurrently spammed image steers before delivery", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const first = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			await Promise.all([first, second]);
			return {
				count: target.agent.peekSteeringQueue().filter(message => message.role === "user").length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.count).toBe(1);
		expect(result.chips).toEqual(["[Image #1, 216x200]\n[Image #2, 216x200]"]);
		expect(result.restored).toEqual([
			{
				text: "[Image #1, 216x200]\n[Image #2, 216x200]",
				images: [
					{ type: "image", data: "QUJD", mimeType: "image/png" },
					{ type: "image", data: "REVG", mimeType: "image/png" },
				],
			},
		]);
	});

	it("keeps magic-keyword companions attached during concurrent image steer spam", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const first = target.prompt("ultrathink [Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			await Promise.all([first, second]);
			return {
				shapes: steeringShapes(target),
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.shapes).toEqual(["ultrathink-notice", "user"]);
		expect(result.chips).toEqual(["ultrathink [Image #1, 216x200]\n[Image #2, 216x200]"]);
		expect(result.restored).toEqual([
			{
				text: "ultrathink [Image #1, 216x200]\n[Image #2, 216x200]",
				images: [
					{ type: "image", data: "QUJD", mimeType: "image/png" },
					{ type: "image", data: "REVG", mimeType: "image/png" },
				],
			},
		]);
	});

	it("coalesces concurrently spammed image follow-ups on the follow-up queue", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const first = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "followUp",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "followUp",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			await Promise.all([first, second]);
			return {
				steering: target.getQueuedMessages().steering.slice(),
				followUpCount: target.agent.peekFollowUpQueue().filter(message => message.role === "user").length,
				followUp: target.getQueuedMessages().followUp.slice(),
				restored: target.clearQueue().followUp,
			};
		});

		expect(result.steering).toEqual([]);
		expect(result.followUpCount).toBe(1);
		expect(result.followUp).toEqual(["[Image #1, 216x200]\n[Image #2, 216x200]"]);
		expect(result.restored).toEqual([
			{
				text: "[Image #1, 216x200]\n[Image #2, 216x200]",
				images: [
					{ type: "image", data: "QUJD", mimeType: "image/png" },
					{ type: "image", data: "REVG", mimeType: "image/png" },
				],
			},
		]);
	});

	it("coalesces concurrent text then image steer spam into one delivered message", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const first = target.prompt("existing steer text", { streamingBehavior: "steer" });
			const second = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			await Promise.all([first, second]);
			return {
				count: target.agent.peekSteeringQueue().filter(message => message.role === "user").length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.count).toBe(1);
		expect(result.chips).toEqual(["existing steer text\n[Image #1, 216x200]"]);
		expect(result.restored).toEqual([
			{
				text: "existing steer text\n[Image #1, 216x200]",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("coalesces concurrent image then text steer spam into one delivered message", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const first = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("text after image", { streamingBehavior: "steer" });
			await Promise.all([first, second]);
			return {
				count: target.agent.peekSteeringQueue().filter(message => message.role === "user").length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.count).toBe(1);
		expect(result.chips).toEqual(["[Image #1, 216x200]\ntext after image"]);
		expect(result.restored).toEqual([
			{
				text: "[Image #1, 216x200]\ntext after image",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			},
		]);
	});

	it("coalesces three concurrent image steers in FIFO order", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const first = target.prompt("first [Image #1]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("second [Image #1]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			const third = target.prompt("third [Image #1]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "R0hJ", mimeType: "image/png" }],
			});
			await Promise.all([first, second, third]);
			return {
				count: target.agent.peekSteeringQueue().filter(message => message.role === "user").length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.count).toBe(1);
		expect(result.chips).toEqual(["first [Image #1]\nsecond [Image #2]\nthird [Image #3]"]);
		expect(result.restored).toEqual([
			{
				text: "first [Image #1]\nsecond [Image #2]\nthird [Image #3]",
				images: [
					{ type: "image", data: "QUJD", mimeType: "image/png" },
					{ type: "image", data: "REVG", mimeType: "image/png" },
					{ type: "image", data: "R0hJ", mimeType: "image/png" },
				],
			},
		]);
	});

	it("keeps concurrent steer and follow-up image submissions in separate queues", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const result = await duringStream(target, async () => {
			const steer = target.prompt("steer [Image #1]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const followUp = target.prompt("follow-up [Image #1]", {
				streamingBehavior: "followUp",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			await Promise.all([steer, followUp]);
			const queued = target.getQueuedMessages();
			const restored = target.clearQueue();
			return { queued, restored };
		});

		expect(result.queued.steering).toEqual(["steer [Image #1]"]);
		expect(result.queued.followUp).toEqual(["follow-up [Image #1]"]);
		expect(result.restored.steering).toEqual([
			{ text: "steer [Image #1]", images: [{ type: "image", data: "QUJD", mimeType: "image/png" }] },
		]);
		expect(result.restored.followUp).toEqual([
			{ text: "follow-up [Image #1]", images: [{ type: "image", data: "REVG", mimeType: "image/png" }] },
		]);
	});

	it("serializes concurrent image submissions even when coalescing is disabled", async () => {
		const target = await createSession(
			[{ content: ["ok"] }],
			{ api: "anthropic", id: "claude-sonnet-4-5" },
			{ steeringMode: "one-at-a-time" },
		);
		const result = await duringStream(target, async () => {
			const first = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("[Image #1, 216x200]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			await Promise.all([first, second]);
			return {
				count: target.agent.peekSteeringQueue().filter(message => message.role === "user").length,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.count).toBe(2);
		expect(result.chips).toEqual(["[Image #1, 216x200]", "[Image #1, 216x200]"]);
		expect(result.restored).toEqual([
			{ text: "[Image #1, 216x200]", images: [{ type: "image", data: "QUJD", mimeType: "image/png" }] },
			{ text: "[Image #1, 216x200]", images: [{ type: "image", data: "REVG", mimeType: "image/png" }] },
		]);
	});

	it("releases the queue lock when image normalization fails", async () => {
		const target = await createSession([{ content: ["ok"] }]);

		const result = await duringStream(target, async () => {
			const realNormalize = imageLoading.normalizeModelContextImages;
			vi.spyOn(imageLoading, "normalizeModelContextImages").mockImplementation(async (images, options) => {
				if (images?.[0]?.data === "QUJD") throw new Error("normalize failed");
				return realNormalize(images, options);
			});
			const first = target.prompt("bad [Image #1]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "QUJD", mimeType: "image/png" }],
			});
			const second = target.prompt("good [Image #1]", {
				streamingBehavior: "steer",
				images: [{ type: "image", data: "REVG", mimeType: "image/png" }],
			});
			const settled = await Promise.allSettled([first, second]);
			return {
				settled,
				chips: target.getQueuedMessages().steering.slice(),
				restored: target.clearQueue().steering,
			};
		});

		expect(result.settled[0]?.status).toBe("rejected");
		expect(result.settled[1]?.status).toBe("fulfilled");
		expect(result.chips).toEqual(["good [Image #1]"]);
		expect(result.restored).toEqual([
			{ text: "good [Image #1]", images: [{ type: "image", data: "REVG", mimeType: "image/png" }] },
		]);
	});

	it("reports the coalesced text and replaced tail to prompt's onQueued for signature tracking", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const calls: Array<[string, number, string | undefined]> = [];
		const onQueued = (text: string, imageCount: number, replacedText?: string) =>
			calls.push([text, imageCount, replacedText]);
		await duringStream(target, async () => {
			await target.prompt("L1", { streamingBehavior: "steer", onQueued });
			await target.prompt("L2", { streamingBehavior: "steer", onQueued });
			await target.prompt("L3", { streamingBehavior: "steer", onQueued });
			return null;
		});
		// Each send reports the FINAL queued text and the prior tail it replaced, so the
		// caller can drop the replaced signature and record the merged one (no stale sigs).
		expect(calls).toEqual([
			["L1", 0, undefined],
			["L1\nL2", 0, "L1"],
			["L1\nL2\nL3", 0, "L1\nL2"],
		]);
	});

	it("reports replacedText through session.steer's onQueued on a coalescing merge", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const calls: Array<[string, number, string | undefined]> = [];
		const onQueued = (text: string, imageCount: number, replacedText?: string) =>
			calls.push([text, imageCount, replacedText]);
		await duringStream(target, async () => {
			await target.steer("a", undefined, onQueued);
			await target.steer("b", undefined, onQueued);
			return null;
		});
		// session.steer (the compaction-delivery path) reports the merge the same way,
		// so #deliverQueuedMessage keeps the local-submit signature set exact.
		expect(calls).toEqual([
			["a", 0, undefined],
			["a\nb", 0, "a"],
		]);
	});

	it("routes callback-less coalescing through onLocalQueueCoalesced and clears stale local signatures", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const sigs = new Set<string>(["a\u00000", "b\u00000"]); // UI recorded each per-send signature
		// Mirror the interactive-mode wiring: drop per-send + replaced (both), record merged if either was local.
		target.onLocalQueueCoalesced = (perSend, merged, replaced, perSendCount, mergedCount, replacedCount) => {
			const droppedPerSend = sigs.delete(`${perSend}\u0000${perSendCount}`);
			const droppedReplaced = sigs.delete(`${replaced}\u0000${replacedCount}`);
			if (droppedPerSend || droppedReplaced) sigs.add(`${merged}\u0000${mergedCount}`);
		};
		await duringStream(target, async () => {
			await target.steer("a"); // no onQueued: pushes (no merge, no fire)
			await target.steer("b"); // no onQueued: coalesces -> fires onLocalQueueCoalesced("b","a\nb","a",0,0,0)
			return null;
		});
		expect([...sigs]).toEqual(["a\nb\u00000"]);
	});

	it("does not mark a callback-less merge local when neither side was locally submitted (RPC/collab)", async () => {
		const target = await createSession([{ content: ["ok"] }]);
		const sigs = new Set<string>(); // nothing was locally submitted
		target.onLocalQueueCoalesced = (perSend, merged, replaced, perSendCount, mergedCount, replacedCount) => {
			const droppedPerSend = sigs.delete(`${perSend}\u0000${perSendCount}`);
			const droppedReplaced = sigs.delete(`${replaced}\u0000${replacedCount}`);
			if (droppedPerSend || droppedReplaced) sigs.add(`${merged}\u0000${mergedCount}`);
		};
		await duringStream(target, async () => {
			await target.steer("a");
			await target.steer("b");
			return null;
		});
		expect([...sigs]).toEqual([]);
	});
});

describe("AgentSession steering delivery contract", () => {
	let tempDir: string;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-steer-deliver-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		for (const authStorage of authStorages.splice(0)) {
			authStorage.close();
		}
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(responses: MockResponse[]): Promise<AgentSession> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(path.join(tempDir, `auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return session;
	}

	/**
	 * Pause mid-prompt so a steer can be queued, then RESUME the run (no clearAllQueues)
	 * so the agent dequeues the steer for the next turn and settles only once it has
	 * delivered + received the second response. Mirrors the live flow: user types a
	 * steer while streaming; once the turn ends, the steer is injected and delivered.
	 */
	async function steerMidStreamThenResume(target: AgentSession, steerText: string): Promise<void> {
		let queued = false;
		target.agent.setOnBeforeYield(async () => {
			if (queued) return;
			queued = true;
			await target.steer(steerText);
		});
		await target.prompt("start");
	}

	it("clears a delivered steer from the queue in one-at-a-time mode (no ghost in pending display)", async () => {
		// Regression: after a steer is delivered (dequeue + provider turn completes), the
		// pending-display source must be empty — otherwise the steer reappears in the UI
		// as a stale "Steer" chip even though the agent has already consumed it.
		const target = await createSession([{ content: ["ok-1"] }, { content: ["ok-2"] }]);
		await steerMidStreamThenResume(target, "queued-steer");

		// Both responses consumed: prompt("start") → "ok-1", then auto-continue with the
		// delivered steer → "ok-2". The queue must be empty.
		expect(target.agent.peekSteeringQueue()).toEqual([]);
		expect(target.getQueuedMessages().steering).toEqual([]);

		// Both turns reached the model; the steer text was delivered into state.messages.
		const deliveredTexts = target.agent.state.messages
			.filter(m => m.role === "user")
			.map(m =>
				typeof m.content === "string" ? m.content : m.content.map(b => (b.type === "text" ? b.text : "")).join(""),
			);
		expect(deliveredTexts).toContain("queued-steer");
	});
	it("delivers coalesced image steers without leaving ghosts", async () => {
		// Q1 has an image and Q2 is text-only; they should deliver as one queued
		// user turn and leave no stale pending-display source behind.
		const target = await createSession([{ content: ["ok-1"] }, { content: ["ok-2"] }, { content: ["ok-3"] }]);
		target.setSteeringMode("coalescing");
		let queued = false;
		target.agent.setOnBeforeYield(async () => {
			if (queued) return;
			queued = true;
			await Promise.all([
				target.steer("Q1 [Image #1]", [{ type: "image", data: "QUJD", mimeType: "image/png" }]),
				target.steer("Q2"),
			]);
		});
		await target.prompt("start");

		const deliveredTexts = target.agent.state.messages
			.filter(m => m.role === "user")
			.map(m =>
				typeof m.content === "string" ? m.content : m.content.map(b => (b.type === "text" ? b.text : "")).join(""),
			);
		expect(deliveredTexts).toEqual(["start", "Q1 [Image #1]\nQ2"]);
		const deliveredImageTurn = target.agent.state.messages
			.filter(m => m.role === "user")
			.find(m => Array.isArray(m.content) && m.content.some(part => part.type === "image"));
		expect(deliveredImageTurn?.content).toContainEqual({ type: "image", data: "QUJD", mimeType: "image/png" });
		expect(target.agent.peekSteeringQueue()).toEqual([]);
		expect(target.getQueuedMessages().steering).toEqual([]);
	});
});
