import { afterEach, describe, expect, it } from "bun:test";
import { type AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import { generateBranchSummary, type SessionEntry } from "@oh-my-pi/pi-agent-core/compaction";
import {
	type Api,
	type AssistantMessage,
	type ImageContent,
	type Model,
	type ModelSpec,
	registerCustomApi,
	type Usage,
	unregisterCustomApis,
} from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgImagesBlockImages } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { computeNonMessageTokens } from "@oh-my-pi/pi-coding-agent/session/context-usage";
import {
	type BashExecutionMessage,
	convertToLlm,
	type FileMentionMessage,
	type PythonExecutionMessage,
	replaceLlmImagesWithText,
} from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const OUTPUT = "build step finished without warnings\n".repeat(400);
/** A screenshot whose size cannot be read, charged at the reader's full image rate. */
const SCREENSHOT: ImageContent = { type: "image", data: "A".repeat(40_000), mimeType: "image/png" };
/** A decodable one-pixel PNG, for a prompt that reads its image. */
const PIXEL: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD3sAAAAASUVORK5CYII=",
};
/** Tokens a run's `Ran` lead-in, code fences and notices add to its request, which the count leaves out. */
const FRAMING = 16;

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const tokenizer = new Tokenizer();

function bashRun(fields: Partial<BashExecutionMessage> = {}): BashExecutionMessage {
	return {
		role: "bashExecution",
		command: "cat build.log",
		output: OUTPUT,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
		...fields,
	};
}

function pythonRun(fields: Partial<PythonExecutionMessage> = {}): PythonExecutionMessage {
	return {
		role: "pythonExecution",
		code: "print(open('build.log').read())",
		output: OUTPUT,
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: 0,
		...fields,
	};
}

/** Tokens `counter` charges for the request `convertToLlm` builds from `messages`, images replaced by `placeholder`. */
function sentTokens(messages: AgentMessage[], counter: Tokenizer = tokenizer, placeholder?: string): number {
	const converted = convertToLlm(messages);
	return counter.countMessages(
		placeholder === undefined ? converted : replaceLlmImagesWithText(converted, placeholder),
	);
}

/** `count` is what the request carries, less at most the fixed framing of a run. */
function expectSent(count: number, sent: number): void {
	expect(count).toBeLessThanOrEqual(sent);
	expect(count).toBeGreaterThan(sent - FRAMING);
}

// Contract: an app role counts what the coding-agent's `convertToLlm` sends for
// it. A role counted as free let compaction and the status line read a large
// context as small; one that no request carries, counted as sent, read a small
// context as large.
describe("app-role token counts against convertToLlm", () => {
	it.each([
		["!", bashRun],
		["$", pythonRun],
	] as const)("a %s run counts its request, and nothing once kept out of context", (_prefix, run) => {
		const included = run();
		const excluded = run({ excludeFromContext: true });

		expectSent(tokenizer.countMessage(included), sentTokens([included]));
		expect(convertToLlm([excluded])).toEqual([]);
		expect(tokenizer.countMessage(excluded)).toBe(0);
	});

	// Each file goes out in its own `<file path="…">` wrapper; counting the
	// paths and contents alone left out several tokens per file, which a mention
	// of many short or empty files adds up.
	it("counts an @file mention of many short files with each file's wrapper", () => {
		const files = Array.from({ length: 40 }, (_, index) => ({
			path: `src/module-${index}.ts`,
			content: index % 2 === 0 ? "" : `export const value = ${index};`,
		}));
		const mention: FileMentionMessage = { role: "fileMention", files, timestamp: 0 };

		// The test counter rounds each counted fragment up to a whole token: under a token per file.
		expect(Math.abs(tokenizer.countMessage(mention) - sentTokens([mention]))).toBeLessThan(files.length);
	});

	it("charges a ! run's terminal image and an @file image as the user message carrying them", () => {
		const run = bashRun({ images: [SCREENSHOT] });
		const textRun = bashRun();
		const shot = { path: "screenshot.png", content: "" };
		const mention: FileMentionMessage = {
			role: "fileMention",
			files: [{ ...shot, image: SCREENSHOT }],
			timestamp: 0,
		};
		const textMention: FileMentionMessage = { role: "fileMention", files: [shot], timestamp: 0 };

		expect(tokenizer.countMessage(run) - tokenizer.countMessage(textRun)).toBe(
			sentTokens([run]) - sentTokens([textRun]),
		);
		expect(tokenizer.countMessage(mention) - tokenizer.countMessage(textMention)).toBe(
			sentTokens([mention]) - sentTokens([textMention]),
		);
	});

	// A stored custom row whose content is neither text nor blocks: the request
	// leaves it out, and counting it threw a TypeError.
	it("counts 0 for a stored custom message whose content no request carries", () => {
		const stored: AgentMessage = JSON.parse('{"role":"custom","customType":"note","display":false,"timestamp":0}');

		expect(convertToLlm([stored])).toEqual([]);
		expect(tokenizer.countMessage(stored)).toBe(0);
	});
});

