import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { AuthStorage, type completeSimple, Effort, type ImageContent, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ImageAttachmentEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { InspectImageTool } from "@oh-my-pi/pi-coding-agent/tools/inspect-image";
import { inspectImageToolRenderer } from "@oh-my-pi/pi-coding-agent/tools/inspect-image-renderer";
import { toolRenderers } from "@oh-my-pi/pi-coding-agent/tools/renderers";
import { removeSyncWithRetries, sanitizeText } from "@oh-my-pi/pi-utils";

const TINY_PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const TINY_SVG =
	'<svg xmlns="http://www.w3.org/2000/svg" width="12" height="7"><rect width="12" height="7" fill="red"/></svg>';

const visionModel: Model<"openai-responses"> = buildModel({
	id: "gpt-4o",
	name: "GPT-4o",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://api.openai.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 5, output: 15, cacheRead: 0.5, cacheWrite: 5 },
	contextWindow: 128000,
	maxTokens: 4096,
});

const textOnlyModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-4.1",
	input: ["text"],
};

const reasoningVisionModel: Model<"openai-responses"> = {
	...visionModel,
	id: "gpt-5-vision",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
};

interface CreateSessionOptions {
	availableModels?: Model<"openai-responses">[];
	activeModel?: Model<"openai-responses">;
	configureVisionRole?: boolean;
	imageAttachments?: ImageAttachmentEntry[];
}

interface CompleteSimpleStub {
	calls: unknown[][];
	fn: typeof completeSimple;
}

function createSession(
	cwd: string,
	model: Model<"openai-responses">,
	apiKey: string | undefined = "test-key",
	settings = Settings.isolated(),
	options: CreateSessionOptions = {},
): ToolSession {
	settings.set("images.autoResize", false);
	const availableModels = options.availableModels ?? [model];
	const activeModel = options.activeModel ?? model;
	if (options.configureVisionRole !== false) {
		settings.setModelRole("vision", `${model.provider}/${model.id}`);
	}

	const session: ToolSession = {
		cwd,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getModelString: () => `${activeModel.provider}/${activeModel.id}`,
		getActiveModelString: () => `${activeModel.provider}/${activeModel.id}`,
		settings,
		modelRegistry: {
			getAvailable: () => availableModels,
			getApiKey: async () => apiKey,
			getApiKeyForProvider: async () => apiKey,
			authStorage: { rotateSessionCredential: async () => false },
			resolver: () => async () => apiKey,
		} as unknown as NonNullable<ToolSession["modelRegistry"]>,
	};
	if (options.imageAttachments) {
		session.getImageAttachments = () => options.imageAttachments ?? [];
	}
	return session;
}

function createCompleteSimpleSuccessStub(text: string): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
			content: [{ type: "text", text }],
		};
	}) as typeof completeSimple;

	return { calls, fn };
}

function createCompleteSimpleForbiddenStub(): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		throw new Error("completeSimple should not be called");
	}) as typeof completeSimple;

	return { calls, fn };
}

function createCompleteSimpleHangingStub(): CompleteSimpleStub {
	const calls: unknown[][] = [];
	const fn = (async (...args: unknown[]) => {
		calls.push(args);
		const options = args[2] as { signal?: AbortSignal } | undefined;
		const stubSignal = options?.signal;
		await new Promise<void>(resolve => {
			if (!stubSignal) return;
			if (stubSignal.aborted) return resolve();
			stubSignal.addEventListener("abort", () => resolve(), { once: true });
		});
		return {
			role: "assistant",
			api: visionModel.api,
			provider: visionModel.provider,
			model: visionModel.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
			stopReason: "aborted",
			timestamp: Date.now(),
			content: [],
		};
	}) as unknown as typeof completeSimple;

	return { calls, fn };
}

