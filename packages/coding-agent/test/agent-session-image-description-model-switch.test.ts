/**
 * Images are described for the model each request goes to, not the model active when the image
 * was sent: a switch to a text-only model describes queued and earlier images, and a switch back
 * to a vision model sends the images again without descriptions.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import * as compactionModule from "@oh-my-pi/pi-agent-core/compaction";
import type { ImageContent, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { createTestImageDescriptions } from "./helpers/image-description";

const IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
};
const QUESTION = "what is in this image?";
const DESCRIPTION = "a single red pixel";

function text(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(part => (part.type === "text" ? part.text : `[${part.type}]`)).join("");
}

describe("image descriptions follow the receiving model", () => {
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		session = undefined;
		authStorage = undefined;
		tempDir = undefined;
		vi.restoreAllMocks();
	});

	/** A session whose first turn stays open until released, so messages can queue behind it. */
	function createFixture(
		startOn: "vision" | "text-only",
		options: { description?: string; obfuscator?: SecretObfuscator } = {},
	) {
		const vision = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!vision?.input.includes("image")) throw new Error("Expected an image-capable bundled model");
		const textOnly = buildModel({
			id: "text-only-switch-test",
			name: "Text-only switch test",
			api: vision.api,
			provider: vision.provider,
			baseUrl: vision.baseUrl,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		});
		tempDir = TempDir.createSync("@pi-image-switch-");
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime(vision.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		vi.spyOn(modelRegistry, "refreshSelectedModelMetadata").mockImplementation(async model => model);
		const settings = Settings.isolated({
			// Compaction summarizes all but the latest turn, and an over-full turn compacts at once.
			"compaction.enabled": true,
			"compaction.asyncEnabled": false,
			"compaction.autoContinue": false,
			"compaction.methodOrder": ["soft"],
			"compaction.keepRecentTokens": 1,
			"todo.enabled": false,
		});
		const descriptions = createTestImageDescriptions({
			modelRegistry,
			settings,
			artifactsDir: tempDir.path(),
			description: options.description ?? DESCRIPTION,
		});

		const firstTurnStarted = Promise.withResolvers<void>();
		const releaseFirstTurn = Promise.withResolvers<void>();
		const mock = createMockModel({
			responses: [
				async () => {
					firstTurnStarted.resolve();
					await releaseFirstTurn.promise;
					return { content: ["first done"] };
				},
				{ content: ["second done"] },
				{ content: ["third done"] },
				{ content: ["fourth done"] },
			],
		});
		const requests: Array<{ model: Model; messages: Message[] }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: startOn === "vision" ? vision : textOnly,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			convertToLlm,
			transformProviderContext: descriptions.transform,
			streamFn: (model, context, options) => {
				requests.push({ model, messages: structuredClone(context.messages) });
				return mock.stream(model, context, options);
			},
		});
		const created = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			imageDescriptions: descriptions.descriptions,
			obfuscator: options.obfuscator,
		});
		session = created;
		return {
			session: created,
			vision,
			textOnly,
			requests,
			visionCalls: descriptions.calls,
			firstTurnStarted: firstTurnStarted.promise,
			releaseFirstTurn: () => releaseFirstTurn.resolve(),
		};
	}

	/** The message carrying the question in the first request sent to `model`. */
	function questionIn(requests: ReadonlyArray<{ model: Model; messages: Message[] }>, model: Model): Message {
		const request = requests.find(candidate => candidate.model.id === model.id);
		const message = request?.messages.find(candidate => text(candidate).includes(QUESTION));
		if (!message) throw new Error(`Expected a request to ${model.id} carrying the question`);
		return message;
	}

	it.each(["followUp", "steer"] as const)(
		"describes a %s queued on a vision model for the text-only model it is delivered to",
		async mode => {
			const f = createFixture("vision");
			const firstTask = f.session.prompt("start the first task");
			await f.firstTurnStarted;
			if (mode === "followUp") await f.session.followUp(QUESTION, [IMAGE]);
			else await f.session.steer(QUESTION, [IMAGE]);
			await f.session.setModel(f.textOnly);
			f.releaseFirstTurn();
			await firstTask;
			await f.session.agent.waitForIdle();

			const delivered = text(questionIn(f.requests, f.textOnly));
			expect(delivered).toContain(DESCRIPTION);
			expect(delivered).not.toContain("[image]");
			expect(f.visionCalls).toHaveLength(1);
		},
	);

	it("describes an image already in history once a text-only model takes over, and only once", async () => {
		const f = createFixture("vision");
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		expect(text(questionIn(f.requests, f.vision))).toContain("[image]");
		expect(f.visionCalls).toHaveLength(0);

		await f.session.setModel(f.textOnly);
		await f.session.prompt("and now?");
		await f.session.prompt("anything else?");

		const textOnlyRequests = f.requests.filter(request => request.model.id === f.textOnly.id);
		expect(textOnlyRequests).toHaveLength(2);
		for (const request of textOnlyRequests) {
			const question = request.messages.find(message => text(message).includes(QUESTION));
			expect(question && text(question)).toContain(DESCRIPTION);
		}
		expect(f.visionCalls).toHaveLength(1);
	});

	it("sends the image itself, undescribed, once a vision model takes over", async () => {
		const f = createFixture("text-only");
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		expect(text(questionIn(f.requests, f.textOnly))).toContain(DESCRIPTION);

		await f.session.setModel(f.vision);
		await f.session.prompt("and now?");

		const question = questionIn(f.requests, f.vision);
		expect(text(question)).toContain("[image]");
		const visionRequest = f.requests.find(request => request.model.id === f.vision.id)!;
		expect(visionRequest.messages.some(message => text(message).includes(DESCRIPTION))).toBe(false);
	});

	/** The history text each summary request would carry, as compaction serializes it. */
	function captureSummarizedText(summaryModels: string[] = []): string[] {
		const summarized: string[] = [];
		vi.spyOn(compactionModule, "compact").mockImplementation(
			async (preparation, model, _resolver, _instructions, _signal, options) => {
				const convert = options?.convertToLlm;
				if (!convert) throw new Error("Expected compaction to convert history");
				summaryModels.push(model.id);
				summarized.push(
					compactionModule.serializeConversation(
						convert([...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]),
					),
				);
				return {
					summary: "compacted",
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
					details: {},
				};
			},
		);
		return summarized;
	}

	it("summarizes an image by its description for a text-only compaction model", async () => {
		const f = createFixture("vision");
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		await f.session.prompt("and now?");
		const summarized = captureSummarizedText();

		await f.session.setModel(f.textOnly);
		await f.session.compact();

		expect(summarized).toHaveLength(1);
		expect(summarized[0]).toContain(QUESTION);
		expect(summarized[0]).toContain(DESCRIPTION);
		expect(f.visionCalls).toHaveLength(1);
	});

	it("summarizes an image by its description when a text-only model's turn fills the context", async () => {
		const f = createFixture("vision");
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		await f.session.prompt("and now?");
		const summarized = captureSummarizedText();
		await f.session.setModel(f.textOnly);
		const compacted = Promise.withResolvers<void>();
		f.session.subscribe(event => {
			if (event.type === "auto_compaction_end") compacted.resolve();
		});

		const full = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: f.textOnly.api,
			provider: f.textOnly.provider,
			model: f.textOnly.id,
			stopReason: "stop" as const,
			usage: {
				input: 195_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 196_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		f.session.agent.emitExternalEvent({ type: "message_end", message: full });
		f.session.agent.emitExternalEvent({ type: "agent_end", messages: [full] });
		await compacted.promise;

		expect(summarized).toHaveLength(1);
		expect(summarized[0]).toContain(QUESTION);
		expect(summarized[0]).toContain(DESCRIPTION);
	});

	it("summarizes a text-only session's image by its description for a compaction model that can see images", async () => {
		const f = createFixture("text-only");
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		await f.session.prompt("and now?");
		const summaryModels: string[] = [];
		const summarized = captureSummarizedText(summaryModels);
		await f.session.setModel({ ...f.textOnly, compactionModel: `${f.vision.provider}/${f.vision.id}` });

		await f.session.compact();

		expect(summaryModels).toEqual([f.vision.id]);
		expect(summarized[0]).toContain(DESCRIPTION);
		expect(f.visionCalls).toHaveLength(1);
	});

	it("redacts a secret the vision model read off an image before the summary model sees it", async () => {
		const secret = "sk-live-4f9c2e7a1b8d6053";
		const f = createFixture("text-only", {
			description: `a terminal showing the token ${secret}`,
			obfuscator: new SecretObfuscator([{ type: "plain", content: secret }]),
		});
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		await f.session.prompt("and now?");
		const summarized = captureSummarizedText();

		await f.session.compact();

		expect(summarized[0]).toContain("a terminal showing the token");
		expect(summarized[0]).not.toContain(secret);
	});

	it("summarizes an abandoned branch's image by its description for a text-only model", async () => {
		const f = createFixture("vision");
		f.releaseFirstTurn();
		await f.session.prompt("start here");
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		const summarized: string[] = [];
		vi.spyOn(compactionModule, "generateBranchSummary").mockImplementation(async (entries, options) => {
			const messages = entries.flatMap(entry => compactionModule.getMessageFromEntry(entry) ?? []);
			summarized.push(compactionModule.serializeConversation(options.convertToLlm!(messages)));
			return { summary: "summarized", readFiles: [], modifiedFiles: [] };
		});
		await f.session.setModel(f.textOnly);

		const root = f.session.sessionManager.getTree()[0]!;
		await f.session.navigateTree(root.entry.id, { summarize: true });

		expect(summarized).toHaveLength(1);
		expect(summarized[0]).toContain(QUESTION);
		expect(summarized[0]).toContain(DESCRIPTION);
	});

	it("asks for no description when the compaction model can see images", async () => {
		const f = createFixture("vision");
		f.releaseFirstTurn();
		await f.session.prompt(QUESTION, { images: [IMAGE] });
		await f.session.prompt("and now?");
		const summarized = captureSummarizedText();

		await f.session.compact();

		expect(summarized).toHaveLength(1);
		expect(summarized[0]).toContain(QUESTION);
		expect(summarized[0]).not.toContain(DESCRIPTION);
		expect(f.visionCalls).toHaveLength(0);
	});
});