// Contract: once the active model cannot read images, or `images.blockImages`
// is on, each request carries a short notice for every history image. A count
// charging the pixels instead made a few screenshots read as thousands of
// tokens the request never sent.
describe("the session's token count follows its image policy", () => {
	/** Teardown for what each test acquired, in acquisition order; run newest first. */
	const cleanups: Array<() => unknown> = [];

	afterEach(async () => {
		// Every step runs even when an earlier one throws: the session goes before the
		// SQLite auth store it reads, and the store before the directory holding its file.
		const errors: unknown[] = [];
		for (const cleanup of cleanups.splice(0).reverse()) {
			try {
				await cleanup();
			} catch (error) {
				errors.push(error);
			}
		}
		if (errors.length > 0) throw new AggregateError(errors, "image policy session teardown failed");
	}, 15_000);

	/**
	 * An SDK session on `vision`; each resource is registered for teardown as it
	 * is acquired. `countedLocally` is the status count with no provider usage to
	 * anchor on: every message counted as the next request sends it.
	 */
	async function createImagePolicySession(vision: Model = getBundledModel("anthropic", "claude-sonnet-4-5")) {
		const tempDir = TempDir.createSync("@pi-image-policy-count-");
		cleanups.push(() => tempDir.removeSync());
		const textOnly: Model = { ...vision, input: ["text"] };
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime(vision.provider, "test-key");
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			settings,
			model: vision,
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
		const countedLocally = () =>
			computeNonMessageTokens(session, session.agent.tokenizer, settings.revision) +
			session.agent.tokenizer.countMessages(session.messages);
		return { session, sessionManager, settings, vision, textOnly, countedLocally };
	}

	/** A reply to `model` whose provider usage reports `input` prompt tokens. */
	function providerReply(model: Model, input: number): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "A single red pixel." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { ...ZERO_USAGE, input, output: 5, totalTokens: input + 5 },
			stopReason: "stop",
			timestamp: Date.now(),
		};
	}

	it("counts a history image as the notice its request sends", async () => {
		const { session, settings, vision, textOnly } = await createImagePolicySession();
		const run = bashRun({ images: [SCREENSHOT] });
		const counted = () => session.agent.tokenizer.countMessage(run);

		expectSent(counted(), sentTokens([run], session.agent.tokenizer));

		session.agent.setModel(textOnly);
		expectSent(
			counted(),
			sentTokens([run], session.agent.tokenizer, "[image omitted: the active model does not support image input]"),
		);

		session.agent.setModel(vision);
		cfgImagesBlockImages.override(settings, true);
		expectSent(counted(), sentTokens([run], session.agent.tokenizer, "Image reading is disabled."));
	}, 30_000);

	// The provider's prompt usage charged each image as its request sent it.
	// Kept as the status count's anchor after the policy changed, it went on
	// reporting the pixels of images the next request sends as a notice.
	it("anchors the status count on provider usage only under the image policy it was charged under", async () => {
		const { session, settings, vision, textOnly, countedLocally } = await createImagePolicySession();
		// Far above the local count of a one-pixel image, so only the provider can report it.
		const providerPrompt = 50_000;
		session.agent.streamFn = () => {
			const stream = new AssistantMessageEventStream();
			const message = providerReply(vision, providerPrompt);
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		};
		await session.prompt("What is in this image?", { images: [PIXEL] });
		const counted = () => session.getContextUsage()?.tokens;
		const anchored = counted() ?? 0;

		expect(anchored).toBeGreaterThanOrEqual(providerPrompt);

		session.agent.setModel(textOnly);
		expect(countedLocally()).toBeLessThan(providerPrompt);
		expect(counted()).toBe(countedLocally());

		session.agent.setModel(vision);
		expect(counted()).toBe(anchored);

		cfgImagesBlockImages.override(settings, true);
		expect(counted()).toBe(countedLocally());
	}, 30_000);

	// The reply was saved under the setting read then, not the one its request
	// was converted under: turned on while the request was in flight, it marked
	// a reply charged for pixels as sent with notices, and the status count went
	// on reporting those pixels.
	it("records the image policy a request was converted under, not the one read when its reply is saved", async () => {
		const api = "test-image-policy-in-flight";
		const vision = buildModel({
			id: "local-vision-model",
			name: "Local Vision Model",
			api,
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		} as ModelSpec<Api>) as Model<Api>;
		const { session, sessionManager, settings, countedLocally } = await createImagePolicySession(vision);
		const providerPrompt = 50_000;
		registerCustomApi(
			api,
			() => {
				// The request has gone out carrying the image's pixels; the setting changes before its reply lands.
				cfgImagesBlockImages.override(settings, true);
				const stream = new AssistantMessageEventStream();
				const message = providerReply(vision, providerPrompt);
				queueMicrotask(() => {
					stream.push({ type: "done", reason: "stop", message });
					stream.end(message);
				});
				return stream;
			},
			api,
		);
		cleanups.push(() => unregisterCustomApis(api));

		await session.prompt("What is in this image?", { images: [PIXEL] });
		const saved = sessionManager.getEntries().findLast(entry => entry.type === "message");
		if (saved?.type !== "message" || saved.message.role !== "assistant") throw new Error("Expected the saved reply");

		expect(cfgImagesBlockImages.get(settings)).toBe(true);
		expect(saved.message.contextSnapshot?.imagePlaceholder).toBeNull();
		expect(countedLocally()).toBeLessThan(providerPrompt);
		expect(session.getContextUsage()?.tokens).toBe(countedLocally());
	}, 30_000);
});