describe("InspectImageTool", () => {
	let testDir: string;
	let imagePath: string;

	beforeAll(() => {
		testDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-inspect-image-"));
		imagePath = path.join(testDir, "screen.png");
		fs.writeFileSync(imagePath, Buffer.from(TINY_PNG_BASE64, "base64"));
	});

	afterAll(() => {
		removeSyncWithRetries(testDir);
	});

	it("sends image and question to completeSimple and returns text-only result", async () => {
		const stub = createCompleteSimpleSuccessStub("Detected text: Settings");
		const tool = new InspectImageTool(createSession(testDir, visionModel), stub.fn);
		const result = await tool.execute("call-1", {
			path: imagePath,
			question: "Extract visible UI labels.",
		});

		expect(result.content).toEqual([{ type: "text", text: "Detected text: Settings" }]);
		expect(result.details?.usage).toMatchObject({ input: 1, output: 1, totalTokens: 2 });
		expect((result.content as Array<{ type: string }>).some(c => c.type === "image")).toBe(false);
		expect(stub.calls).toHaveLength(1);

		const request = stub.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
		const userMessage = request?.messages?.[0];
		const content = userMessage?.content;
		expect(Array.isArray(content)).toBe(true);
		const contentParts = (Array.isArray(content) ? content : []) as Array<{ type: string; text?: string }>;
		expect(contentParts[0]?.type).toBe("image");
		expect(contentParts[1]).toEqual({ type: "text", text: "Extract visible UI labels." });
	});
	it("rasterizes a selected SVG before sending it to the vision model", async () => {
		const svgPath = path.join(testDir, "diagram.svg");
		fs.writeFileSync(svgPath, TINY_SVG);
		const stub = createCompleteSimpleSuccessStub("Red rectangle");
		const tool = new InspectImageTool(createSession(testDir, visionModel), stub.fn);

		const result = await tool.execute("call-svg", {
			path: `${svgPath}:img`,
			question: "Describe the diagram.",
		});

		expect(stub.calls).toHaveLength(1);
		expect(result.details?.imagePath).toBe(svgPath);
		expect(result.details?.mimeType).toBe("image/png");
	});

	it("passes the vision role's configured thinking effort into the oneshot", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("vision", `${reasoningVisionModel.provider}/${reasoningVisionModel.id}:high`);

		const stub = createCompleteSimpleSuccessStub("Red");
		const tool = new InspectImageTool(
			createSession(testDir, reasoningVisionModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [reasoningVisionModel],
			}),
			stub.fn,
		);

		await tool.execute("call-effort", {
			path: imagePath,
			question: "What dominant color is this image? One word only.",
		});

		expect(stub.calls).toHaveLength(1);
		const options = stub.calls[0]?.[2] as { reasoning?: string } | undefined;
		expect(options?.reasoning).toBe("high");
	});

	it("resolves pasted image labels from current attachments without using cwd", async () => {
		const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const stub = createCompleteSimpleSuccessStub("Attached image inspected");
		const missingCwd = path.join(testDir, "missing-cwd");
		const tool = new InspectImageTool(
			createSession(missingCwd, visionModel, "test-key", Settings.isolated({ "images.autoResize": false }), {
				imageAttachments: [
					{ label: "Image #1", uri: "attachment://1", image, sourcePath: path.join(testDir, "pasted-image.png") },
				],
			}),
			stub.fn,
		);

		const result = await tool.execute("call-attachment-label", {
			path: "Image #1",
			question: "Describe the pasted image.",
		});

		expect(result.details?.imagePath).toBe("attachment://1");
		expect(stub.calls).toHaveLength(1);
		const request = stub.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
		const attachmentContent = request?.messages?.[0]?.content;
		const attachmentParts = (Array.isArray(attachmentContent) ? attachmentContent : []) as Array<{
			type: string;
			data?: string;
		}>;
		expect(attachmentParts[0]).toMatchObject({ type: "image", data: TINY_PNG_BASE64 });
	});

	it("resolves bracketed labels and attachment URIs deterministically", async () => {
		const first: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const second: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const attachments: ImageAttachmentEntry[] = [
			{ label: "Image #1", uri: "attachment://1", image: first, sourcePath: path.join(testDir, "first.png") },
			{ label: "Image #2", uri: "attachment://2", image: second, sourcePath: path.join(testDir, "second.png") },
		];

		const bracketStub = createCompleteSimpleSuccessStub("First");
		const bracketTool = new InspectImageTool(
			createSession(testDir, visionModel, "test-key", Settings.isolated(), { imageAttachments: attachments }),
			bracketStub.fn,
		);
		const bracketResult = await bracketTool.execute("call-bracket-label", {
			path: "[Image #1, 1568x784]",
			question: "Describe the first attachment.",
		});

		const uriStub = createCompleteSimpleSuccessStub("Second");
		const uriTool = new InspectImageTool(
			createSession(testDir, visionModel, "test-key", Settings.isolated(), { imageAttachments: attachments }),
			uriStub.fn,
		);
		const uriResult = await uriTool.execute("call-uri-label", {
			path: "attachment://2",
			question: "Describe the second attachment.",
		});

		expect(bracketResult.details?.imagePath).toBe("attachment://1");
		expect(uriResult.details?.imagePath).toBe("attachment://2");
	});

	it("reports attachment-aware errors for missing image labels", async () => {
		const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const stub = createCompleteSimpleForbiddenStub();
		const tool = new InspectImageTool(
			createSession(testDir, visionModel, "test-key", Settings.isolated(), {
				imageAttachments: [
					{
						label: "Image #1",
						uri: "attachment://1",
						image,
						sourcePath: path.join(testDir, "missing-label-source.png"),
					},
				],
			}),
			stub.fn,
		);

		await expect(tool.execute("call-missing-label", { path: "Image #2", question: "Describe it." })).rejects.toThrow(
			/Available image attachments: Image #1 -> attachment:\/\/1/,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("wires createAgentSession tool sessions to live image attachments", async () => {
		const image: ImageContent = { type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" };
		const authStorage = await AuthStorage.create(path.join(testDir, "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const settings = Settings.isolated({ "compaction.enabled": false, "inspect_image.enabled": true });
		settings.setModelRole("vision", `${visionModel.provider}/${visionModel.id}`);

		try {
			const { session } = await createAgentSession({
				cwd: testDir,
				agentDir: testDir,
				sessionManager: SessionManager.inMemory(testDir),
				settings,
				model: visionModel,
				modelRegistry,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				toolNames: ["inspect_image"],
			});
			try {
				session.agent.appendMessage({
					role: "user",
					content: [{ type: "text", text: "inspect this" }, image],
					timestamp: Date.now(),
				});

				const tool = session.getToolByName("inspect_image");
				expect(tool).toBeDefined();
				const wiredToolSession = (tool as unknown as { session?: ToolSession }).session;
				const attachments = wiredToolSession?.getImageAttachments?.();
				const sourcePath = attachments?.[0]?.sourcePath;
				if (!sourcePath) {
					throw new Error("Expected attachment sourcePath to be populated");
				}
				expect(attachments).toEqual([{ label: "Image #1", uri: "attachment://1", image, sourcePath }]);
			} finally {
				await session.dispose();
			}
		} finally {
			authStorage.close();
		}
	});

	it("sends question text unchanged", async () => {
		const stub = createCompleteSimpleSuccessStub("Looks clear");
		const tool = new InspectImageTool(createSession(testDir, visionModel), stub.fn);
		await tool.execute("call-1b", { path: imagePath, question: "What warning is shown?" });

		const request = stub.calls[0]?.[1] as { messages?: Array<{ content?: unknown }> } | undefined;
		const userMessage = request?.messages?.[0];
		const content = userMessage?.content;
		const contentParts = (Array.isArray(content) ? content : []) as Array<{ type: string; text?: string }>;
		expect(contentParts[1]).toEqual({ type: "text", text: "What warning is shown?" });
	});

	it("registers custom renderer and shows question in terminal output", async () => {
		const theme = await getThemeByName("dark");
		expect(theme).toBeDefined();
		const uiTheme = theme!;
		expect(toolRenderers.inspect_image).toBeDefined();

		const callComponent = inspectImageToolRenderer.renderCall(
			{ path: "/tmp/screenshot.png", question: "What error text is visible?" },
			{ expanded: false, isPartial: false },
			uiTheme,
		);
		const callOutput = sanitizeText(callComponent.render(100).join("\n"));
		expect(callOutput).toContain("Inspect");
		expect(callOutput).toContain("Question:");
		expect(callOutput).toContain("What error text is visible?");

		const resultComponent = inspectImageToolRenderer.renderResult(
			{
				content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5" }],
				details: {
					model: "openai/gpt-4o",
					imagePath: "/tmp/screenshot.png",
					mimeType: "image/png",
				},
			},
			{ expanded: false, isPartial: false },
			uiTheme,
			{ path: "/tmp/screenshot.png", question: "What error text is visible?" },
		);
		const resultOutput = sanitizeText(resultComponent.render(100).join("\n"));
		expect(resultOutput).toContain("Inspect");
		expect(resultOutput).toContain("image/png");
		expect(resultOutput).toContain("Question:");
		expect(resultOutput).toContain("What error text is visible?");
		expect(resultOutput).toContain("openai/gpt-4o");
		expect(resultOutput).toContain("more lines");
	});

	it("schema rejects unknown parameters", () => {
		const tool = new InspectImageTool(createSession(testDir, visionModel));
		expect(tool.strict).toBe(false);
		expect(tool.parameters({ path: "img.png", question: "What is visible?" }) instanceof type.errors).toBe(false);
		expect(
			tool.parameters({ path: "img.png", question: "What is visible?", extra: "nope" }) instanceof type.errors,
		).toBe(true);
	});

	it("fails when images.blockImages is enabled", async () => {
		const stub = createCompleteSimpleForbiddenStub();
		const settings = Settings.isolated({ "images.blockImages": true });
		const tool = new InspectImageTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);

		await expect(tool.execute("call-blocked", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/Image submission is disabled/i,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("falls back to @default when vision role is unset", async () => {
		const settings = Settings.isolated();
		settings.setModelRole("default", `${visionModel.provider}/${visionModel.id}`);

		const stub = createCompleteSimpleSuccessStub("Fallback default model used");
		const tool = new InspectImageTool(
			createSession(testDir, textOnlyModel, "test-key", settings, {
				configureVisionRole: false,
				availableModels: [textOnlyModel, visionModel],
				activeModel: textOnlyModel,
			}),
			stub.fn,
		);

		const result = await tool.execute("call-1c", { path: imagePath, question: "What text is visible?" });
		expect(result.details?.model).toBe("openai/gpt-4o");
		expect(stub.calls).toHaveLength(1);
		const selectedModel = stub.calls[0]?.[0] as { id?: string } | undefined;
		expect(selectedModel?.id).toBe("gpt-4o");
	});

	it("skips text-only role fallbacks for an available vision model on the active provider", async () => {
		const stub = createCompleteSimpleSuccessStub("Vision-capable fallback used");
		const tool = new InspectImageTool(
			createSession(testDir, textOnlyModel, "test-key", Settings.isolated(), {
				configureVisionRole: false,
				availableModels: [textOnlyModel, visionModel],
				activeModel: textOnlyModel,
			}),
			stub.fn,
		);

		const result = await tool.execute("call-1d", { path: imagePath, question: "What text is visible?" });
		expect(result.details?.model).toBe("openai/gpt-4o");
		const selectedModel = stub.calls[0]?.[0] as { id?: string } | undefined;
		expect(selectedModel?.id).toBe("gpt-4o");
	});

	it("fails with actionable error when resolved model does not support image input", async () => {
		const stub = createCompleteSimpleForbiddenStub();
		const tool = new InspectImageTool(createSession(testDir, textOnlyModel), stub.fn);

		await expect(tool.execute("call-2", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/does not support image input/i,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("fails with actionable error when API key is missing", async () => {
		const stub = createCompleteSimpleForbiddenStub();
		const tool = new InspectImageTool(createSession(testDir, visionModel, ""), stub.fn);

		await expect(tool.execute("call-3", { path: imagePath, question: "What is visible?" })).rejects.toThrow(
			/No API key available/i,
		);
		expect(stub.calls).toHaveLength(0);
	});

	it("times out with a configured error when the vision-model call stalls", async () => {
		const stub = createCompleteSimpleHangingStub();
		const settings = Settings.isolated({ "inspect_image.timeoutMs": 50 });
		const tool = new InspectImageTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);
		const timeoutController = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(timeoutMs => {
			expect(timeoutMs).toBe(50);
			queueMicrotask(() => timeoutController.abort());
			return timeoutController.signal;
		});

		try {
			await expect(tool.execute("call-timeout", { path: imagePath, question: "Anything?" })).rejects.toThrow(
				/inspect_image request timed out.*inspect_image\.timeoutMs.*50ms/,
			);
		} finally {
			timeoutSpy.mockRestore();
		}
		expect(stub.calls).toHaveLength(1);
	});

	it("surfaces manual abort as aborted, not as timed out", async () => {
		const stub = createCompleteSimpleHangingStub();
		const settings = Settings.isolated({ "inspect_image.timeoutMs": 60_000 });
		const tool = new InspectImageTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);
		const controller = new AbortController();

		const pending = tool.execute("call-manual-abort", { path: imagePath, question: "Anything?" }, controller.signal);
		queueMicrotask(() => controller.abort());
		await expect(pending).rejects.toThrow(/inspect_image request aborted/);
		await expect(pending).rejects.not.toThrow(/timed out/);
		expect(stub.calls).toHaveLength(1);
	});

	it("skips the timeout guard when inspect_image.timeoutMs is zero", async () => {
		const stub = createCompleteSimpleSuccessStub("Timeout disabled path");
		const settings = Settings.isolated({ "inspect_image.timeoutMs": 0 });
		const tool = new InspectImageTool(createSession(testDir, visionModel, "test-key", settings), stub.fn);

		const result = await tool.execute("call-timeout-disabled", { path: imagePath, question: "Anything?" });
		expect(result.content).toEqual([{ type: "text", text: "Timeout disabled path" }]);
		expect(stub.calls).toHaveLength(1);
		const passed = stub.calls[0]?.[2] as { signal?: AbortSignal } | undefined;
		expect(passed?.signal).toBeUndefined();
	});
});