const SUMMARY_MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

// Contract: the summarizer reads the branch as text, where an image is a short
// `[Image: …]` marker. Charging its pixels stopped the newest-first walk at a
// recent screenshot and left the older history out of the summary.
describe("branch summary budget", () => {
	it("keeps older history behind a ! run's terminal image", async () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "OLDER_BRANCH_FACT_20834", timestamp: 0 },
			},
			{
				type: "message",
				id: "bash-1",
				parentId: "user-1",
				timestamp: new Date(1).toISOString(),
				message: bashRun({ output: "SCREENSHOT_RUN_OUTPUT", images: [SCREENSHOT], timestamp: 1 }),
			},
		];
		let prompt = "";
		const result = await generateBranchSummary(entries, {
			// 1,000 tokens for the branch: room for its text, not for the screenshot's pixels.
			model: { ...SUMMARY_MODEL, contextWindow: 2_000 },
			reserveTokens: 1_000,
			apiKey: "mock",
			signal: new AbortController().signal,
			convertToLlm,
			completeImpl: async (_model, ctx) => {
				prompt = JSON.stringify(ctx.messages);
				return {
					role: "assistant",
					content: [{ type: "text", text: "branch summary text" }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "stop",
					timestamp: 2,
				};
			},
		});

		expect(result.summary).toContain("branch summary text");
		expect(prompt).toContain("OLDER_BRANCH_FACT_20834");
		expect(prompt).toContain("SCREENSHOT_RUN_OUTPUT");
	}, 15_000);
});
