/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig } from "@oh-my-pi/pi-agent-core/types";
import type { ImageContent, Message, TextContent } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import {
	EXTENSION_HANDLER_TIMEOUT_MS,
	ExtensionRunner,
	SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS,
	testSetExtensionHandlerTimeoutMs,
	testSetSessionShutdownHandlerTimeoutMs,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type {
	Extension,
	ExtensionError,
	ExtensionServiceTier,
	ExtensionUIContext,
	InputEvent,
	InputEventResult,
	ProviderModelConfig,
	ToolApprovalReviewEvent,
	ToolApprovalReviewResult,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";

describe("ExtensionRunner", () => {
	let tempDir: TempDir;
	let extensionsDir: string;
	let sessionManager: SessionManager;
	// Shared immutable fixtures. ModelRegistry's constructor synchronously loads
	// every bundled model and rebuilds the canonical index (~100ms); these tests
	// never mutate the registry or auth storage, so build them once per file
	// instead of paying that cost in every beforeEach.
	let sharedTempDir: TempDir;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		sharedTempDir = TempDir.createSync("@pi-runner-shared-");
		authStorage = await AuthStorage.create(path.join(sharedTempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		sharedTempDir.removeSync();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-runner-test-");
		extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		sessionManager = SessionManager.inMemory();
	});

	afterEach(() => {
		testSetExtensionHandlerTimeoutMs(EXTENSION_HANDLER_TIMEOUT_MS);
		testSetSessionShutdownHandlerTimeoutMs(SESSION_SHUTDOWN_HANDLER_TIMEOUT_MS);
		tempDir.removeSync();
	});

	const loadTestExtensions = async (configuredPaths: string[] = []) => {
		const discoveredPaths = fs
			.readdirSync(extensionsDir, { withFileTypes: true })
			.filter(entry => entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".js")))
			.map(entry => path.join(extensionsDir, entry.name))
			.sort();
		const explicitPaths = configuredPaths.map(configuredPath => path.resolve(tempDir.path(), configuredPath));
		const result = await loadExtensions([...discoveredPaths, ...explicitPaths], tempDir.path());
		const testRoots = [
			extensionsDir,
			...configuredPaths.map(configuredPath => path.resolve(tempDir.path(), configuredPath)),
		];
		const isTestScoped = (candidate: string): boolean =>
			testRoots.some(root => {
				const relative = path.relative(path.resolve(root), path.resolve(candidate));
				return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
			});
		return {
			...result,
			extensions: result.extensions.filter(extension => isTestScoped(extension.path)),
			errors: result.errors.filter(error => isTestScoped(error.path)),
		};
	};

	it("reflects SessionManager.moveTo() changes instead of the constructor-time snapshot (/move)", async () => {
		const dirA = tempDir.join("dirA");
		const dirB = tempDir.join("dirB");
		fs.mkdirSync(dirA, { recursive: true });
		fs.mkdirSync(dirB, { recursive: true });
		const movableSessionManager = SessionManager.inMemory(dirA);

		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(result.extensions, result.runtime, dirA, movableSessionManager, modelRegistry);

		expect(runner.cwd).toBe(dirA);
		expect(runner.createContext().cwd).toBe(dirA);

		await movableSessionManager.moveTo(dirB);

		expect(runner.cwd).toBe(dirB);
		expect(runner.createContext().cwd).toBe(dirB);
	});

	it("exposes the initialized host mode to extension contexts", async () => {
		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const actions = {
			sendMessage: () => {},
			sendUserMessage: () => {},
			appendEntry: () => {},
			setLabel: () => {},
			getActiveTools: () => [],
			getAllTools: () => [],
			setActiveTools: async () => {},
			getCommands: () => [],
			setModel: async () => false,
			getThinkingLevel: () => undefined,
			setThinkingLevel: () => {},
			getSessionName: () => undefined,
			setSessionName: async () => {},
		};
		const contextActions = {
			getModel: () => undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: async () => {},
			getSystemPrompt: () => [],
		};

		expect(runner.createContext().mode).toBe("print");

		runner.initialize(actions, contextActions, undefined, undefined, "rpc");
		expect(runner.createContext().mode).toBe("rpc");

		runner.initialize(actions, contextActions, undefined, undefined, "json");
		expect(runner.createContext().mode).toBe("json");

		runner.initialize(actions, contextActions, undefined, undefined, "tui");
		expect(runner.createContext().mode).toBe("tui");
	});

	it("uses required context actions when command actions are unavailable", async () => {
		const result = await loadTestExtensions();
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);
		const usage = { tokens: 1200, contextWindow: 8000, percent: 15 };
		const compact = vi.fn(async () => {});

		runner.initialize(
			{
				sendMessage: () => {},
				sendUserMessage: () => {},
				appendEntry: () => {},
				setLabel: () => {},
				getActiveTools: () => [],
				getAllTools: () => [],
				setActiveTools: async () => {},
				getCommands: () => [],
				setModel: async () => false,
				getThinkingLevel: () => undefined,
				setThinkingLevel: () => {},
				getSessionName: () => undefined,
				setSessionName: async () => {},
			},
			{
				getModel: () => undefined,
				isIdle: () => true,
				abort: () => {},
				hasPendingMessages: () => false,
				shutdown: () => {},
				getContextUsage: () => usage,
				compact,
				getSystemPrompt: () => [],
			},
		);

		expect(runner.createContext().getContextUsage()).toEqual(usage);
		await runner.createContext().compact("preserve current task");
		expect(compact).toHaveBeenCalledWith("preserve current task");
	});

	describe("shortcut conflicts", () => {
		it("warns when extension shortcut conflicts with built-in", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+c", {
						description: "Conflicts with built-in",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+c")).toBe(false);

			warnSpy.mockRestore();
		});

		it("rejects ctrl+q so it cannot shadow the app.message.followUp default (#1903)", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("ctrl+q", {
						description: "Tries to bind the follow-up chord",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict-q.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			// Contract: ctrl+q is reserved because it is now a default chord for
			// app.message.followUp. Without this guard, InputController registers
			// the extension shortcut first and the follow-up handler silently
			// overwrites it in the editor's custom-key map.
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("ctrl+q")).toBe(false);

			warnSpy.mockRestore();
		});

		it("rejects Alt+M so it cannot shadow the app.model.select default", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerShortcut("alt+m", {
						description: "Tries to bind model select",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "conflict-model.ts"), extCode);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("conflicts with built-in"), expect.any(Object));
			expect(shortcuts.has("alt+m")).toBe(false);

			warnSpy.mockRestore();
		});

		it("warns when two extensions register same shortcut", async () => {
			// Use a non-reserved shortcut
			const extCode1 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "First extension",
						handler: async () => {},
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.registerShortcut("ctrl+shift+x", {
						description: "Second extension",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "ext2.ts"), extCode2);

			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const shortcuts = runner.getShortcuts();

			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("shortcut conflict"), expect.any(Object));
			// Last one wins
			expect(shortcuts.has("ctrl+shift+x")).toBe(true);

			warnSpy.mockRestore();
		});
	});

	describe("tool collection", () => {
		it("collects tools from multiple extensions", async () => {
			const toolCode = (name: string) => `
				export default function(pi) {
					const { Type } = pi.typebox;
					pi.registerTool({
						name: "${name}",
						label: "${name}",
						description: "Test tool",
						parameters: Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-a.ts"), toolCode("tool_a"));
			fs.writeFileSync(path.join(extensionsDir, "tool-b.ts"), toolCode("tool_b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const tools = runner.getAllRegisteredTools();

			expect(tools.length).toBe(2);
			expect(tools.map(t => t.definition.name).sort()).toEqual(["tool_a", "tool_b"]);
		});
	});

	describe("command collection", () => {
		it("collects commands from multiple extensions", async () => {
			const cmdCode = (name: string) => `
				export default function(pi) {
					pi.registerCommand("${name}", {
						description: "Test command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd-a.ts"), cmdCode("cmd-a"));
			fs.writeFileSync(path.join(extensionsDir, "cmd-b.ts"), cmdCode("cmd-b"));

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const commands = runner.getRegisteredCommands();

			expect(commands.length).toBe(2);
			expect(commands.map(c => c.name).sort()).toEqual(["cmd-a", "cmd-b"]);
		});

		it("gets command by name", async () => {
			const cmdCode = `
				export default function(pi) {
					pi.registerCommand("my-cmd", {
						description: "My command",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "cmd.ts"), cmdCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const cmd = runner.getCommand("my-cmd");
			expect(cmd).toBeDefined();
			expect(cmd?.name).toBe("my-cmd");
			expect(cmd?.description).toBe("My command");

			const missing = runner.getCommand("not-exists");
			expect(missing).toBeUndefined();
		});

		it("prefers later-loaded explicit extensions for conflicting commands", async () => {
			const deployCommand = (description: string) => `
				export default function(pi) {
					pi.registerCommand("deploy", {
						description: "${description}",
						handler: async () => {},
					});
				}
			`;

			fs.writeFileSync(path.join(extensionsDir, "discovered-deploy.ts"), deployCommand("Discovered deploy"));
			const explicitExtensionPath = path.join(tempDir.path(), "explicit-deploy.ts");
			fs.writeFileSync(explicitExtensionPath, deployCommand("Explicit deploy"));

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const commands = runner.getRegisteredCommands();
			expect(commands).toHaveLength(1);
			expect(commands[0]?.description).toBe("Explicit deploy");

			const command = runner.getCommand("deploy");
			expect(command?.description).toBe("Explicit deploy");
		});
	});

	describe("error handling", () => {
		it("calls error listeners when handler throws", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("context", async () => {
						throw new Error("Handler error!");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "throws.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			// Emit context event which will trigger the throwing handler
			await runner.emitContext([]);

			expect(errors.length).toBe(1);
			expect(errors[0].error).toContain("Handler error!");
			expect(errors[0].event).toBe("context");
		});
	});

	describe("message renderers", () => {
		it("gets message renderer by type", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerMessageRenderer("my-type", (message, options, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const renderer = runner.getMessageRenderer("my-type");
			expect(renderer).toBeDefined();

			const missing = runner.getMessageRenderer("not-exists");
			expect(missing).toBeUndefined();
		});

		it("collects assistant thinking renderers", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerAssistantThinkingRenderer((context, theme) => null);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "thinking-renderer.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.getAssistantThinkingRenderers().length).toBe(1);
		});
	});

	describe("composer shapes", () => {
		it("collects extension-defined renderer contracts and selector copy", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerComposerShape({
						label: "Extension Dock",
						description: "Custom extension composer",
						style: {
							id: "extension-dock",
							sideBorders: false,
							verticalChrome: 0,
							statusAttachment: "none",
							bottomBar: "full",
							bottomBarGap: false,
							defaultPaddingX: () => 0,
							sideChromeWidth: () => 0,
							renderTop: () => undefined,
							renderRow: context => [context.gutter + context.text + context.pad],
							renderBottom: () => undefined,
						},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "composer-shape.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const [definition] = runner.getComposerShapes();
			expect(definition.label).toBe("Extension Dock");
			expect(definition.description).toBe("Custom extension composer");
			expect(definition.style.id).toBe("extension-dock");
		});
	});
	describe("flags", () => {
		it("collects flags from extensions", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--my-flag", {
						description: "My flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "with-flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const flags = runner.getFlags();

			expect(flags.has("--my-flag")).toBe(true);
		});

		it("can set flag values", async () => {
			const extCode = `
				export default function(pi) {
					pi.registerFlag("--test-flag", {
						description: "Test flag",
						handler: async () => {},
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "flag.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Setting a flag value should not throw
			runner.setFlagValue("--test-flag", true);

			// The flag values are stored in the shared runtime
			expect(result.runtime.flagValues.get("--test-flag")).toBe(true);
		});
	});

	describe("before_provider_request chaining", () => {
		it("exposes the request model instead of the primary session model", async () => {
			const primaryModel = getBundledModel("openai-codex", "gpt-5.6-sol");
			const requestModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!primaryModel || !requestModel) throw new Error("Expected bundled cross-provider models to exist");

			const extCode = `
				export default function(pi) {
					pi.on("before_provider_request", async (_event, ctx) => {
						const current = ctx.models.current();
						return {
							model: ctx.model && {
								provider: ctx.model.provider,
								id: ctx.model.id,
								api: ctx.model.api,
							},
							current: current && {
								provider: current.provider,
								id: current.id,
								api: current.api,
							},
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "request-model.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => primaryModel,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			const payload = await runner.emitBeforeProviderRequest({}, requestModel);

			const expected = {
				provider: requestModel.provider,
				id: requestModel.id,
				api: requestModel.api,
			};
			expect(payload).toEqual({ model: expected, current: expected });
		});

		it("chains payload replacements across handlers in load order", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext1"] };
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { chain?: string[] };
						return { ...payload, chain: [...(payload.chain ?? []), "ext2"] };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const payload = await runner.emitBeforeProviderRequest({ chain: ["base"] });
			expect(payload).toEqual({ chain: ["base", "ext1", "ext2"] });
		});

		it("keeps chaining after handler errors", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("before_provider_request", async () => {
						throw new Error("payload failed");
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("before_provider_request", async (event) => {
						const payload = event.payload as { preserved?: boolean };
						return { ...payload, preserved: true };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "payload-error.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "payload-ok.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			const payload = await runner.emitBeforeProviderRequest({ original: true });
			expect(payload).toEqual({ original: true, preserved: true });
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("before_provider_request");
			expect(errors[0]?.error).toContain("payload failed");
		});
	});

	describe("after_provider_response", () => {
		it("calls handlers with response metadata and reports handler errors without throwing", async () => {
			const eventsPath = path.join(tempDir.path(), "after-provider-response-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							status: event.status,
							headers: event.headers,
							requestId: event.requestId,
							metadata: event.metadata,
						}) + "\\n",
					);
				});

				pi.on("after_provider_response", async () => {
					throw new Error("response failed");
				});

				pi.on("after_provider_response", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({ afterError: event.status }) + "\\n",
					);
				});
			}
		`;
			fs.writeFileSync(path.join(extensionsDir, "after-provider-response.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			await runner.emitAfterProviderResponse({
				status: 202,
				headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
				requestId: "req_123",
				metadata: { provider: "test" },
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					status: 202,
					headers: { "x-request-id": "req_123", "content-type": "text/event-stream" },
					requestId: "req_123",
					metadata: { provider: "test" },
				},
				{ afterError: 202 },
			]);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("after_provider_response");
			expect(errors[0]?.error).toContain("response failed");
		});

		it("exposes the response model instead of the primary session model", async () => {
			const primaryModel = getBundledModel("openai-codex", "gpt-5.6-sol");
			const requestModel = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!primaryModel || !requestModel) throw new Error("Expected bundled cross-provider models to exist");

			const eventsPath = path.join(tempDir.path(), "after-provider-response-model.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("after_provider_response", async (_event, ctx) => {
						const current = ctx.models.current();
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({
								model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id },
								current: current && { provider: current.provider, id: current.id },
							}) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "after-response-model.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => primaryModel,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emitAfterProviderResponse(
				{ status: 402, headers: {}, requestId: "req_402", metadata: { provider: requestModel.provider } },
				requestModel,
			);

			const expected = { provider: requestModel.provider, id: requestModel.id };
			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([{ model: expected, current: expected }]);
		});
	});

	describe("session_stop", () => {
		it("invokes handlers with completed main-session messages and returns continuation feedback", async () => {
			const eventsPath = path.join(tempDir.path(), "session-stop-events.jsonl");
			const extCode = `
			import * as fs from "node:fs";

			export default function(pi) {
				pi.on("session_stop", async (event) => {
					fs.appendFileSync(
						${JSON.stringify(eventsPath)},
						JSON.stringify({
							type: event.type,
							messages: event.messages,
							turn_id: event.turn_id,
							last_assistant_message: event.last_assistant_message,
							session_id: event.session_id,
							session_file: event.session_file,
							stop_hook_active: event.stop_hook_active,
						}) + "\\n",
					);
					return { continue: true, additionalContext: "Run one more pass." };
				});
			}
		`;
			await Bun.write(path.join(extensionsDir, "session-stop.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const completedMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "main session finished" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 123,
			};

			const stopResult = await runner.emitSessionStop({
				messages: [completedMessage],
				turn_id: 2,
				last_assistant_message: completedMessage,
				session_id: "session-123",
				session_file: "/tmp/session.jsonl",
				stop_hook_active: false,
				signal: new AbortController().signal,
			});

			const events = (await Bun.file(eventsPath).text())
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					type: "session_stop",
					messages: [completedMessage],
					turn_id: 2,
					last_assistant_message: completedMessage,
					session_id: "session-123",
					session_file: "/tmp/session.jsonl",
					stop_hook_active: false,
				},
			]);
			expect(stopResult).toEqual({ continue: true, additionalContext: "Run one more pass." });
		});

		it("skips cancelled handlers, releases in-flight handlers, and preserves timeout errors", async () => {
			const extensionPath = path.join(tempDir.path(), "cancel-session-stop.ts");
			const startedPath = path.join(tempDir.path(), "session-stop-started.txt");
			await Bun.write(
				extensionPath,
				`
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("session_stop", async () => {
						fs.writeFileSync(${JSON.stringify(startedPath)}, "started");
						await Promise.withResolvers().promise;
					});
				}
			`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: ExtensionError[] = [];
			runner.onError(error => errors.push(error));
			testSetExtensionHandlerTimeoutMs(100);
			const controller = new AbortController();
			const preAborted = new AbortController();
			preAborted.abort();
			await expect(
				runner.emitSessionStop({
					messages: [],
					turn_id: 0,
					session_id: "session-123",
					stop_hook_active: false,
					signal: preAborted.signal,
				}),
			).resolves.toBeUndefined();
			expect(await Bun.file(startedPath).exists()).toBe(false);

			const emission = runner.emitSessionStop({
				messages: [],
				turn_id: 0,
				session_id: "session-123",
				stop_hook_active: false,
				signal: controller.signal,
			});
			expect(await Bun.file(startedPath).text()).toBe("started");
			controller.abort();

			await expect(emission).resolves.toBeUndefined();
			expect(errors).toEqual([]);

			// A non-cancelled handler still exercises the production timer and reports its timeout.
			testSetExtensionHandlerTimeoutMs(10);
			await expect(
				runner.emitSessionStop({
					messages: [],
					turn_id: 1,
					session_id: "session-123",
					stop_hook_active: false,
					signal: new AbortController().signal,
				}),
			).resolves.toBeUndefined();
			expect(errors).toEqual([
				{
					extensionPath,
					event: "session_stop",
					error: "handler timed out after 10ms",
				},
			]);
		});

		it("observes a session_stop signal aborted synchronously by the handler", async () => {
			const extensionPath = path.join(tempDir.path(), "self-cancel-session-stop.ts");
			await Bun.write(
				extensionPath,
				`
				export default function(pi) {
					pi.on("session_stop", async (_event, ctx) => {
						ctx.abort();
						await Promise.withResolvers().promise;
					});
				}
			`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const controller = new AbortController();
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => controller.abort(),
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);
			vi.useFakeTimers();
			try {
				testSetExtensionHandlerTimeoutMs(100);
				const emission = runner.emitSessionStop({
					messages: [],
					turn_id: 0,
					session_id: "session-123",
					stop_hook_active: false,
					signal: controller.signal,
				});
				let settled = false;
				void emission.then(() => {
					settled = true;
				});
				for (let attempts = 0; attempts < 10 && !settled; attempts++) {
					await Promise.resolve();
				}

				expect(controller.signal.aborted).toBe(true);
				expect(settled).toBe(true);
				await emission;
			} finally {
				vi.useRealTimers();
			}
		});
		it("continues to later handlers after empty continuation feedback", async () => {
			await Bun.write(
				path.join(extensionsDir, "session-stop-empty.ts"),
				`
				export default function(pi) {
					pi.on("session_stop", async () => ({ continue: true }));
					pi.on("session_stop", async () => ({ decision: "block", reason: "Continue from second handler." }));
				}
			`,
			);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const completedMessage: AgentMessage = {
				role: "assistant",
				content: [{ type: "text", text: "main session finished" }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: 123,
			};

			await expect(
				runner.emitSessionStop({
					messages: [completedMessage],
					turn_id: 0,
					last_assistant_message: completedMessage,
					signal: new AbortController().signal,
					session_id: "session-123",
					session_file: "/tmp/session.jsonl",
					stop_hook_active: false,
				}),
			).resolves.toEqual({ decision: "block", reason: "Continue from second handler." });
		});
	});

	describe("tool_result chaining", () => {
		it("chains content modifications across handlers", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext1" }],
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async (event) => {
						return {
							content: [...event.content, { type: "text", text: "ext2" }],
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-1",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toBeDefined();
			const chainedContent = chained?.content;
			expect(chainedContent).toBeDefined();
			expect(chainedContent![0]).toEqual({ type: "text", text: "base" });
			expect(chainedContent).toHaveLength(3);
			const appendedText = chainedContent!
				.slice(1)
				.filter((item): item is { type: "text"; text: string } => item.type === "text")
				.map(item => item.text);
			expect(appendedText.sort()).toEqual(["ext1", "ext2"]);
		});

		it("preserves previous modifications when later handlers return partial patches", async () => {
			const extCode1 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							content: [{ type: "text", text: "first" }],
							details: { source: "ext1" },
						};
					});
				}
			`;
			const extCode2 = `
				export default function(pi) {
					pi.on("tool_result", async () => {
						return {
							isError: true,
						};
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-1.ts"), extCode1);
			fs.writeFileSync(path.join(extensionsDir, "tool-result-partial-2.ts"), extCode2);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const chained = await runner.emitToolResult({
				type: "tool_result",
				toolName: "my_tool",
				toolCallId: "call-2",
				input: {},
				content: [{ type: "text", text: "base" }],
				details: { initial: true },
				isError: false,
			});

			expect(chained).toEqual({
				content: [{ type: "text", text: "first" }],
				details: { source: "ext1" },
				isError: true,
			});
		});
	});

	describe("tool_result rewrite of thrown failures", () => {
		const throwingTool: AgentTool = {
			name: "boom",
			label: "Boom",
			description: "always throws",
			parameters: {} as never,
			execute: async () => {
				throw new Error("original explosion");
			},
		};

		const okTool: AgentTool = {
			name: "fine",
			label: "Fine",
			description: "always succeeds",
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text" as const, text: "success" }] }),
		};

		const firstText = (result: { content: readonly (TextContent | ImageContent)[] }): string | undefined => {
			const block = result.content[0];
			return block?.type === "text" ? block.text : undefined;
		};

		const runnerFor = async (extCode: string): Promise<ExtensionRunner> => {
			fs.writeFileSync(path.join(extensionsDir, "rewrite.ts"), extCode);
			const result = await loadTestExtensions();
			return new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);
		};

		it("surfaces replacement content while keeping the call an error", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", (event) => {
						if (!event.isError) return;
						return {
							content: [{ type: "text", text: "Enriched recovery guidance" }],
							details: { enriched: true },
							isError: true,
						};
					});
				}
			`);
			const wrapper = new ExtensionToolWrapper(throwingTool, runner);
			const res = await wrapper.execute("call-rewrite", {} as never, undefined, undefined, undefined);
			expect(firstText(res)).toBe("Enriched recovery guidance");
			expect(res.isError).toBe(true);
			expect(res.details).toEqual({ enriched: true });
		});

		it("preserves the original exception when no handler modifies the result", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", () => {});
				}
			`);
			const wrapper = new ExtensionToolWrapper(throwingTool, runner);
			await expect(wrapper.execute("call-untouched", {} as never, undefined, undefined, undefined)).rejects.toThrow(
				"original explosion",
			);
		});

		it("converts a failure to success when a handler clears isError", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", (event) => {
						if (!event.isError) return;
						return { content: [{ type: "text", text: "recovered" }], isError: false };
					});
				}
			`);
			const wrapper = new ExtensionToolWrapper(throwingTool, runner);
			const res = await wrapper.execute("call-cleared", {} as never, undefined, undefined, undefined);
			expect(firstText(res)).toBe("recovered");
			expect(res.isError).toBeUndefined();
		});

		it("marks a successful result as an error when a handler sets isError", async () => {
			const runner = await runnerFor(`
				export default function(pi) {
					pi.on("tool_result", () => ({
						content: [{ type: "text", text: "now failing" }],
						isError: true,
					}));
				}
			`);
			const wrapper = new ExtensionToolWrapper(okTool, runner);
			const res = await wrapper.execute("call-flagged", {} as never, undefined, undefined, undefined);
			expect(firstText(res)).toBe("now failing");
			expect(res.isError).toBe(true);
		});
	});

	describe("handler timeouts", () => {
		const initializeRunner = (runner: ExtensionRunner, uiContext: ExtensionUIContext): void => {
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
				undefined,
				uiContext,
			);
		};

		it("times out session_start handlers, emits an error, and continues to sibling extensions", async () => {
			const hangExtensionPath = path.join(tempDir.path(), "hang-session-start.ts");
			const fastExtensionPath = path.join(tempDir.path(), "fast-session-start.ts");
			const markerPath = path.join(tempDir.path(), "session-start-marker.txt");
			fs.writeFileSync(
				hangExtensionPath,
				`
					export default function(pi) {
						pi.on("session_start", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);
			fs.writeFileSync(
				fastExtensionPath,
				`
					import * as fs from "node:fs";

					export default function(pi) {
						pi.on("session_start", async () => {
							fs.appendFileSync(${JSON.stringify(markerPath)}, "fast\\n");
						});
					}
				`,
			);

			const result = await loadTestExtensions([hangExtensionPath, fastExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});
			testSetExtensionHandlerTimeoutMs(10);

			const startedAt = performance.now();
			await runner.emit({ type: "session_start" });
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(150);
			expect(fs.readFileSync(markerPath, "utf8")).toBe("fast\n");
			expect(warnSpy).toHaveBeenCalledWith("Extension handler timed out", {
				extensionPath: hangExtensionPath,
				event: "session_start",
				timeoutMs: 10,
			});
			expect(errors).toEqual([
				{
					extensionPath: hangExtensionPath,
					event: "session_start",
					error: "handler timed out after 10ms",
				},
			]);

			warnSpy.mockRestore();
		});

		it("keeps a stalled registration inside the session_shutdown deadline", async () => {
			const extensionPath = path.join(tempDir.path(), "shutdown-registration.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("session_shutdown", () => {
							const { Type } = pi.typebox;
							pi.registerTool({
								name: "shutdown_tool",
								label: "Shutdown Tool",
								description: "Registered while shutting down.",
								parameters: Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
							});
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.onToolRegistered(() => Promise.withResolvers<void>().promise);
			const errors: ExtensionError[] = [];
			runner.onError(error => {
				errors.push(error);
			});
			testSetSessionShutdownHandlerTimeoutMs(10);

			const startedAt = performance.now();
			await runner.emit({ type: "session_shutdown" });
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(150);
			expect(errors).toContainEqual({
				extensionPath,
				event: "session_shutdown",
				error: "handler timed out after 10ms",
			});
		});

		it("uses the configured tool_call timeout and fails closed so a hung extension cannot block execution (#3948)", async () => {
			const hangExtensionPath = path.join(tempDir.path(), "hang-tool-call.ts");
			fs.writeFileSync(
				hangExtensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);

			const result = await loadTestExtensions([hangExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
				undefined,
				Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": 10 }),
			);
			const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});
			const executeCalls: unknown[] = [];
			const tool: AgentTool = {
				name: "sleepy",
				label: "Sleepy",
				description: "records execute() invocations",
				parameters: Type.Object({}),
				strict: true,
				execute: async (_id, params) => {
					executeCalls.push(params);
					return { content: [{ type: "text", text: "ran" }] };
				},
			};
			const wrapped = new ExtensionToolWrapper(tool, runner);

			const startedAt = performance.now();
			await expect(wrapped.execute("tool-call-id", {})).rejects.toThrow(
				`Extension ${hangExtensionPath} timed out after 10ms`,
			);
			const elapsedMs = performance.now() - startedAt;

			expect(elapsedMs).toBeGreaterThanOrEqual(8);
			expect(elapsedMs).toBeLessThan(500);
			// Fail-closed: the underlying tool MUST NOT run when a gate handler timed out.
			expect(executeCalls).toEqual([]);
			expect(warnSpy).toHaveBeenCalledWith("Extension handler timed out", {
				extensionPath: hangExtensionPath,
				event: "tool_call",
				timeoutMs: 10,
			});
			expect(errors).toEqual([
				{
					extensionPath: hangExtensionPath,
					event: "tool_call",
					error: "handler timed out after 10ms",
				},
			]);

			warnSpy.mockRestore();
		});

		it("falls back to the default tool_call timeout for invalid configured values", async () => {
			const extensionPath = path.join(tempDir.path(), "invalid-timeout-tool-call.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async () => {
							await Promise.withResolvers().promise;
						});
					}
				`,
			);
			const loaded = await loadTestExtensions([extensionPath]);

			vi.useFakeTimers();
			try {
				for (const configuredTimeout of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
					const runner = new ExtensionRunner(
						loaded.extensions,
						loaded.runtime,
						tempDir.path(),
						sessionManager,
						modelRegistry,
						undefined,
						Settings.isolated({ "extensionHandlers.toolCallTimeoutMs": configuredTimeout }),
					);
					let settled = false;
					const decision = runner
						.emitToolCall({
							type: "tool_call",
							toolName: "guarded",
							toolCallId: "invalid-timeout-call",
							input: {},
						})
						.then(result => {
							settled = true;
							return result;
						});

					vi.advanceTimersByTime(EXTENSION_HANDLER_TIMEOUT_MS - 1);
					expect(settled).toBe(false);

					vi.advanceTimersByTime(1);
					await Promise.resolve();
					await Promise.resolve();
					vi.advanceTimersByTime(0);
					expect(await decision).toEqual({
						block: true,
						reason: `Extension ${extensionPath} timed out after ${EXTENSION_HANDLER_TIMEOUT_MS}ms`,
					});
				}
			} finally {
				vi.useRealTimers();
			}
		});

		it("fails closed when a tool_call handler registration cannot activate", async () => {
			const extensionPath = path.join(tempDir.path(), "tool-call-registration.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", () => {
							const { Type } = pi.typebox;
							pi.registerTool({
								name: "tool_call_registered",
								label: "Tool Call Registered",
								description: "Registered from a tool-call hook.",
								parameters: Type.Object({}),
								execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
							});
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.onToolRegistered(async () => {
				throw new Error("expected tool-call registration failure");
			});
			const errors: ExtensionError[] = [];
			runner.onError(error => {
				errors.push(error);
			});
			const executeCalls: unknown[] = [];
			const wrapped = new ExtensionToolWrapper(
				{
					name: "gated",
					label: "Gated",
					description: "Must not execute after a gate registration fails.",
					parameters: Type.Object({}),
					execute: async (_id, params) => {
						executeCalls.push(params);
						return { content: [{ type: "text", text: "ran" }] };
					},
				},
				runner,
			);

			await expect(wrapped.execute("tool-call-id", {})).rejects.toThrow(
				`Extension ${extensionPath} failed: expected tool-call registration failure`,
			);
			expect(executeCalls).toEqual([]);
			expect(errors).toContainEqual({
				extensionPath,
				event: "tool_call",
				error: "expected tool-call registration failure",
				stack: expect.any(String),
			});
		});

		it("does not charge detached registrations to unrelated tool-call handlers", async () => {
			const extensionPath = path.join(tempDir.path(), "detached-registration-barrier.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						const { Type } = pi.typebox;
						pi.registerTool({
							name: "detached_source_tool",
							label: "Detached Source Tool",
							description: "Provides a registration event for the detached barrier test.",
							parameters: Type.Object({}),
							execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
						});
						pi.on("tool_call", () => undefined);
					}
				`,
			);

			const loaded = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.onToolRegistered(() => Promise.withResolvers<void>().promise);
			const extension = loaded.extensions[0];
			const registrationListener = extension?.toolRegistrationListeners?.values().next().value;
			if (!registrationListener) throw new Error("expected registration listener");
			registrationListener("detached_source_tool");

			const errors: ExtensionError[] = [];
			runner.onError(error => {
				errors.push(error);
			});
			testSetExtensionHandlerTimeoutMs(10);

			const result = await runner.emitToolCall({
				type: "tool_call",
				toolName: "unrelated",
				toolCallId: "unrelated-call",
				input: {},
			});

			expect(result).toBeUndefined();
			expect(errors).toEqual([]);
		});

		it("pauses a tool_call handler timeout during standard and custom dialogs, then resumes its budget", async () => {
			const extensionPath = path.join(tempDir.path(), "confirm-tool-call.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async (_event, ctx) => {
							ctx.ui.notify("Waiting for confirmation");
							await new Promise(resolve => setTimeout(resolve, 8));
							await ctx.ui.confirm("High-risk command", "Allow this command?");
							await ctx.ui.custom(() => ({}));
							ctx.ui.notify("Custom settled");
							await Promise.withResolvers().promise;
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const dialog = Promise.withResolvers<boolean>();
			const handlerStarted = Promise.withResolvers<void>();
			const confirmationStarted = Promise.withResolvers<void>();
			const customStarted = Promise.withResolvers<void>();
			const customCompleted = Promise.withResolvers<void>();
			let dialogSignal: AbortSignal | undefined;
			const notify: ExtensionUIContext["notify"] = message => {
				if (message === "Waiting for confirmation") handlerStarted.resolve();
				if (message === "Custom settled") customCompleted.resolve();
			};
			const confirm: ExtensionUIContext["confirm"] = async (_title, _message, dialogOptions) => {
				dialogSignal = dialogOptions?.signal;
				confirmationStarted.resolve();
				dialogSignal?.addEventListener("abort", () => dialog.resolve(false), { once: true });
				return await dialog.promise;
			};
			const customDialog = Promise.withResolvers<void>();
			let customSignal: AbortSignal | undefined;
			const custom: ExtensionUIContext["custom"] = async <T>(...args: Parameters<ExtensionUIContext["custom"]>) => {
				customSignal = args[1]?.signal;
				await args[0](undefined as never, undefined as never, undefined as never, () => {});
				customStarted.resolve();
				await customDialog.promise;
				return undefined as T;
			};
			const uiPrototype = Object.create(runner.getUIContext(), {
				confirm: { value: confirm },
				custom: { value: custom },
				notify: { value: notify },
			});
			const uiContext: ExtensionUIContext = Object.create(uiPrototype);
			initializeRunner(runner, uiContext);
			vi.useFakeTimers();
			let now = 0;
			const performanceNow = vi.spyOn(performance, "now").mockImplementation(() => now);
			try {
				testSetExtensionHandlerTimeoutMs(25);

				const tool: AgentTool = {
					name: "guarded",
					label: "Guarded",
					description: "must not execute after the extension gate times out",
					parameters: Type.Object({}),
					strict: true,
					execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
				};
				const wrapped = new ExtensionToolWrapper(tool, runner);

				const execution = wrapped.execute("tool-call-id", {});
				await handlerStarted.promise;
				expect(dialogSignal).toBeUndefined();

				now = 8;
				vi.advanceTimersByTime(8);
				await confirmationStarted.promise;
				expect(dialogSignal).toBeDefined();

				now = 108;
				vi.advanceTimersByTime(100);
				expect(dialogSignal?.aborted).toBe(false);

				dialog.resolve(true);
				await customStarted.promise;
				expect(customSignal).toBeDefined();
				expect(customSignal?.aborted).toBe(false);

				now = 208;
				vi.advanceTimersByTime(100);
				expect(customSignal?.aborted).toBe(false);

				customDialog.resolve();
				await customCompleted.promise;

				now = 225;
				vi.advanceTimersByTime(17);
				await Promise.resolve();
				await Promise.resolve();
				vi.advanceTimersByTime(0);
				await expect(execution).rejects.toThrow(`Extension ${extensionPath} timed out after 25ms`);
			} finally {
				performanceNow.mockRestore();
				vi.useRealTimers();
			}
		});

		it("charges async custom factory setup to the handler timeout until the dialog is presented", async () => {
			const extensionPath = path.join(tempDir.path(), "pending-custom-factory.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async (_event, ctx) => {
							await ctx.ui.custom(async () => {
								ctx.ui.notify("Factory started");
								await Promise.withResolvers().promise;
							});
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const factoryStarted = Promise.withResolvers<void>();
			const notify: ExtensionUIContext["notify"] = message => {
				if (message === "Factory started") factoryStarted.resolve();
			};
			const custom: ExtensionUIContext["custom"] = async <T>(...args: Parameters<ExtensionUIContext["custom"]>) => {
				await args[0](undefined as never, undefined as never, undefined as never, () => {});
				return undefined as T;
			};
			const uiPrototype = Object.create(runner.getUIContext(), {
				custom: { value: custom },
				notify: { value: notify },
			});
			const uiContext: ExtensionUIContext = Object.create(uiPrototype);
			initializeRunner(runner, uiContext);
			vi.useFakeTimers();
			try {
				testSetExtensionHandlerTimeoutMs(10);
				let settled = false;
				const decision = runner
					.emitToolCall({
						type: "tool_call",
						toolName: "guarded",
						toolCallId: "pending-custom-factory",
						input: {},
					})
					.then(value => {
						settled = true;
						return value;
					});

				await factoryStarted.promise;
				vi.advanceTimersByTime(10);
				for (let i = 0; i < 3; i++) await Promise.resolve();
				vi.advanceTimersByTime(0);
				for (let i = 0; i < 5; i++) await Promise.resolve();

				expect(settled).toBe(true);
				expect(await decision).toEqual({
					block: true,
					reason: `Extension ${extensionPath} timed out after 10ms`,
				});
			} finally {
				vi.useRealTimers();
			}
		});

		it("cancels a pending confirmation and blocks tool execution when the outer dispatch aborts (#4223)", async () => {
			const extensionPath = path.join(tempDir.path(), "confirm-abort-tool-call.ts");
			fs.writeFileSync(
				extensionPath,
				`
					export default function(pi) {
						pi.on("tool_call", async (_event, ctx) => {
							await ctx.ui.confirm("High-risk command", "Allow this command?");
						});
					}
				`,
			);

			const result = await loadTestExtensions([extensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			let dialogSignal: AbortSignal | undefined;
			const dialog = Promise.withResolvers<boolean>();
			const confirmationStarted = Promise.withResolvers<void>();
			const confirm: ExtensionUIContext["confirm"] = async (_title, _message, dialogOptions) => {
				dialogSignal = dialogOptions?.signal;
				confirmationStarted.resolve();
				dialogSignal?.addEventListener("abort", () => dialog.resolve(false), { once: true });
				return await dialog.promise;
			};
			const uiPrototype = Object.create(runner.getUIContext(), {
				confirm: { value: confirm },
			});
			const uiContext: ExtensionUIContext = Object.create(uiPrototype);
			initializeRunner(runner, uiContext);
			let executed = false;

			const tool: AgentTool = {
				name: "guarded",
				label: "Guarded",
				description: "must not execute after the dispatch aborts",
				parameters: Type.Object({}),
				strict: true,
				execute: async () => {
					executed = true;
					return { content: [{ type: "text", text: "ran" }] };
				},
			};
			const wrapped = new ExtensionToolWrapper(tool, runner);

			const controller = new AbortController();
			const execution = wrapped.execute("tool-call-id", {} as never, controller.signal);
			await confirmationStarted.promise;

			expect(dialogSignal).toBeDefined();
			expect(dialogSignal?.aborted).toBe(false);

			controller.abort();
			await expect(execution).rejects.toThrow();

			expect(dialogSignal?.aborted).toBe(true);
			expect(executed).toBe(false);
		});
	});

	describe("memory context", () => {
		it("exposes the lazy memory runtime after initialization", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", async (_event, ctx) => {
						globalThis.__ompMemoryStatus = await ctx.memory.status();
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "memory-context.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);
			const globalState = globalThis as typeof globalThis & { __ompMemoryStatus?: unknown };
			delete globalState.__ompMemoryStatus;

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
				() => ({
					status: async () => ({
						backend: "mnemopi",
						active: true,
						writable: true,
						searchable: true,
					}),
					search: async query => ({ backend: "mnemopi", query, count: 0, items: [] }),
					save: async () => ({ backend: "mnemopi", stored: 1 }),
				}),
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(globalState.__ompMemoryStatus).toMatchObject({
				backend: "mnemopi",
				active: true,
				searchable: true,
			});
			delete globalState.__ompMemoryStatus;
		});
	});

	describe("provider model API", () => {
		it("accepts a per-model WebSocket preference", () => {
			expectTypeOf<ProviderModelConfig["preferWebsockets"]>().toEqualTypeOf<boolean | undefined>();
		});
	});

	describe("service tier API", () => {
		it("restricts tiers to values supported by each provider family", () => {
			expectTypeOf<"scale">().toExtend<ExtensionServiceTier<"openai">>();
			expectTypeOf<"flex">().toExtend<ExtensionServiceTier<"google">>();
			expectTypeOf<"priority">().toExtend<ExtensionServiceTier<"anthropic">>();
			expectTypeOf<"scale">().not.toExtend<ExtensionServiceTier<"google">>();
			expectTypeOf<"flex">().not.toExtend<ExtensionServiceTier<"anthropic">>();
		});

		it("returns a detached snapshot, forwards valid changes, and rejects invalid family tiers", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", () => {
						const tiers = pi.getServiceTiers();
						tiers.openai = "scale";
						pi.appendEntry("service-tier-snapshot", tiers);
						pi.setServiceTier("google", "flex");
						pi.setServiceTier("openai", undefined);
					});
					pi.on("session_start", () => {
						pi.setServiceTier("anthropic", "scale");
					});
					pi.on("session_start", () => {
						pi.setServiceTier("bogus", "priority");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "service-tiers.ts");
			await Bun.write(explicitExtensionPath, extCode);
			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const serviceTiers = { openai: "priority" as const };
			const snapshots: unknown[] = [];
			const setCalls: Array<[string, unknown]> = [];
			const errors: string[] = [];
			runner.onError(error => {
				errors.push(error.error);
			});
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: (_customType, data) => {
						snapshots.push(data);
					},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getServiceTiers: () => serviceTiers,
					setServiceTier: (family, tier) => {
						setCalls.push([family, tier]);
					},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(serviceTiers).toEqual({ openai: "priority" });
			expect(snapshots).toEqual([{ openai: "scale" }]);
			expect(setCalls).toEqual([
				["google", "flex"],
				["openai", undefined],
			]);
			expect(errors).toHaveLength(2);
			expect(errors[0]).toContain('Invalid service tier "scale" for family "anthropic"');
			expect(errors[1]).toContain('Invalid service tier "priority" for family "bogus"');
		});
	});

	describe("session name API", () => {
		it("lets extensions read and set the session name after initialization", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("session_start", async () => {
						if (pi.getSessionName() !== undefined) {
							throw new Error("expected unnamed session");
						}
						await pi.setSessionName("Named by extension");
					});
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async name => {
						await sessionManager.setSessionName(name);
					},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emit({ type: "session_start" });

			expect(sessionManager.getSessionName()).toBe("Named by extension");
			expect(sessionManager.getHeader()?.title).toBe("Named by extension");
		});

		it("keeps session naming unavailable during extension load", async () => {
			const extCode = `
				export default function(pi) {
					pi.getSessionName();
				}
			`;
			const explicitExtensionPath = path.join(tempDir.path(), "session-name-load.ts");
			fs.writeFileSync(explicitExtensionPath, extCode);

			const result = await loadTestExtensions([explicitExtensionPath]);
			const loadError = result.errors.find(error => error.path.includes("session-name-load.ts"));

			expect(loadError).toBeDefined();
			expect(loadError?.error).toContain("Extension runtime not initialized");
		});
	});

	describe("tool approval lifecycle", () => {
		const initializeRunner = (
			runner: ExtensionRunner,
			select: (title: string, options: string[]) => Promise<string | undefined>,
		) => {
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
				undefined,
				{
					select,
					confirm: async () => false,
					input: async () => undefined,
					notify: () => {},
					onTerminalInput: () => () => {},
					setStatus: () => {},
					setWorkingMessage: () => {},
					setWidget: () => {},
					setFooter: () => {},
					setHeader: () => {},
					setTitle: () => {},
					custom: async <T>() => undefined as T,
					pasteToEditor: () => {},
					setEditorText: () => {},
					getEditorText: () => "",
					editor: async () => undefined,
					addAutocompleteProvider: () => {},
					setEditorComponent: () => {},
					get theme() {
						return {} as never;
					},
					getAllThemes: async () => [],
					getTheme: async () => undefined,
					setTheme: async () => ({ success: false, error: "not implemented" }),
					getToolsExpanded: () => false,
					setToolsExpanded: () => {},
				},
			);
		};

		const approvalTool = {
			name: "dangerous_tool",
			label: "Dangerous Tool",
			description: "Test tool",
			parameters: {} as never,
			approval: "exec" as const,
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
		};

		it("emits requested before waiting and resolved after approval", async () => {
			const events: Array<{ type: string; approved?: boolean }> = [];
			const extCode = `
				export default function(pi) {
					pi.on("tool_approval_requested", async (event) => {
						globalThis.__approvalEvents.push({ type: event.type });
					});
					pi.on("tool_approval_resolved", async (event) => {
						globalThis.__approvalEvents.push({ type: event.type, approved: event.approved });
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "approval-events.ts"), extCode);
			const globalState = globalThis as typeof globalThis & { __approvalEvents?: typeof events };
			globalState.__approvalEvents = events;

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const select = vi.fn(async () => {
				events.push({ type: "ui_select" });
				return "Approve";
			});
			initializeRunner(runner, select);

			const wrapper = new ExtensionToolWrapper(approvalTool, runner);
			await (wrapper as ExtensionToolWrapper<any>).execute("call-approval", {}, undefined, undefined, {
				sessionManager,
				modelRegistry,
				model: undefined,
				isIdle: () => true,
				hasQueuedMessages: () => false,
				abort: () => {},
				settings: { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) } as never,
			});

			expect(events).toEqual([
				{ type: "tool_approval_requested" },
				{ type: "ui_select" },
				{ type: "tool_approval_resolved", approved: true },
			]);
			expect(select).toHaveBeenCalledWith(
				expect.stringContaining("Allow tool: dangerous_tool"),
				["Approve", "Deny"],
				undefined,
			);
			delete globalState.__approvalEvents;
		});

		it("does not present approval before canonical or wire-aliased tool previews are ready", async () => {
			const cases = [
				{ tool: approvalTool, wireName: "dangerous_tool", toolCallId: "call-preview" },
				{
					tool: { ...approvalTool, name: "edit", customWireName: "apply_patch" },
					wireName: "apply_patch",
					toolCallId: "call-aliased-preview",
				},
			];
			for (const { tool, wireName, toolCallId } of cases) {
				const result = await loadTestExtensions();
				const runner = new ExtensionRunner(
					result.extensions,
					result.runtime,
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const preview = Promise.withResolvers<void>();
				const order: string[] = [];
				runner.setToolApprovalPreviewWaiter(async waitedToolCallId => {
					order.push(`preview_wait:${waitedToolCallId}`);
					await preview.promise;
					order.push("preview_ready");
				});
				initializeRunner(
					runner,
					vi.fn(async () => {
						order.push("ui_select");
						return "Approve";
					}),
				);

				const wrapper = new ExtensionToolWrapper(tool, runner);
				const execution = (wrapper as ExtensionToolWrapper<any>).execute(toolCallId, {}, undefined, undefined, {
					sessionManager,
					modelRegistry,
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: {
						get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}),
					} as never,
					toolCall: {
						batchId: `batch-${toolCallId}`,
						index: 0,
						total: 1,
						toolCalls: [{ id: toolCallId, name: wireName }],
					},
				});
				await Promise.resolve();
				expect(order).toEqual([`preview_wait:${toolCallId}`]);

				preview.resolve();
				await execution;
				expect(order).toEqual([`preview_wait:${toolCallId}`, "preview_ready", "ui_select"]);
			}
		});

		it("emits resolved false when approval is denied", async () => {
			const events: Array<{ type: string; approved?: boolean; reason?: string }> = [];
			const extCode = `
				export default function(pi) {
					pi.on("tool_approval_requested", async (event) => {
						globalThis.__deniedApprovalEvents.push({ type: event.type, reason: event.reason });
					});
					pi.on("tool_approval_resolved", async (event) => {
						globalThis.__deniedApprovalEvents.push({
							type: event.type,
							approved: event.approved,
							reason: event.reason,
						});
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "denied-approval-events.ts"), extCode);
			const globalState = globalThis as typeof globalThis & { __deniedApprovalEvents?: typeof events };
			globalState.__deniedApprovalEvents = events;

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			initializeRunner(runner, async () => "Deny");

			const wrapper = new ExtensionToolWrapper(approvalTool, runner);
			await expect(
				(wrapper as ExtensionToolWrapper<any>).execute("call-denied", {}, undefined, undefined, {
					sessionManager,
					modelRegistry,
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) } as never,
				}),
			).rejects.toThrow("Tool call denied by user: dangerous_tool");

			expect(events).toEqual([
				{ type: "tool_approval_requested", reason: undefined },
				{ type: "tool_approval_resolved", approved: false, reason: "denied by user" },
			]);
			delete globalState.__deniedApprovalEvents;
		});
		it("emits resolved false when the approval prompt throws", async () => {
			const events: Array<{ type: string; approved?: boolean; reason?: string }> = [];
			const extCode = `
				export default function(pi) {
					pi.on("tool_approval_requested", async (event) => {
						globalThis.__thrownApprovalEvents.push({ type: event.type, reason: event.reason });
					});
					pi.on("tool_approval_resolved", async (event) => {
						globalThis.__thrownApprovalEvents.push({
							type: event.type,
							approved: event.approved,
							reason: event.reason,
						});
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "thrown-approval-events.ts"), extCode);
			const globalState = globalThis as typeof globalThis & { __thrownApprovalEvents?: typeof events };
			globalState.__thrownApprovalEvents = events;

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			initializeRunner(runner, async () => {
				throw new Error("dialog aborted");
			});

			const wrapper = new ExtensionToolWrapper(approvalTool, runner);
			await expect(
				(wrapper as ExtensionToolWrapper<any>).execute("call-thrown", {}, undefined, undefined, {
					sessionManager,
					modelRegistry,
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) } as never,
				}),
			).rejects.toThrow("dialog aborted");

			expect(events).toEqual([
				{ type: "tool_approval_requested", reason: undefined },
				{ type: "tool_approval_resolved", approved: false, reason: "dialog aborted" },
			]);
			delete globalState.__thrownApprovalEvents;
		});
		it("emits lifecycle events when partial context has no session manager", async () => {
			const events: Array<{ type: string; approved?: boolean; reason?: string; sessionId?: string }> = [];
			const extCode = `
				export default function(pi) {
					pi.on("tool_approval_requested", async (event) => {
						globalThis.__partialContextApprovalEvents.push({
							type: event.type,
							sessionId: event.sessionId,
							reason: event.reason,
						});
					});
					pi.on("tool_approval_resolved", async (event) => {
						globalThis.__partialContextApprovalEvents.push({
							type: event.type,
							sessionId: event.sessionId,
							approved: event.approved,
							reason: event.reason,
						});
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "partial-context-approval-events.ts"), extCode);
			const globalState = globalThis as typeof globalThis & { __partialContextApprovalEvents?: typeof events };
			globalState.__partialContextApprovalEvents = events;

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			const wrapper = new ExtensionToolWrapper(approvalTool, runner);
			await expect(
				(wrapper as ExtensionToolWrapper<any>).execute("call-partial-context", {}, undefined, undefined, {
					settings: { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) },
				} as never),
			).rejects.toThrow('Tool "dangerous_tool" requires approval but no interactive UI available.');

			expect(events).toEqual([
				{ type: "tool_approval_requested", sessionId: "", reason: undefined },
				{
					type: "tool_approval_resolved",
					sessionId: "",
					approved: false,
					reason: "no interactive UI available",
				},
			]);
			delete globalState.__partialContextApprovalEvents;
		});
		// Tests for the generic tool_approval_review seam.
		describe("tool_approval_review seam", () => {
			const globalWithReview = globalThis as typeof globalThis & {
				__reviewTrace?: Array<Record<string, unknown>>;
				__reviewController?: AbortController;
				__reviewEntered?: () => void;
			};
			class PrototypeSensitiveInput {
				command: string;

				constructor(command: string) {
					this.command = command;
				}

				describe(): string {
					return `prototype:${this.command}`;
				}
			}

			const setTrace = (): Array<Record<string, unknown>> => {
				const trace: Array<Record<string, unknown>> = [];
				globalWithReview.__reviewTrace = trace;
				return trace;
			};
			const clearTrace = (): void => {
				delete globalWithReview.__reviewTrace;
				delete globalWithReview.__reviewController;
				delete globalWithReview.__reviewEntered;
			};
			afterEach(() => {
				clearTrace();
				vi.restoreAllMocks();
			});

			const firstReviewText = (result: { content: readonly (TextContent | ImageContent)[] }): string | undefined => {
				const block = result.content[0];
				return block?.type === "text" ? block.text : undefined;
			};

			const reviewHandlerCode = (body: string) => `
				pi.on("tool_approval_review", async (event) => {
					globalThis.__reviewTrace.push({
						kind: "review",
						sessionId: event.sessionId,
						toolName: event.toolName,
						toolCallId: event.toolCallId,
						approvalMode: event.approvalMode,
						tier: event.tier,
						input: event.input,
					});
					${body}
				});`;

			// Extension source with an optional `tool_approval_review` handler plus
			// native approval observers, so every test records full host ordering.
			const reviewExtensionCode = (reviewBody: string | null) => `
				export default function(pi) {
					${reviewBody === null ? "" : reviewHandlerCode(reviewBody)}
					pi.on("tool_approval_requested", async () => {
						globalThis.__reviewTrace.push({ kind: "requested" });
					});
					pi.on("tool_approval_resolved", async (event) => {
						globalThis.__reviewTrace.push({ kind: "resolved", approved: event.approved });
					});
				}
			`;

			const recordingApprovalTool = () => ({
				...approvalTool,
				execute: async (_toolCallId: string, params: unknown) => {
					globalWithReview.__reviewTrace?.push({ kind: "executed", params });
					return { content: [{ type: "text" as const, text: "ok" }] };
				},
			});

			const alwaysAskSettings = { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) };

			const executeReviewCase = (
				runner: ExtensionRunner,
				tool: AgentTool,
				toolCallId: string,
				options?: {
					params?: unknown;
					signal?: AbortSignal;
					settings?: { get: (key: string) => unknown };
					extraContext?: Record<string, unknown>;
				},
			) =>
				new ExtensionToolWrapper(tool, runner).execute(
					toolCallId,
					(options?.params ?? {}) as never,
					options?.signal,
					undefined,
					{
						sessionManager,
						modelRegistry,
						model: undefined,
						isIdle: () => true,
						hasQueuedMessages: () => false,
						abort: () => {},
						settings: (options?.settings ?? alwaysAskSettings) as never,
						...options?.extraContext,
					} as never,
				);

			const reviewRunnerFromFile = async (
				fileName: string,
				code: string,
				customSelect?: (title: string, options: string[]) => Promise<string | undefined>,
			) => {
				await Bun.write(path.join(extensionsDir, fileName), code);
				const result = await loadTestExtensions();
				const runner = new ExtensionRunner(
					result.extensions,
					result.runtime,
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const select = vi.fn(
					customSelect ??
						(async () => {
							globalWithReview.__reviewTrace?.push({ kind: "ui_select" });
							return "Approve";
						}),
				);
				initializeRunner(runner, select);
				return { runner, select };
			};

			// --- Dedicated unanimous dispatch (runner level) ---

			const dispatchRunner = (
				reviewHandlers: Array<(event: ToolApprovalReviewEvent, ctx: unknown) => unknown>,
				toolCallHandlers: Array<(event: unknown, ctx: unknown) => unknown> = [],
			): ExtensionRunner => {
				const extensionPath = path.join(extensionsDir, "review-dispatch.ts");
				const extension: Extension = {
					path: extensionPath,
					resolvedPath: extensionPath,
					handlers: new Map([
						["tool_approval_review", reviewHandlers as never],
						["tool_call", toolCallHandlers as never],
					]),
					tools: new Map(),
					assistantThinkingRenderers: [],
					fileWriteFallbackHandlers: [],
					fileDeleteFallbackHandlers: [],
					messageRenderers: new Map(),
					composerShapes: new Map(),
					commands: new Map(),
					flags: new Map(),
					shortcuts: new Map(),
				};
				return new ExtensionRunner(
					[extension],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
			};

			const dispatchEvent = {
				type: "tool_approval_review",
				sessionId: "session-review",
				toolName: "dangerous_tool",
				toolCallId: "call-dispatch",
				input: { command: "echo hi" },
				approvalMode: "always-ask",
				tier: "exec",
			} as ToolApprovalReviewEvent;

			it("dispatch returns approve only for unanimous approval and delivers the exact public event", async () => {
				const seen: ToolApprovalReviewEvent[] = [];
				const runner = dispatchRunner([
					async event => {
						seen.push(event);
						return { decision: "approve" };
					},
				]);
				await expect(runner.emitToolApprovalReview(dispatchEvent)).resolves.toEqual({ decision: "approve" });
				expect(seen).toHaveLength(1);
				expect(seen[0]).toEqual(dispatchEvent);
				// The public event carries exactly these fields — no input rewrite channel.
				expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
					"approvalMode",
					"input",
					"sessionId",
					"tier",
					"toolCallId",
					"toolName",
					"type",
				]);
			});

			it("dispatch returns a valid deny result with its reason", async () => {
				const runner = dispatchRunner([async () => ({ decision: "deny", reason: "policy refusal" })]);
				await expect(runner.emitToolApprovalReview(dispatchEvent)).resolves.toEqual({
					decision: "deny",
					reason: "policy refusal",
				});
			});

			it("dispatch gives deny precedence over escalation and approval", async () => {
				const seen: string[] = [];
				const runner = dispatchRunner([
					async () => {
						seen.push("approve");
						return { decision: "approve" };
					},
					async () => {
						seen.push("escalate");
						return { decision: "escalate" };
					},
					async () => {
						seen.push("deny");
						return { decision: "deny" };
					},
				]);
				await expect(runner.emitToolApprovalReview(dispatchEvent)).resolves.toEqual({ decision: "deny" });
				expect(seen).toEqual(["approve", "escalate", "deny"]);
			});

			it("dispatch returns escalation for malformed or adversarial handler results", async () => {
				const inheritedDecision = Object.create({ decision: "approve" });
				const throwingDecision = Object.defineProperty({}, "decision", {
					get: () => {
						throw new Error("getter exploded");
					},
					enumerable: true,
				});
				const throwingProxy = new Proxy(
					{ decision: "approve" },
					{
						ownKeys: () => {
							throw new Error("proxy exploded");
						},
					},
				);
				const malformed = [
					undefined,
					"approve",
					{},
					inheritedDecision,
					throwingDecision,
					throwingProxy,
					{ decision: "deny", extra: true },
					{ decision: "deny", reason: 123 },
					{ decision: "approve", rationale: "unused" },
					{ decision: "approve", input: { command: "rewritten" } },
				];
				for (const result of malformed) {
					const runner = dispatchRunner([async () => result]);
					await expect(runner.emitToolApprovalReview(dispatchEvent)).resolves.toEqual({
						decision: "escalate",
					});
				}
			});

			it("dispatch returns escalation when the signal is already aborted and never calls handlers", async () => {
				const handler = vi.fn(async () => ({ decision: "approve" }));
				const runner = dispatchRunner([handler]);
				const controller = new AbortController();
				controller.abort();
				await expect(runner.emitToolApprovalReview(dispatchEvent, controller.signal)).resolves.toMatchObject({
					decision: "escalate",
				});
				expect(handler).not.toHaveBeenCalled();
			});
			it("exposes the public result contract types", () => {
				expectTypeOf<ToolApprovalReviewResult>().toEqualTypeOf<
					{ decision: "approve" } | { decision: "escalate" } | { decision: "deny"; reason?: string }
				>();
			});

			// --- Wrapper insertion point (integration level) ---

			it("mode-derived prompt with unanimous review approval executes with zero selector calls and no native approval events", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-approve.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const result = await executeReviewCase(runner, approvalTool, "call-review-approve");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).not.toHaveBeenCalled();
				expect(trace).toEqual([
					{
						kind: "review",
						sessionId: expect.any(String),
						toolName: "dangerous_tool",
						toolCallId: "call-review-approve",
						approvalMode: "always-ask",
						tier: "exec",
						input: {},
					},
				]);
			});

			it("review escalation falls through to exactly one native selector with native approval events preserved", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-escalate.ts",
					reviewExtensionCode(`return { decision: "escalate", reason: "unsure" };`),
				);
				const result = await executeReviewCase(runner, approvalTool, "call-review-escalate");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toEqual([
					expect.objectContaining({ kind: "review", toolCallId: "call-review-escalate" }),
					{ kind: "requested" },
					{ kind: "ui_select" },
					{ kind: "resolved", approved: true },
				]);
			});

			it("with no review handler the native selector runs unchanged", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile("review-observers.ts", reviewExtensionCode(null));
				const result = await executeReviewCase(runner, approvalTool, "call-no-review");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toEqual([{ kind: "requested" }, { kind: "ui_select" }, { kind: "resolved", approved: true }]);
			});

			it("a throwing review handler escalates to the native selector", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-throw.ts",
					reviewExtensionCode(`throw new Error("reviewer exploded");`),
				);
				const result = await executeReviewCase(runner, approvalTool, "call-review-throw");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toEqual([
					expect.objectContaining({ kind: "review", toolCallId: "call-review-throw" }),
					{ kind: "requested" },
					{ kind: "ui_select" },
					{ kind: "resolved", approved: true },
				]);
			});

			it("a timed-out review handler escalates to the native selector", async () => {
				testSetExtensionHandlerTimeoutMs(20);
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-hang.ts",
					reviewExtensionCode(`const never = Promise.withResolvers(); await never.promise;`),
				);
				const result = await executeReviewCase(runner, approvalTool, "call-review-hang");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toEqual([
					expect.objectContaining({ kind: "review" }),
					{ kind: "requested" },
					{ kind: "ui_select" },
					{ kind: "resolved", approved: true },
				]);
			});

			it("cancellation during review never executes the tool", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-cancel.ts",
					reviewExtensionCode(`
						globalThis.__reviewEntered?.();
						const { promise, resolve } = Promise.withResolvers<void>();
						const signal = globalThis.__reviewController.signal;
						if (signal.aborted) resolve();
						else signal.addEventListener("abort", () => resolve());
						await promise;
						return { decision: "escalate" };
					`),
					// The native selector also releases the wait, so a missing seam fails the
					// assertions below instead of hanging on the never-invoked review handler.
					async () => {
						globalWithReview.__reviewEntered?.();
						globalWithReview.__reviewTrace?.push({ kind: "ui_select" });
						return "Approve";
					},
				);
				const controller = new AbortController();
				globalWithReview.__reviewController = controller;
				const entered = Promise.withResolvers<void>();
				globalWithReview.__reviewEntered = entered.resolve;
				const toolCallId = "call-review-cancel";
				const execution = executeReviewCase(runner, recordingApprovalTool(), toolCallId, {
					signal: controller.signal,
					extraContext: {
						toolCall: {
							batchId: `batch-${toolCallId}`,
							index: 0,
							total: 1,
							toolCalls: [{ id: toolCallId, name: "dangerous_tool" }],
						},
					},
				});
				await entered.promise;
				controller.abort();
				await expect(execution).rejects.toThrow();
				expect(select).not.toHaveBeenCalled();
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
				expect(trace.some(entry => entry.kind === "requested")).toBe(false);
			});
			it("cancellation after an approve result still prevents execution", async () => {
				const trace = setTrace();
				const runner = dispatchRunner([]);
				const controller = new AbortController();
				vi.spyOn(runner, "emitToolApprovalReview").mockImplementation(async () => {
					controller.abort();
					return { decision: "approve" };
				});

				await expect(
					executeReviewCase(runner, recordingApprovalTool(), "call-review-approve-abort", {
						signal: controller.signal,
					}),
				).rejects.toThrow();
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
			});

			// --- Cancellation hardening: an aborted invocation must never execute ---

			const gateGlobals = globalThis as typeof globalThis & {
				__cancelEntered?: PromiseWithResolvers<void>;
				__cancelGate?: PromiseWithResolvers<void>;
			};
			const installGates = () => {
				gateGlobals.__cancelEntered = Promise.withResolvers<void>();
				gateGlobals.__cancelGate = Promise.withResolvers<void>();
				return {
					entered: gateGlobals.__cancelEntered.promise,
					release: () => gateGlobals.__cancelGate?.resolve(),
					cleanup: () => {
						delete gateGlobals.__cancelEntered;
						delete gateGlobals.__cancelGate;
					},
				};
			};

			it("does not execute when cancelled while the escalated native selector is pending", async () => {
				const trace = setTrace();
				const selectEntered = Promise.withResolvers<void>();
				const selectGate = Promise.withResolvers<void>();
				const { runner, select } = await reviewRunnerFromFile(
					"cancel-select.ts",
					reviewExtensionCode(`return { decision: "escalate" };`),
					async () => {
						globalWithReview.__reviewTrace?.push({ kind: "ui_select" });
						selectEntered.resolve();
						await selectGate.promise;
						return "Approve";
					},
				);
				const controller = new AbortController();
				const execution = executeReviewCase(runner, recordingApprovalTool(), "call-cancel-select", {
					signal: controller.signal,
				});

				await selectEntered.promise;
				controller.abort();
				selectGate.resolve();
				await expect(execution).rejects.toThrow();
				expect(select).toHaveBeenCalledTimes(1);
				// A late "Approve" from the selector must not approve a cancelled call…
				expect(trace).not.toContainEqual({ kind: "resolved", approved: true });
				// …it resolves as not-approved (requested→resolved pairing preserved)…
				expect(trace).toContainEqual({ kind: "resolved", approved: false });
				// …and the signal-ignoring tool is never invoked.
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
			});

			it("does not execute when cancelled while tool_approval_requested handling is pending", async () => {
				const trace = setTrace();
				const gates = installGates();
				const { runner } = await reviewRunnerFromFile(
					"cancel-requested.ts",
					`export default function(pi) {
						pi.on("tool_approval_requested", async () => {
							globalThis.__reviewTrace.push({ kind: "requested" });
							globalThis.__cancelEntered.resolve();
							await globalThis.__cancelGate.promise;
						});
						pi.on("tool_approval_resolved", async (event) => {
							globalThis.__reviewTrace.push({ kind: "resolved", approved: event.approved });
						});
					}`,
				);
				const controller = new AbortController();
				const execution = executeReviewCase(runner, recordingApprovalTool(), "call-cancel-requested", {
					signal: controller.signal,
				});

				await gates.entered;
				controller.abort();
				gates.release();
				await expect(execution).rejects.toThrow();
				expect(trace).toEqual([{ kind: "requested" }, { kind: "resolved", approved: false }]);
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
				gates.cleanup();
			});

			it("does not execute when cancelled while tool_approval_resolved handling is pending", async () => {
				const trace = setTrace();
				const gates = installGates();
				const { runner } = await reviewRunnerFromFile(
					"cancel-resolved.ts",
					`export default function(pi) {
						pi.on("tool_approval_resolved", async (event) => {
							globalThis.__reviewTrace.push({ kind: "resolved", approved: event.approved });
							globalThis.__cancelEntered.resolve();
							await globalThis.__cancelGate.promise;
						});
					}`,
				);
				const controller = new AbortController();
				const execution = executeReviewCase(runner, recordingApprovalTool(), "call-cancel-resolved", {
					signal: controller.signal,
				});

				await gates.entered;
				controller.abort();
				gates.release();
				await expect(execution).rejects.toThrow();
				// Native approval genuinely resolved approve (telemetry stays truthful)…
				expect(trace).toContainEqual({ kind: "resolved", approved: true });
				// …but the signal-ignoring tool must never run.
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
				gates.cleanup();
			});

			it("already-aborted signal never reaches review, native approval, or execution", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"cancel-preaborted.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const controller = new AbortController();
				controller.abort();

				await expect(
					executeReviewCase(runner, recordingApprovalTool(), "call-preaborted", {
						signal: controller.signal,
					}),
				).rejects.toThrow();
				expect(select).not.toHaveBeenCalled();
				expect(trace).toEqual([]);
			});

			it("approve + escalate handlers are not last-result-wins: the native selector decides", async () => {
				const trace = setTrace();
				await Bun.write(
					path.join(extensionsDir, "review-b-escalate.ts"),
					`export default function(pi) {
						pi.on("tool_approval_review", async () => {
							globalThis.__reviewTrace.push({ kind: "review" });
							return { decision: "escalate" };
						});
					}`,
				);
				const { runner, select } = await reviewRunnerFromFile(
					"review-a-approve.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const result = await executeReviewCase(runner, approvalTool, "call-review-mixed");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace.filter(entry => entry.kind === "review")).toHaveLength(2);
				expect(trace[2]).toEqual({ kind: "requested" });
				expect(trace[3]).toEqual({ kind: "ui_select" });
				expect(trace[4]).toEqual({ kind: "resolved", approved: true });
			});

			it("explicit user tools.approval prompt never emits review", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-explicit-user.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const result = await executeReviewCase(runner, approvalTool, "call-explicit-user", {
					settings: {
						get: (key: string) =>
							key === "tools.approvalMode"
								? "always-ask"
								: key === "tools.approval"
									? { dangerous_tool: "prompt" }
									: {},
					},
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toEqual([{ kind: "requested" }, { kind: "ui_select" }, { kind: "resolved", approved: true }]);
			});
			it("invalid user policies do not suppress eligible approval review", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-invalid-user-policy.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const result = await executeReviewCase(runner, recordingApprovalTool(), "call-invalid-user-policy", {
					settings: {
						get: (key: string) =>
							key === "tools.approvalMode"
								? "always-ask"
								: key === "tools.approval"
									? { dangerous_tool: "not-a-policy" }
									: {},
					},
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(select).not.toHaveBeenCalled();
				expect(trace).toContainEqual(expect.objectContaining({ kind: "review" }));
				expect(trace).toContainEqual(expect.objectContaining({ kind: "executed" }));
			});

			it("tool override prompt never emits review", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-override.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const tool = { ...approvalTool, approval: { tier: "exec", policy: "prompt", override: true } as const };
				const result = await executeReviewCase(runner, tool, "call-override-prompt");

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toEqual([{ kind: "requested" }, { kind: "ui_select" }, { kind: "resolved", approved: true }]);
			});

			it("user and tool deny never emit review and never execute", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-deny.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const recording = recordingApprovalTool();

				await expect(
					executeReviewCase(runner, recording, "call-user-deny", {
						settings: {
							get: (key: string) =>
								key === "tools.approvalMode"
									? "always-ask"
									: key === "tools.approval"
										? { dangerous_tool: "deny" }
										: {},
						},
					}),
				).rejects.toThrow('Tool "dangerous_tool" is blocked by user policy.');
				const denyTool = { ...approvalTool, approval: { policy: "deny", tier: "exec", reason: "no" } as const };
				await expect(executeReviewCase(runner, denyTool, "call-tool-deny")).rejects.toThrow(
					'Tool "dangerous_tool" is blocked by tool policy.\nReason: no',
				);

				expect(select).not.toHaveBeenCalled();
				expect(trace.some(entry => entry.kind === "review")).toBe(false);
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
			});
			it("transformed native deny never dispatches approval review", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" }));
				const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
				const runner = dispatchRunner([reviewHandler], [async () => ({ input: { command: "rm -rf" } })]);
				const tool = {
					...approvalTool,
					approval: (args: unknown) => {
						const command = args && typeof args === "object" && "command" in args ? args.command : undefined;
						return command === "rm -rf"
							? ({ policy: "deny", tier: "exec", reason: "dangerous" } as const)
							: ("exec" as const);
					},
					execute,
				} as AgentTool;

				await expect(
					executeReviewCase(runner, tool, "call-transformed-native-deny", {
						params: { command: "echo original" },
					}),
				).rejects.toThrow('Tool "dangerous_tool" is blocked by tool policy.\nReason: dangerous');
				expect(reviewHandler).not.toHaveBeenCalled();
				expect(execute).not.toHaveBeenCalled();
			});

			it("provider computer safety never emits review and still requires native approval", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-computer.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const toolCallId = "call-computer";
				const context: Record<string, unknown> = {
					sessionManager,
					modelRegistry,
					model: undefined,
					isIdle: () => true,
					hasQueuedMessages: () => false,
					abort: () => {},
					settings: alwaysAskSettings,
					toolCall: {
						batchId: `batch-${toolCallId}`,
						index: 0,
						total: 1,
						toolCalls: [{ id: toolCallId, name: "dangerous_tool" }],
						providerMetadata: {
							type: "computer",
							actions: [{ type: "click", x: 4, y: 2 }],
							pendingSafetyChecks: [{ id: "check-1", code: "code-1", message: "confirm in browser" }],
						},
					},
				};
				const wrapper = new ExtensionToolWrapper(recordingApprovalTool(), runner);
				const result = await wrapper.execute(toolCallId, {} as never, undefined, undefined, context as never);

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(select).toHaveBeenCalledWith(
					expect.stringContaining("Provider safety checks"),
					["Approve", "Deny"],
					undefined,
				);
				expect(trace).toEqual([
					{ kind: "requested" },
					{ kind: "ui_select" },
					{ kind: "resolved", approved: true },
					{ kind: "executed", params: {} },
				]);
				expect(context.providerSafetyApproved).toBe(true);
			});

			it("yolo-resolved allow never emits review", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-yolo.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const result = await executeReviewCase(runner, recordingApprovalTool(), "call-yolo-allow", {
					settings: { get: (key: string) => (key === "tools.approvalMode" ? "yolo" : {}) },
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(select).not.toHaveBeenCalled();
				expect(trace).toEqual([{ kind: "executed", params: {} }]);
			});

			it("review event input is the exact final effective execution input and is what executes", async () => {
				const trace = setTrace();
				const extCode = `
					export default function(pi) {
						pi.on("tool_call", async (event) => ({ input: { ...event.input, command: "echo final" } }));
						pi.on("tool_approval_review", async (event) => {
							globalThis.__reviewTrace.push({ kind: "review", input: event.input });
							return { decision: "approve" };
						});
					}
				`;
				const { runner, select } = await reviewRunnerFromFile("review-exact-input.ts", extCode);
				// Simulates the host's final transformToolCallArguments output (timeout clamp +
				// deobfuscation) as the wrapper receives it.
				const params = { command: "echo original", timeout: 5000 };
				const result = await executeReviewCase(runner, recordingApprovalTool(), "call-exact-input", { params });

				expect(firstReviewText(result)).toBe("ok");
				expect(select).not.toHaveBeenCalled();
				const review = trace.find(entry => entry.kind === "review");
				const executed = trace.find(entry => entry.kind === "executed");
				expect(review?.input).toEqual({ command: "echo final", timeout: 5000 });
				expect(executed?.params).toEqual({ command: "echo final", timeout: 5000 });
				// The reviewed input is an immutable snapshot materially identical to what
				// executes — no derived view, no rewrite channel.
				expect(review?.input).toEqual(executed?.params);
				expect(Object.isFrozen(review?.input)).toBe(true);
			});

			it("owns transformed input before review so a retained alias cannot change execution", async () => {
				const trace = setTrace();
				const retainedInput = { command: "echo reviewed" };
				const reviewStarted = Promise.withResolvers<Readonly<Record<string, unknown>>>();
				const releaseReview = Promise.withResolvers<void>();
				const runner = dispatchRunner(
					[
						async event => {
							reviewStarted.resolve(event.input);
							await releaseReview.promise;
							return { decision: "approve" };
						},
					],
					[async () => ({ input: retainedInput })],
				);
				const tool = {
					...recordingApprovalTool(),
					approval: (args: unknown) => {
						const command = args && typeof args === "object" && "command" in args ? args.command : undefined;
						return command === "rm -rf"
							? ({ policy: "deny", tier: "exec", reason: "dangerous" } as const)
							: ("exec" as const);
					},
				};
				const execution = executeReviewCase(runner, tool, "call-review-owned-input", {
					params: { command: "echo original" },
				});

				const reviewedInput = await reviewStarted.promise;
				retainedInput.command = "rm -rf";
				releaseReview.resolve();
				await execution;

				expect(reviewedInput).toEqual({ command: "echo reviewed" });
				expect(trace).toContainEqual({ kind: "executed", params: { command: "echo reviewed" } });
			});

			it("reviews an immutable snapshot while execution keeps mutable owned params", async () => {
				const trace = setTrace();
				const retainedInput = { command: "echo reviewed" };
				const reviewStarted = Promise.withResolvers<Readonly<Record<string, unknown>>>();
				const releaseReview = Promise.withResolvers<void>();
				const reviewed: Array<Readonly<Record<string, unknown>>> = [];
				const executed: Array<{ command: string }> = [];
				const runner = dispatchRunner(
					[
						async event => {
							reviewStarted.resolve(event.input);
							await releaseReview.promise;
							reviewed.push(event.input);
							return { decision: "approve" };
						},
					],
					[async () => ({ input: retainedInput })],
				);
				const base = recordingApprovalTool();
				const tool = {
					...base,
					execute: async (toolCallId: string, params: unknown) => {
						const owned = params as { command: string };
						executed.push(owned);
						// A tool may mutate its own validated params internally.
						owned.command = "echo mutated-by-tool";
						return base.execute(toolCallId, owned);
					},
				};
				const execution = executeReviewCase(runner, tool, "call-review-snapshot-isolation", {
					params: { command: "echo original" },
				});

				const reviewedInput = await reviewStarted.promise;
				retainedInput.command = "rm -rf";
				releaseReview.resolve();
				const result = await execution;

				expect(firstReviewText(result)).toBe("ok");
				expect(reviewedInput).toEqual({ command: "echo reviewed" });
				expect(reviewed).toEqual([{ command: "echo reviewed" }]);
				expect(Object.isFrozen(reviewed[0])).toBe(true);
				expect(Object.isFrozen(executed[0])).toBe(false);
				expect(executed[0]).toEqual({ command: "echo mutated-by-tool" });
				expect(trace).toContainEqual({ kind: "executed", params: { command: "echo mutated-by-tool" } });
			});

			it("non-cloneable input on a yolo-allow path executes without cloning and never dispatches review", async () => {
				const trace = setTrace();
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const runner = dispatchRunner([reviewHandler]);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const callback = () => "non-cloneable";
				const params = { command: "echo hi", callback };
				const result = await executeReviewCase(runner, tool, "call-yolo-non-cloneable", {
					params,
					settings: { get: (key: string) => (key === "tools.approvalMode" ? "yolo" : {}) },
				});

				expect(firstReviewText(result)).toBe("ok");
				// Pre-review execution behavior: the original input object runs, function payload intact.
				expect(executed).toHaveLength(1);
				expect(executed[0]).toBe(params);
				expect((executed[0] as typeof params).callback).toBe(callback);
				expect(reviewHandler).not.toHaveBeenCalled();
				expect(trace).toEqual([]);
			});

			it("non-cloneable input with no review handler keeps the native selector path without clone failure", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-non-cloneable-observers.ts",
					reviewExtensionCode(null),
				);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const params = { command: "echo hi", callback: () => "non-cloneable" };
				const result = await executeReviewCase(runner, tool, "call-no-review-non-cloneable", { params });

				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).toBe(params);
				// No review entry at all; the ordinary native approval events still fire.
				expect(trace.find(entry => entry.kind === "review")).toBeUndefined();
				expect(trace.filter(entry => entry.kind === "requested" || entry.kind === "resolved")).toEqual([
					{ kind: "requested" },
					{ kind: "resolved", approved: true },
				]);
			});

			it("clone failure cannot approve: review-eligible non-cloneable input skips review and faces the native selector", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-non-cloneable.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const params = { command: "echo hi", callback: () => "non-cloneable" };
				const result = await executeReviewCase(runner, tool, "call-non-cloneable-eligible", { params });

				expect(firstReviewText(result)).toBe("ok");
				// Review never dispatched — the approve handler cannot run, so clone failure can never approve.
				expect(trace.find(entry => entry.kind === "review")).toBeUndefined();
				// The ordinary native prompt still gates the call.
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace).toContainEqual({ kind: "requested" });
				expect(trace).toContainEqual({ kind: "resolved", approved: true });
				expect(executed[0]).toBe(params);
			});

			it("cloneable class input skips review and native approval preserves the original instance", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const transformedInput = new PrototypeSensitiveInput("echo reviewed");
				const runner = dispatchRunner([reviewHandler], [async () => ({ input: transformedInput })]);
				const select = vi.fn(async () => "Approve");
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					approval: () => "exec" as const,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};

				await executeReviewCase(runner, tool, "call-class-input", {
					params: { command: "echo original" },
				});

				expect(reviewHandler).not.toHaveBeenCalled();
				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).toBe(transformedInput);
				expect(executed[0]).toBeInstanceOf(PrototypeSensitiveInput);
				expect((executed[0] as PrototypeSensitiveInput).describe()).toBe("prototype:echo reviewed");
			});

			it("cloneable exotic input skips review and native approval preserves original identity", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const timestamp = new Date("2026-08-31T00:00:00.000Z");
				const transformedInput = { command: "echo reviewed", timestamp };
				const runner = dispatchRunner([reviewHandler], [async () => ({ input: transformedInput })]);
				const select = vi.fn(async () => "Approve");
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					approval: () => "exec" as const,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};

				await executeReviewCase(runner, tool, "call-exotic-input", {
					params: { command: "echo original" },
				});

				expect(reviewHandler).not.toHaveBeenCalled();
				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).toBe(transformedInput);
				expect((executed[0] as typeof transformedInput).timestamp).toBe(timestamp);
			});

			it("plain input with no review handlers preserves original identity through native approval", async () => {
				const transformedInput = { command: "echo reviewed" };
				const runner = dispatchRunner([], [async () => ({ input: transformedInput })]);
				const select = vi.fn(async () => "Approve");
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};

				await executeReviewCase(runner, tool, "call-no-review-plain-input", {
					params: { command: "echo original" },
				});

				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).toBe(transformedInput);
			});

			it("real review escalation keeps owned input authoritative through native approval", async () => {
				const transformedInput = { command: "echo reviewed" };
				const reviewed: Array<Readonly<Record<string, unknown>>> = [];
				const runner = dispatchRunner(
					[
						async event => {
							reviewed.push(event.input);
							transformedInput.command = "rm -rf";
							return { decision: "escalate" };
						},
					],
					[async () => ({ input: transformedInput })],
				);
				const select = vi.fn(async () => "Approve");
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};

				await executeReviewCase(runner, tool, "call-reviewed-escalation", {
					params: { command: "echo original" },
				});

				expect(reviewed).toEqual([{ command: "echo reviewed" }]);
				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).not.toBe(transformedInput);
				expect(executed[0]).toEqual({ command: "echo reviewed" });
			});

			it("a retained approval argument cannot mutate the reviewed input into execution", async () => {
				const reviewStarted = Promise.withResolvers<Readonly<Record<string, unknown>>>();
				const releaseReview = Promise.withResolvers<void>();
				let retainedApprovalArg: { command?: string } | undefined;
				const runner = dispatchRunner([
					async event => {
						reviewStarted.resolve(event.input);
						await releaseReview.promise;
						return { decision: "approve" };
					},
				]);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					approval: (args: unknown) => {
						retainedApprovalArg = args as { command?: string };
						return "exec" as const;
					},
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};

				const execution = executeReviewCase(runner, tool, "call-approval-alias", {
					params: { command: "echo safe" },
				});

				// Review is pending while the retained approval alias flips safe → dangerous.
				await reviewStarted.promise;
				if (retainedApprovalArg) retainedApprovalArg.command = "rm -rf";
				releaseReview.resolve();
				const result = await execution;

				expect(firstReviewText(result)).toBe("ok");
				expect(executed[0]).toEqual({ command: "echo safe" });
			});

			it("uses the owned execution snapshot for an escalated native prompt", async () => {
				const reviewStarted = Promise.withResolvers<Readonly<Record<string, unknown>>>();
				const releaseReview = Promise.withResolvers<void>();
				let retainedApprovalArg: { command?: string } | undefined;
				let selectedPrompt = "";
				const runner = dispatchRunner([
					async event => {
						reviewStarted.resolve(event.input);
						await releaseReview.promise;
						return { decision: "escalate" };
					},
				]);
				const select = vi.fn(async (title: string) => {
					selectedPrompt = title;
					return "Approve";
				});
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					approval: (args: unknown) => {
						retainedApprovalArg = args as { command?: string };
						return "exec" as const;
					},
					formatApprovalDetails: (args: unknown) =>
						`Command: ${(args as { command?: string }).command ?? "(missing)"}`,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const execution = executeReviewCase(runner, tool, "call-approval-escalate-owned", {
					params: { command: "echo safe" },
				});

				const reviewedInput = await reviewStarted.promise;
				if (!retainedApprovalArg) throw new Error("approval callback did not receive input");
				retainedApprovalArg.command = "rm -rf";
				releaseReview.resolve();
				const result = await execution;

				expect(firstReviewText(result)).toBe("ok");
				expect(reviewedInput).toEqual({ command: "echo safe" });
				expect(selectedPrompt).toContain("Command: echo safe");
				expect(selectedPrompt).not.toContain("Command: rm -rf");
				expect(executed).toEqual([{ command: "echo safe" }]);
			});

			it("approval policy runs exactly the two upstream resolutions and never sees the execution clone", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const runner = dispatchRunner([reviewHandler]);
				const observed: unknown[] = [];
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					approval: (args: unknown) => {
						observed.push(args);
						return "exec" as const;
					},
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};

				const result = await executeReviewCase(runner, tool, "call-approval-invocations", {
					params: { command: "echo safe" },
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(reviewHandler).toHaveBeenCalledTimes(1);
				// Pre-dispatch short-circuit + full gate; the review path adds no invocation.
				expect(observed).toHaveLength(2);
				expect(observed[0]).toBe(observed[1]);
				// The executed graph is an independent mutable clone no policy invocation observed.
				expect(observed).not.toContain(executed[0]);
				expect(Object.isFrozen(executed[0])).toBe(false);
			});

			it("null-prototype input bypasses extension review and keeps native semantics", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const runner = dispatchRunner([reviewHandler]);
				const select = vi.fn(async () => "Approve");
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const params = Object.create(null) as { command: string };
				params.command = "echo hi";

				const result = await executeReviewCase(runner, tool, "call-null-proto", { params });

				expect(firstReviewText(result)).toBe("ok");
				expect(reviewHandler).not.toHaveBeenCalled();
				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).toBe(params);
			});

			it("frozen and sealed inputs bypass extension review and keep native semantics", async () => {
				for (const toolCallId of ["call-frozen", "call-sealed"]) {
					const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
					const runner = dispatchRunner([reviewHandler]);
					const select = vi.fn(async () => "Approve");
					initializeRunner(runner, select);
					const executed: unknown[] = [];
					const tool = {
						...approvalTool,
						execute: async (_id: string, params: unknown) => {
							executed.push(params);
							return { content: [{ type: "text" as const, text: "ok" }] };
						},
					};
					const params =
						toolCallId === "call-frozen"
							? Object.freeze({ command: "echo hi" })
							: Object.seal({ command: "echo hi" });

					const result = await executeReviewCase(runner, tool, toolCallId, { params });

					expect(firstReviewText(result)).toBe("ok");
					expect(reviewHandler).not.toHaveBeenCalled();
					expect(select).toHaveBeenCalledTimes(1);
					expect(executed[0]).toBe(params);
				}
			});

			it("non-enumerable property input bypasses extension review and keeps native semantics", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const runner = dispatchRunner([reviewHandler]);
				const select = vi.fn(async () => "Approve");
				initializeRunner(runner, select);
				const executed: unknown[] = [];
				const tool = {
					...approvalTool,
					execute: async (_toolCallId: string, params: unknown) => {
						executed.push(params);
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const params: Record<string, unknown> = {};
				Object.defineProperty(params, "command", {
					value: "echo hi",
					writable: true,
					enumerable: false,
					configurable: true,
				});

				const result = await executeReviewCase(runner, tool, "call-non-enumerable", { params });

				expect(firstReviewText(result)).toBe("ok");
				expect(reviewHandler).not.toHaveBeenCalled();
				expect(select).toHaveBeenCalledTimes(1);
				expect(executed[0]).toBe(params);
			});

			it("native deny stays authoritative on non-cloneable input and never dispatches review", async () => {
				const reviewHandler = vi.fn(async () => ({ decision: "approve" as const }));
				const runner = dispatchRunner([reviewHandler]);
				const execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ran" }] }));
				const tool = {
					...approvalTool,
					approval: (args: unknown) => {
						const command = args && typeof args === "object" && "command" in args ? args.command : undefined;
						return command === "rm -rf"
							? ({ policy: "deny", tier: "exec", reason: "dangerous" } as const)
							: ("exec" as const);
					},
					execute,
				};
				const params = { command: "rm -rf", callback: () => "non-cloneable" };

				await expect(executeReviewCase(runner, tool, "call-deny-non-cloneable", { params })).rejects.toThrow(
					/blocked by tool policy/,
				);
				expect(execute).not.toHaveBeenCalled();
				expect(reviewHandler).not.toHaveBeenCalled();
			});

			it("reviews and executes the value produced by the real agent-loop transformation path", async () => {
				const reviewedInputs: Array<Readonly<Record<string, unknown>>> = [];
				const executedInputs: unknown[] = [];
				const runner = dispatchRunner([
					async event => {
						reviewedInputs.push(event.input);
						return { decision: "approve" };
					},
				]);
				const parameters = Type.Object({ command: Type.String(), timeout: Type.Number() });
				const tool: AgentTool<typeof parameters> = {
					name: "dangerous_tool",
					label: "Dangerous Tool",
					description: "Test tool",
					parameters,
					approval: "exec",
					execute: async (_toolCallId, params) => {
						executedInputs.push(params);
						return { content: [{ type: "text", text: "ok" }] };
					},
				};
				const wrapped = new ExtensionToolWrapper(tool, runner);
				const context: AgentContext = { systemPrompt: [""], messages: [], tools: [wrapped] };
				const rawArguments = { command: "$$secret-command$$", timeout: 10_000 };
				const transformedArguments = { command: "deploy --token sk-live-abc123", timeout: 5_000 };
				const mock = createMockModel({
					responses: [
						{
							content: [
								{
									type: "toolCall",
									id: "call-transformed-input",
									name: "dangerous_tool",
									arguments: rawArguments,
								},
							],
						},
						{ content: ["done"] },
					],
				});
				const config: AgentLoopConfig = {
					model: mock.model,
					convertToLlm: messages =>
						messages.filter(
							message =>
								message.role === "user" || message.role === "assistant" || message.role === "toolResult",
						) as Message[],
					transformToolCallArguments: () => transformedArguments,
					getToolContext: toolCall =>
						({
							sessionManager,
							modelRegistry,
							model: undefined,
							isIdle: () => true,
							hasQueuedMessages: () => false,
							abort: () => {},
							settings: alwaysAskSettings,
							toolCall,
						}) as never,
				};

				await agentLoop(
					[{ role: "user", content: "deploy", timestamp: Date.now() }],
					context,
					config,
					undefined,
					mock.stream,
				).result();

				expect(reviewedInputs).toEqual([transformedArguments]);
				expect(executedInputs).toEqual([transformedArguments]);
				expect(reviewedInputs[0]).not.toEqual(rawArguments);
			});

			it("a rewrite attempt inside an approve result is ignored and escalates to the native selector", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-rewrite-attempt.ts",
					reviewExtensionCode(`return { decision: "approve", input: { command: "evil" } };`),
				);
				const result = await executeReviewCase(runner, recordingApprovalTool(), "call-rewrite-attempt", {
					params: { command: "echo good" },
				});

				// The extra input field makes the result malformed: the native selector
				// decides, and the original input executes — "evil" can never run.
				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				expect(trace[0]).toMatchObject({ kind: "review", toolCallId: "call-rewrite-attempt" });
				const executed = trace.find(entry => entry.kind === "executed");
				expect(executed?.params).toEqual({ command: "echo good" });
				expect(JSON.stringify(trace)).not.toContain("evil");
			});

			it("review deny reports an extension veto without selector or execution", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-deny.ts",
					reviewExtensionCode(`return { decision: "deny", reason: "reviewer refuses" };`),
				);

				await expect(
					executeReviewCase(runner, recordingApprovalTool(), "call-review-deny", {
						params: { command: "echo good" },
					}),
				).rejects.toThrow('Tool "dangerous_tool" was denied by an extension approval review: reviewer refuses');

				expect(select).not.toHaveBeenCalled();
				expect(trace).toHaveLength(1);
				expect(trace[0]).toMatchObject({ kind: "review", toolCallId: "call-review-deny" });
				expect(trace.some(entry => entry.kind === "executed")).toBe(false);
			});

			it("headless review escalation keeps the no-UI failure while headless review approval executes", async () => {
				const trace = setTrace();
				await Bun.write(
					path.join(extensionsDir, "review-headless.ts"),
					reviewExtensionCode(`
						if (event.toolCallId.startsWith("headless-escalate")) return { decision: "escalate" };
						return { decision: "approve" };
					`),
				);
				const result = await loadTestExtensions();
				const runner = new ExtensionRunner(
					result.extensions,
					result.runtime,
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				// No initializeRunner: the runner keeps its no-op UI context (headless).
				const tool = recordingApprovalTool();
				await expect(executeReviewCase(runner, tool, "headless-escalate-1")).rejects.toThrow(
					'Tool "dangerous_tool" requires approval but no interactive UI available.',
				);
				const approved = await executeReviewCase(runner, tool, "headless-approve-1");

				expect(firstReviewText(approved)).toBe("ok");
				expect(trace.filter(entry => entry.kind === "review")).toHaveLength(2);
				expect(trace.some(entry => entry.kind === "ui_select")).toBe(false);
				expect(trace.some(entry => entry.kind === "executed")).toBe(true);
			});

			it("xdev-bypassed dispatch is neither reviewed nor re-prompted", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-xdev.ts",
					reviewExtensionCode(`return { decision: "approve" };`),
				);
				const result = await executeReviewCase(runner, recordingApprovalTool(), "call-xdev-bypass", {
					extraContext: { xdevApproved: true, xdevTierResolved: () => {} },
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(select).not.toHaveBeenCalled();
				expect(trace).toEqual([{ kind: "executed", params: {} }]);
			});

			it("a handler mutation attempt escalates and the pristine input executes", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-mutate.ts",
					reviewExtensionCode(`
						event.input.command = "evil";
						return { decision: "approve" };
					`),
				);
				const result = await executeReviewCase(runner, recordingApprovalTool(), "call-review-mutate", {
					params: { command: "echo good", nested: { flag: "keep" } },
				});

				// Frozen snapshot makes the strict-mode assignment throw: escalation wins,
				// the native selector decides, and the reviewed input is what executes.
				expect(firstReviewText(result)).toBe("ok");
				expect(select).toHaveBeenCalledTimes(1);
				const executed = trace.find(entry => entry.kind === "executed");
				expect(executed?.params).toEqual({ command: "echo good", nested: { flag: "keep" } });
				expect(JSON.stringify(trace)).not.toContain("evil");
			});

			it("a mutating formatter cannot change the executed input after escalation", async () => {
				const trace = setTrace();
				const { runner, select } = await reviewRunnerFromFile(
					"review-formatter-mutate.ts",
					reviewExtensionCode(`return { decision: "escalate" };`),
				);
				let formatterArg: unknown;
				const formatterTool = {
					...approvalTool,
					formatApprovalDetails: (args: unknown) => {
						formatterArg = args;
						// Test-owned input: the dispatch params are always { command: string }.
						const record = args as { command?: string };
						const displayed = record.command;
						record.command = "dangerous";
						return `Command: ${displayed}`;
					},
					execute: async (_toolCallId: string, params: unknown) => {
						globalWithReview.__reviewTrace?.push({ kind: "executed", params });
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const result = await executeReviewCase(runner, formatterTool, "call-formatter-mutate", {
					params: { command: "safe" },
				});

				expect(firstReviewText(result)).toBe("ok");
				// The native selector approved a prompt describing the authorized input.
				expect(String(select.mock.calls[0]?.[0])).toContain("Command: safe");
				expect(String(select.mock.calls[0]?.[0])).not.toContain("Command: dangerous");
				const executed = trace.find(entry => entry.kind === "executed");
				expect(executed?.params).toEqual({ command: "safe" });
				// The formatter observed a detached snapshot, not the execution-owned object.
				expect(formatterArg).not.toBe(executed?.params);
			});

			it("a retained formatter argument mutated while the selector is pending cannot reach execution", async () => {
				const trace = setTrace();
				let retained: { command?: string } | undefined;
				let promptText = "";
				const { runner } = await reviewRunnerFromFile(
					"review-formatter-retain.ts",
					reviewExtensionCode(`return { decision: "escalate" };`),
					async title => {
						promptText = title;
						// Mutate the retained observation while ui.select is pending.
						if (retained) retained.command = "dangerous";
						return "Approve";
					},
				);
				const retainingTool = {
					...approvalTool,
					formatApprovalDetails: (args: unknown) => {
						// Test-owned input: the dispatch params are always { command: string }.
						const record = args as { command?: string };
						retained = record;
						return `Command: ${record.command}`;
					},
					execute: async (_toolCallId: string, params: unknown) => {
						globalWithReview.__reviewTrace?.push({ kind: "executed", params });
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const result = await executeReviewCase(runner, retainingTool, "call-formatter-retain", {
					params: { command: "safe" },
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(promptText).toContain("Command: safe");
				const executed = trace.find(entry => entry.kind === "executed");
				expect(executed?.params).toEqual({ command: "safe" });
			});

			it("a mutating formatter cannot reach execution on the native fallback path", async () => {
				const trace = setTrace();
				// No tool_approval_review handler anywhere: no owned review clone is
				// prepared and the native selector decides. This is the path where the
				// execution input and the formatter argument used to be the same object.
				const { runner, select } = await reviewRunnerFromFile("formatter-fallback.ts", reviewExtensionCode(null));
				let formatterArg: unknown;
				const formatterTool = {
					...approvalTool,
					formatApprovalDetails: (args: unknown) => {
						formatterArg = args;
						// Test-owned input: the dispatch params are always { command: string }.
						const record = args as { command?: string };
						const displayed = record.command;
						record.command = "dangerous";
						return `Command: ${displayed}`;
					},
					execute: async (_toolCallId: string, params: unknown) => {
						globalWithReview.__reviewTrace?.push({ kind: "executed", params });
						return { content: [{ type: "text" as const, text: "ok" }] };
					},
				};
				const result = await executeReviewCase(runner, formatterTool, "call-formatter-fallback", {
					params: { command: "safe" },
				});

				expect(firstReviewText(result)).toBe("ok");
				expect(String(select.mock.calls[0]?.[0])).toContain("Command: safe");
				const executed = trace.find(entry => entry.kind === "executed");
				expect(executed?.params).toEqual({ command: "safe" });
				expect(formatterArg).not.toBe(executed?.params);
			});

			it("top-level mutation attempts cannot change what later handlers review", async () => {
				const seenEvents: ToolApprovalReviewEvent[] = [];
				const runner = dispatchRunner([
					async event => {
						const writableEvent = event as {
							input: Record<string, unknown>;
							toolName: string;
							tier: string;
						};
						for (const mutate of [
							() => {
								writableEvent.input = { command: "evil" };
							},
							() => {
								writableEvent.toolName = "other_tool";
							},
							() => {
								writableEvent.tier = "read";
							},
						]) {
							try {
								mutate();
							} catch {}
						}
						return { decision: "approve" };
					},
					async event => {
						seenEvents.push(event);
						return { decision: "approve" };
					},
				]);
				await expect(runner.emitToolApprovalReview(dispatchEvent)).resolves.toEqual({
					decision: "approve",
				});

				expect(seenEvents).toEqual([dispatchEvent]);
				expect(Object.isFrozen(seenEvents[0])).toBe(true);
				expect(Object.isFrozen(seenEvents[0]?.input)).toBe(true);
			});

			it("a nested mutation attempt cannot alter the reviewed snapshot", async () => {
				const seenInputs: Array<Readonly<Record<string, unknown>>> = [];
				const runner = dispatchRunner([
					async event => {
						(event.input.nested as Record<string, unknown>).flag = "evil";
						return { decision: "approve" };
					},
					async event => {
						seenInputs.push(event.input);
						return { decision: "approve" };
					},
				]);
				const nestedEvent = {
					...dispatchEvent,
					input: { command: "echo hi", nested: { flag: "keep" } },
				} as ToolApprovalReviewEvent;
				await expect(runner.emitToolApprovalReview(nestedEvent)).resolves.toMatchObject({
					decision: "escalate",
				});

				expect(seenInputs).toEqual([{ command: "echo hi", nested: { flag: "keep" } }]);
			});
			it("unsupported mutable input escalates without dispatching a handler", async () => {
				const handler = vi.fn(async () => ({ decision: "approve" as const }));
				const runner = dispatchRunner([handler]);
				const event = {
					...dispatchEvent,
					input: { commands: new Map([["command", "echo hi"]]) },
				} as ToolApprovalReviewEvent;

				await expect(runner.emitToolApprovalReview(event)).resolves.toEqual({ decision: "escalate" });
				expect(handler).not.toHaveBeenCalled();
			});

			it("exposes immutable approval review capability metadata", async () => {
				setTrace();
				await Bun.write(
					path.join(extensionsDir, "review-capability.ts"),
					`export default function(pi) {
						const supportedEvents = pi.supportedEvents;
						let mutationBlocked = false;
						try {
							supportedEvents.push("invented_event");
						} catch {
							mutationBlocked = true;
						}
						globalThis.__reviewTrace.push({
							kind: "capability",
							supported: supportedEvents?.includes("tool_approval_review") ?? false,
							frozen: Object.isFrozen(supportedEvents),
							mutationBlocked,
							unchanged: !supportedEvents?.includes("invented_event"),
						});
					}`,
				);
				await loadTestExtensions();

				const entry = (globalWithReview.__reviewTrace ?? []).find(item => item.kind === "capability");
				expect(entry).toMatchObject({
					supported: true,
					frozen: true,
					mutationBlocked: true,
					unchanged: true,
				});
			});

			it("the documented capability pattern stays false without throwing when supportedEvents is absent", async () => {
				setTrace();
				await Bun.write(
					path.join(extensionsDir, "review-capability-legacy.ts"),
					`export default function(pi) {
						delete pi.supportedEvents;
						globalThis.__reviewTrace.push({
							kind: "legacy-capability",
							supported: pi.supportedEvents?.includes("tool_approval_review") ?? false,
						});
					}`,
				);
				await loadTestExtensions();

				const entry = (globalWithReview.__reviewTrace ?? []).find(item => item.kind === "legacy-capability");
				expect(entry).toEqual({ kind: "legacy-capability", supported: false });
			});
		});
	});

	describe("tool_call input", () => {
		function createHashlineEditTool(): AgentTool {
			return {
				name: "edit",
				label: "Edit",
				description: "Test edit tool",
				parameters: Type.Object({ input: Type.String() }),
				strict: true,
				execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
			};
		}

		it("allows bracketed Markdown paths, blocks non-Markdown paths, and accepts legacy headers", async () => {
			const eventsPath = path.join(tempDir.path(), "tool-call-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "edit") return;
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ path: event.input.path, paths: event.input.paths }) + "\\n",
						);
						if (typeof event.input.path !== "string" || !event.input.path.endsWith(".md")) {
							return { block: true, reason: \`Blocked: \${event.input.path}\` };
						}
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-path.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createHashlineEditTool(), runner);

			const resultMessage = await wrapped.execute("tool-call-id", {
				input: [
					"*** Begin Patch",
					'["plans/switch case-array.md"#ABC1]',
					"PUT 27.=27:",
					"+new content",
					"*** End Patch",
				].join("\n"),
			});
			await expect(
				wrapped.execute("non-markdown-tool-call-id", {
					input: "[packages/coding-agent/src/main.ts#BCD2]\nPUT 1.=1:\n+changed",
				}),
			).rejects.toThrow("Blocked: packages/coding-agent/src/main.ts");
			const legacyResult = await wrapped.execute("legacy-tool-call-id", {
				input: "¶plans/legacy.md#CDE3\n27 27\n+new content",
			});

			expect(resultMessage.content).toEqual([{ type: "text", text: "ok" }]);
			expect(legacyResult.content).toEqual([{ type: "text", text: "ok" }]);
			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{ path: "plans/switch case-array.md", paths: ["plans/switch case-array.md"] },
				{
					path: "packages/coding-agent/src/main.ts",
					paths: ["packages/coding-agent/src/main.ts"],
				},
				{ path: "plans/legacy.md", paths: ["plans/legacy.md"] },
			]);
		});
		it("keeps non-tag hash suffixes in hashline edit paths", async () => {
			const eventsPath = path.join(tempDir.path(), "tool-call-non-tag-path-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "edit") return;
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ path: event.input.path, paths: event.input.paths }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-non-tag-path.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createHashlineEditTool(), runner);

			await wrapped.execute("tool-call-id", {
				input: "[plans/foo.md#notatag]\nPUT 27.=27:\n+new content",
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([{ path: "plans/foo.md#notatag", paths: ["plans/foo.md#notatag"] }]);
		});

		it("ignores _path passthrough when the hashline input names a different target", async () => {
			const eventsPath = path.join(tempDir.path(), "tool-call-spoof-path-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "edit") return;
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ path: event.input.path, paths: event.input.paths }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-spoof-path.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createHashlineEditTool(), runner);

			await wrapped.execute("tool-call-id", {
				_path: "plans/allowed.md",
				input: "[src/secret.ts#ABC1]\nPUT 27.=27:\n+evil content",
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([{ path: "src/secret.ts", paths: ["src/secret.ts"] }]);
		});

		it("leaves path unset and reports all targets for multi-file hashline edits", async () => {
			const eventsPath = path.join(tempDir.path(), "tool-call-multi-path-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "edit") return;
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ path: event.input.path ?? null, paths: event.input.paths }) + "\\n",
						);
						if (typeof event.input.path !== "string") {
							return { block: true, reason: \`Blocked: \${event.input.path}\` };
						}
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-multi-path.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createHashlineEditTool(), runner);

			await expect(
				wrapped.execute("tool-call-id", {
					input: "[plans/switch-case-array-syntax.md#ABC1]\nPUT 27.=27:\n+new content\n[packages/coding-agent/src/main.ts#DEF2]\nPUT 1.=1:\n+changed",
				}),
			).rejects.toThrow("Blocked: undefined");

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					path: null,
					paths: ["plans/switch-case-array-syntax.md", "packages/coding-agent/src/main.ts"],
				},
			]);
		});

		// A tool that records the exact params it executed with, so an input override is observable.
		function createRecordingTool(recordPath: string): AgentTool {
			return {
				name: "bash",
				label: "Bash",
				description: "Test bash tool",
				parameters: Type.Object({ command: Type.String() }),
				strict: true,
				execute: async (_id: string, params: unknown) => {
					fs.appendFileSync(recordPath, `${JSON.stringify(params)}\n`);
					return { content: [{ type: "text", text: "ran" }] };
				},
			} as AgentTool;
		}

		it("executes the tool with a non-blocking handler's replacement input", async () => {
			const recordPath = path.join(tempDir.path(), "override-executed.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo revised" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-override.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createRecordingTool(recordPath), runner);

			const resultMessage = await wrapped.execute("tool-call-id", { command: "echo original" });

			expect(resultMessage.content).toEqual([{ type: "text", text: "ran" }]);
			const executed = fs
				.readFileSync(recordPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(executed).toEqual([{ command: "echo revised" }]);
		});

		it("ignores a replacement input when the handler also blocks", async () => {
			const recordPath = path.join(tempDir.path(), "override-blocked.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { block: true, reason: "nope", input: { command: "echo revised" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-override-blocked.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createRecordingTool(recordPath), runner);

			await expect(wrapped.execute("tool-call-id", { command: "echo original" })).rejects.toThrow("nope");
			expect(fs.existsSync(recordPath)).toBe(false); // tool never executed
		});

		// A tool whose approval policy depends on its args: the command "rm -rf" resolves to deny,
		// anything else is exec. Lets a test prove the post-override approval re-check (P1).
		function createArgGatedTool(recordPath: string): AgentTool {
			return {
				name: "bash",
				label: "Bash",
				description: "Test bash tool",
				parameters: Type.Object({ command: Type.String() }),
				strict: true,
				approval: (args: unknown) => {
					const command = args && typeof args === "object" && "command" in args ? args.command : undefined;
					return command === "rm -rf" ? { policy: "deny" as const, reason: "dangerous" } : ("exec" as const);
				},
				execute: async (_id: string, params: unknown) => {
					fs.appendFileSync(recordPath, `${JSON.stringify(params)}\n`);
					return { content: [{ type: "text", text: "ran" }] };
				},
			} as AgentTool;
		}

		const yoloContext = {
			settings: { get: (key: string) => (key === "tools.approvalMode" ? "yolo" : {}) },
		} as never;

		// Minimal runtime init so the approval gate's interactive `select` is wired for prompt-path tests.
		const initApprovalRunner = (
			runner: ExtensionRunner,
			select: (title: string, options: string[]) => Promise<string | undefined>,
		) => {
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => undefined,
					setSessionName: async () => {},
				} as never,
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				} as never,
				undefined,
				{ select, notify: () => {} } as never,
			);
		};
		const alwaysAskContext = {
			sessionManager,
			modelRegistry,
			model: undefined,
			isIdle: () => true,
			hasQueuedMessages: () => false,
			abort: () => {},
			settings: { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) },
		} as never;

		it("blocks a revised input that resolves to a deny policy (approval gates the revised args)", async () => {
			const recordPath = path.join(tempDir.path(), "regate-blocked.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "rm -rf" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-regate.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createArgGatedTool(recordPath), runner);

			// Original "echo original" resolves to exec; the handler rewrites it to "rm -rf", which the
			// tool's approval declares deny. Because tool_call fires before the approval gate, the gate
			// resolves against the revised args and blocks — the tool never runs.
			await expect(
				wrapped.execute("tool-call-id", { command: "echo original" }, undefined, undefined, yoloContext),
			).rejects.toThrow('Tool "bash" is blocked by tool policy.\nReason: dangerous');
			expect(fs.existsSync(recordPath)).toBe(false); // tool never executed
		});

		it("allows a revised input that still passes policy", async () => {
			const recordPath = path.join(tempDir.path(), "regate-allowed.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo revised" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-regate-ok.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createArgGatedTool(recordPath), runner);

			await wrapped.execute("tool-call-id", { command: "echo original" }, undefined, undefined, yoloContext);

			const executed = fs
				.readFileSync(recordPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(executed).toEqual([{ command: "echo revised" }]);
		});

		it("uses the last handler's input when several handlers set it", async () => {
			const recordPath = path.join(tempDir.path(), "regate-multi.jsonl");
			const first = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo first" } };
					});
				}
			`;
			const second = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo second" } };
					});
				}
			`;
			// File names sort first < second, so the loader loads them in that order and second wins.
			fs.writeFileSync(path.join(extensionsDir, "tool-call-multi-a.ts"), first);
			fs.writeFileSync(path.join(extensionsDir, "tool-call-multi-b.ts"), second);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createRecordingTool(recordPath), runner);

			await wrapped.execute("tool-call-id", { command: "echo original" });

			const executed = fs
				.readFileSync(recordPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(executed).toEqual([{ command: "echo second" }]);
		});

		it("prompts for the revised input, not the original, on an approval-gated tool (P1 prompt→prompt)", async () => {
			// The Codex P1 follow-up: original and revised args are both prompt-gated, so a stale re-check
			// on policy alone would let the revised args run under approval granted for the original.
			// Because tool_call fires before the approval gate, the prompt must reflect the revised args.
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "prompt_tool") return;
						return { input: { command: "revised-command" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-prompt-revise.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			let promptedWith = "";
			const select = vi.fn(async (title: string) => {
				promptedWith = title;
				return "Approve";
			});
			initApprovalRunner(runner, select);

			const executed: unknown[] = [];
			const promptTool = {
				name: "prompt_tool",
				label: "Prompt Tool",
				description: "Always prompt-gated",
				parameters: Type.Object({ command: Type.String() }),
				strict: true,
				approval: "exec" as const,
				formatApprovalDetails: (args: unknown) =>
					args && typeof args === "object" && "command" in args ? String(args.command) : "",
				execute: async (_id: string, params: unknown) => {
					executed.push(params);
					return { content: [{ type: "text", text: "ran" }] };
				},
			} as AgentTool;
			const wrapped = new ExtensionToolWrapper(promptTool, runner);

			await (wrapped as ExtensionToolWrapper<any>).execute(
				"call-p2p",
				{ command: "original-command" },
				undefined,
				undefined,
				alwaysAskContext,
			);

			// The user was prompted for the revised command, and that is what executed.
			expect(promptedWith).toContain("revised-command");
			expect(promptedWith).not.toContain("original-command");
			expect(executed).toEqual([{ command: "revised-command" }]);
		});
		it("skips wrapper emission when the loop already emitted tool_call for the dispatch", async () => {
			// The agent loop emits tool_call at arg-prep time (session beforeToolCall
			// wiring) and marks the dispatch on the runner; the wrapper must not fire
			// handlers a second time for the same call. The marker is consume-once,
			// so a dispatch the loop never marked (nested xd://, Cursor direct)
			// still emits.
			const recordPath = path.join(tempDir.path(), "loop-marker.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo revised" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-loop-marker.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createRecordingTool(recordPath), runner);

			runner.markToolCallEmitted("loop-call-id", "bash");
			await wrapped.execute("loop-call-id", { command: "echo original" });
			// Marker consumed above: an unmarked dispatch under the same id emits normally.
			await wrapped.execute("loop-call-id", { command: "echo original" });

			const executed = fs
				.readFileSync(recordPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(executed).toEqual([{ command: "echo original" }, { command: "echo revised" }]);
		});

		it("forfeits the xdevApproved prompt bypass when a handler revises the input", async () => {
			// write.ts dispatches xd:// devices with xdevApproved: true because its
			// outer gate already approved the ORIGINAL device input. A tool_call
			// revision may raise the tier, so revised input must face the full gate
			// (here: no interactive UI => reject) instead of riding the outer approval.
			const recordPath = path.join(tempDir.path(), "xdev-revised.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo revised" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-xdev-revise.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const wrapped = new ExtensionToolWrapper(createRecordingTool(recordPath), runner);
			const xdevContext = {
				settings: { get: (key: string) => (key === "tools.approvalMode" ? "always-ask" : {}) },
				xdevApproved: true,
			} as never;

			await expect(
				wrapped.execute("xdev-call-id", { command: "echo original" }, undefined, undefined, xdevContext),
			).rejects.toThrow(/requires approval but no interactive UI available/);
			expect(fs.existsSync(recordPath)).toBe(false); // tool never executed
		});

		it("reports the effective tier after a tool_call handler revises xd:// input", async () => {
			const recordPath = path.join(tempDir.path(), "xdev-effective-tier.jsonl");
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "bash") return;
						return { input: { command: "echo revised" } };
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-xdev-tier.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const tool = createRecordingTool(recordPath);
			tool.approval = args =>
				args &&
				typeof args === "object" &&
				"command" in args &&
				typeof args.command === "string" &&
				args.command.includes("revised")
					? "write"
					: "read";
			const wrapped = new ExtensionToolWrapper(tool, runner);
			let effectiveTier: string | undefined;
			const xdevContext = {
				settings: { get: (key: string) => (key === "tools.approvalMode" ? "yolo" : {}) },
				xdevApproved: true,
				xdevTierResolved: (tier: string) => {
					effectiveTier = tier;
				},
			} as never;

			await wrapped.execute("xdev-tier-id", { command: "echo original" }, undefined, undefined, xdevContext);
			expect(JSON.parse(fs.readFileSync(recordPath, "utf8"))).toEqual({ command: "echo revised" });
			expect(effectiveTier).toBe("write");
		});

		it("emits tool_call before the approval prompt so approval sees the final input", async () => {
			const order: string[] = [];
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async (event) => {
						if (event.toolName !== "prompt_tool") return;
						globalThis.__orderEvents.push("tool_call");
						return { input: { command: "revised" } };
					});
					pi.on("tool_approval_requested", async () => {
						globalThis.__orderEvents.push("tool_approval_requested");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "tool-call-order.ts"), extCode);
			const globalState = globalThis as typeof globalThis & { __orderEvents?: string[] };
			globalState.__orderEvents = order;

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const select = vi.fn(async () => {
				order.push("ui_select");
				return "Approve";
			});
			initApprovalRunner(runner, select);

			const promptTool = {
				name: "prompt_tool",
				label: "Prompt Tool",
				description: "Always prompt-gated",
				parameters: Type.Object({ command: Type.String() }),
				strict: true,
				approval: "exec" as const,
				execute: async () => ({ content: [{ type: "text", text: "ran" }] }),
			} as AgentTool;
			const wrapped = new ExtensionToolWrapper(promptTool, runner);

			await (wrapped as ExtensionToolWrapper<any>).execute(
				"call-order",
				{ command: "original" },
				undefined,
				undefined,
				alwaysAskContext,
			);

			expect(order).toEqual(["tool_call", "tool_approval_requested", "ui_select"]);
			delete globalState.__orderEvents;
		});
	});
	describe("hasHandlers", () => {
		it("returns true when handlers exist for event type", async () => {
			const extCode = `
				export default function(pi) {
					pi.on("tool_call", async () => undefined);
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "handler.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.hasHandlers("tool_call")).toBe(true);
			expect(runner.hasHandlers("agent_end")).toBe(false);
		});
	});

	describe("zero-handler fast path", () => {
		it("skips context allocation and handler machinery for an unsubscribed event type, but still fires when subscribed", async () => {
			// The fast path in ExtensionRunner.emit is event-type agnostic; the hot
			// streaming events (message_update / tool_execution_*) traverse the same
			// path. `turn_start` stands in as a subscribed event with a trivial payload.
			const extCode = `
				export default function(pi) {
					pi.on("turn_start", async () => {
						throw new Error("turn_start handler ran");
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "turn-start-handler.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// createContext is the per-event allocation the fast path defers; spying on
			// it (call-through preserved) proves the slow path is entered only when a
			// handler exists for the emitted event type.
			const createContextSpy = vi.spyOn(runner, "createContext");
			const errors: Array<{ event: string; error: string }> = [];
			runner.onError(err => {
				errors.push({ event: err.event, error: err.error });
			});

			// No extension subscribes to `agent_start`: no context allocation, and the
			// handler-timeout machinery is never entered.
			await runner.emit({ type: "agent_start" });
			expect(createContextSpy).not.toHaveBeenCalled();
			expect(errors).toHaveLength(0);

			// `turn_start` has a handler: context is allocated once and the handler runs
			// (its throw surfaces via onError, proving #runHandlerWithTimeout executed).
			await runner.emit({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
			expect(createContextSpy).toHaveBeenCalledTimes(1);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("turn_start");
			expect(errors[0]?.error).toContain("turn_start handler ran");
		});
	});

	describe("credential_disabled", () => {
		it("delivers credential_disabled events to subscribed extensions with the typed payload", async () => {
			const eventsPath = path.join(tempDir.path(), "credential-disabled-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("credential_disabled", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({
								type: event.type,
								provider: event.provider,
								disabledCause: event.disabledCause,
							}) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "credential-disabled.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			await runner.emit({ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" });

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" },
			]);
		});

		it("isolates subscriber failures so other handlers still receive the event", async () => {
			const eventsPath = path.join(tempDir.path(), "credential-disabled-isolated.jsonl");
			const ext1Code = `
				export default function(pi) {
					pi.on("credential_disabled", async () => {
						throw new Error("subscriber exploded");
					});
				}
			`;
			const ext2Code = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("credential_disabled", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ provider: event.provider }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "ext1-credential-disabled-throws.ts"), ext1Code);
			fs.writeFileSync(path.join(extensionsDir, "ext2-credential-disabled-records.ts"), ext2Code);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			const errors: Array<{ extensionPath: string; event: string; error: string }> = [];
			runner.onError(err => {
				errors.push(err);
			});

			await runner.emit({ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" });

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([{ provider: "anthropic" }]);
			expect(errors).toHaveLength(1);
			expect(errors[0]?.event).toBe("credential_disabled");
			expect(errors[0]?.error).toContain("subscriber exploded");
		});

		it("is a no-op when no extension subscribes", async () => {
			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			expect(runner.hasHandlers("credential_disabled")).toBe(false);
			await expect(
				runner.emit({ type: "credential_disabled", provider: "anthropic", disabledCause: "invalid_grant" }),
			).resolves.toBeUndefined();
		});

		it("caps the pre-initialize buffer and drops oldest events under pressure", async () => {
			const eventsPath = path.join(tempDir.path(), "credential-disabled-cap.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("credential_disabled", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ provider: event.provider }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "credential-disabled-cap.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Push 33 events while uninitialized — the 1st should be dropped.
			for (let i = 0; i < 33; i++) {
				await runner.emitCredentialDisabled({ provider: `provider-${i}`, disabledCause: "invalid_grant" });
			}

			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			// Drain microtasks so the fire-and-forget emit() calls inside initialize() complete.
			for (let i = 0; i < 5; i++) await Promise.resolve();

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toHaveLength(32);
			// Drop-oldest policy: provider-0 was evicted, provider-1 survived as the head.
			expect(events[0]?.provider).toBe("provider-1");
		});
	});

	describe("mcp_notification", () => {
		it("delivers mcp_notification events to subscribed extensions with the typed payload", async () => {
			const eventsPath = path.join(tempDir.path(), "mcp-notification-events.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("mcp_notification", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({
								type: event.type,
								server: event.server,
								method: event.method,
								params: event.params,
							}) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "mcp-notification.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			await runner.emitMcpNotification({
				server: "peers",
				method: "notifications/peer_message",
				params: { from: "alice", text: "hi" },
			});

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{
					type: "mcp_notification",
					server: "peers",
					method: "notifications/peer_message",
					params: { from: "alice", text: "hi" },
				},
			]);
		});

		it("buffers pre-initialize events and drains them on initialize (caps at 100, drops oldest)", async () => {
			// Guard against regression of the two-layer startup race that Codex flagged
			// on PR #6535 (commit ffa058aa8): the sdk.ts bridge wires
			// mcpManager.addNotificationListener inside createAgentSession BEFORE the
			// mode controller calls ExtensionRunner.initialize(). Frames the manager
			// drains from its own buffer arrive here pre-init. Prior behavior silently
			// dropped them; the fix buffers and drains on initialize (same shape as
			// emitCredentialDisabled).
			const eventsPath = path.join(tempDir.path(), "mcp-notification-cap.jsonl");
			const extCode = `
				import * as fs from "node:fs";

				export default function(pi) {
					pi.on("mcp_notification", async (event) => {
						fs.appendFileSync(
							${JSON.stringify(eventsPath)},
							JSON.stringify({ server: event.server, method: event.method }) + "\\n",
						);
					});
				}
			`;
			fs.writeFileSync(path.join(extensionsDir, "mcp-notification-cap.ts"), extCode);

			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);

			// Push 101 events while uninitialized — the 1st should be dropped, next 100 buffered.
			for (let i = 0; i < 101; i++) {
				await runner.emitMcpNotification({
					server: "peers",
					method: `notifications/test/${i}`,
					params: null,
				});
			}

			runner.initialize(
				{
					sendMessage: () => {},
					sendUserMessage: () => {},
					appendEntry: () => {},
					setLabel: () => {},
					getActiveTools: () => [],
					getAllTools: () => [],
					setActiveTools: async () => {},
					getCommands: () => [],
					setModel: async () => false,
					getThinkingLevel: () => undefined,
					setThinkingLevel: () => {},
					getSessionName: () => sessionManager.getSessionName(),
					setSessionName: async () => {},
				},
				{
					getModel: () => undefined,
					isIdle: () => true,
					abort: () => {},
					hasPendingMessages: () => false,
					shutdown: () => {},
					getContextUsage: () => undefined,
					compact: async () => {},
					getSystemPrompt: () => [],
				},
			);

			// Drain microtasks so the fire-and-forget emit() calls inside initialize() complete.
			for (let i = 0; i < 5; i++) await Promise.resolve();

			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toHaveLength(100);
			// Drop-oldest policy: test/0 was evicted, test/1 survives as the head.
			expect(events[0]?.method).toBe("notifications/test/1");
			expect(events[99]?.method).toBe("notifications/test/100");
		});
	});

	describe("managed timers (ctx.setInterval / ctx.setTimeout)", () => {
		it("contains a throwing interval callback instead of letting it escape as uncaughtException", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const errors: ExtensionError[] = [];
				runner.onError(err => errors.push(err));

				const ctx = runner.createContext();
				let ticks = 0;
				ctx.setInterval(() => {
					ticks += 1;
					throw new Error("boom from interval");
				}, 1000);

				// Two ticks: the throw is swallowed each time, so the interval keeps firing.
				expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
				expect(ticks).toBe(2);
				expect(errors).toHaveLength(2);
				expect(errors[0]?.event).toBe("interval_callback");
				expect(errors[0]?.extensionPath).toBe("<timer>");
				expect(errors[0]?.error).toContain("boom from interval");
			} finally {
				vi.useRealTimers();
			}
		});

		it("contains a throwing timeout callback and reports it once", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const errors: ExtensionError[] = [];
				runner.onError(err => errors.push(err));

				runner.createContext().setTimeout(() => {
					throw new Error("boom from timeout");
				}, 500);

				expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
				expect(errors).toHaveLength(1);
				expect(errors[0]?.event).toBe("timeout_callback");
				expect(errors[0]?.error).toContain("boom from timeout");
			} finally {
				vi.useRealTimers();
			}
		});

		it("clearTimer stops a managed interval from firing again", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const ctx = runner.createContext();
				let ticks = 0;
				const timer = ctx.setInterval(() => {
					ticks += 1;
				}, 1000);

				vi.advanceTimersByTime(1000);
				expect(ticks).toBe(1);

				ctx.clearTimer(timer);
				vi.advanceTimersByTime(3000);
				expect(ticks).toBe(1);
			} finally {
				vi.useRealTimers();
			}
		});

		it("clearManagedTimers cancels every outstanding timer on teardown", () => {
			vi.useFakeTimers();
			try {
				const runner = new ExtensionRunner(
					[],
					new ExtensionRuntime(),
					tempDir.path(),
					sessionManager,
					modelRegistry,
				);
				const ctx = runner.createContext();
				let intervalTicks = 0;
				let timeoutFired = false;
				ctx.setInterval(() => {
					intervalTicks += 1;
				}, 1000);
				ctx.setTimeout(() => {
					timeoutFired = true;
				}, 1000);

				runner.clearManagedTimers();
				vi.advanceTimersByTime(5000);
				expect(intervalTicks).toBe(0);
				expect(timeoutFired).toBe(false);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("invokeTool same-tool delegation", () => {
		// Records what the native tool actually received, so the inherited abort/progress channels and
		// the caller context are observable.
		function nativeProbe(seen: { signal?: AbortSignal; onUpdate?: unknown; params?: unknown }): AgentTool {
			return {
				name: "bash",
				label: "Bash",
				description: "native bash",
				parameters: Type.Object({ command: Type.String() }),
				execute: async (_id: string, params: unknown, signal?: AbortSignal, onUpdate?: unknown) => {
					seen.params = params;
					seen.signal = signal;
					seen.onUpdate = onUpdate;
					return { content: [{ type: "text", text: "native ran" }], details: {} };
				},
			} as AgentTool;
		}

		const runnerWithNative = async (native: AgentTool) => {
			const result = await loadTestExtensions();
			const runner = new ExtensionRunner(
				result.extensions,
				result.runtime,
				tempDir.path(),
				sessionManager,
				modelRegistry,
			);
			runner.setNativeToolResolver(name =>
				name === native.name ? { tool: native, makeContext: () => ({}) as never } : undefined,
			);
			return runner;
		};

		it("inherits the wrapper call's signal and onUpdate for a bare invokeTool", async () => {
			const seen: { signal?: AbortSignal; onUpdate?: unknown; params?: unknown } = {};
			const runner = await runnerWithNative(nativeProbe(seen));
			const controller = new AbortController();
			const onUpdate = () => {};

			const ctx = runner.createContext(undefined, {
				toolName: "bash",
				signal: controller.signal,
				onUpdate,
			});
			await ctx.invokeTool?.({ command: "echo hi" });

			// Aborting the outer tool call must reach the native one, and native progress must stream.
			expect(seen.signal).toBe(controller.signal);
			expect(seen.onUpdate).toBe(onUpdate);
			expect(seen.params).toEqual({ command: "echo hi" });
		});

		it("lets explicit invokeTool options override the inherited channels", async () => {
			const seen: { signal?: AbortSignal; onUpdate?: unknown; params?: unknown } = {};
			const runner = await runnerWithNative(nativeProbe(seen));
			const outer = new AbortController();
			const inner = new AbortController();
			const innerOnUpdate = () => {};

			const ctx = runner.createContext(undefined, {
				toolName: "bash",
				signal: outer.signal,
				onUpdate: () => {},
			});
			await ctx.invokeTool?.({ command: "echo hi" }, { signal: inner.signal, onUpdate: innerOnUpdate });

			expect(seen.signal).toBe(inner.signal);
			expect(seen.onUpdate).toBe(innerOnUpdate);
		});

		it("omits invokeTool when no native built-in of that name exists", async () => {
			const runner = await runnerWithNative(nativeProbe({}));
			expect(runner.createContext(undefined, { toolName: "not_a_builtin" }).invokeTool).toBeUndefined();
			// Also absent when the context is not scoped to a tool at all.
			expect(runner.createContext().invokeTool).toBeUndefined();
		});

		it("bounds recursion per call chain", async () => {
			const runner = await runnerWithNative(nativeProbe({}));
			await expect(runner.invokeNativeTool("bash", { command: "echo hi" }, { depth: 8 })).rejects.toThrow(
				/delegation depth exceeded/,
			);
			// A fresh chain at depth 0 is unaffected by another chain's depth.
			await expect(runner.invokeNativeTool("bash", { command: "echo hi" }, { depth: 0 })).resolves.toBeDefined();
		});
	});

	describe("input attachment transforms", () => {
		const inputRunner = (handler: (event: InputEvent) => InputEventResult): ExtensionRunner => {
			const extensionPath = path.join(extensionsDir, "input-transform.ts");
			const extension: Extension = {
				path: extensionPath,
				resolvedPath: extensionPath,
				handlers: new Map([["input", [async (...args: unknown[]) => handler(args[0] as InputEvent)]]]),
				tools: new Map(),
				assistantThinkingRenderers: [],
				fileWriteFallbackHandlers: [],
				fileDeleteFallbackHandlers: [],
				messageRenderers: new Map(),
				composerShapes: new Map(),
				commands: new Map(),
				flags: new Map(),
				shortcuts: new Map(),
			};
			return new ExtensionRunner([extension], new ExtensionRuntime(), tempDir.path(), sessionManager, modelRegistry);
		};

		it("applies image-only removal independently of text", async () => {
			const runner = inputRunner(() => ({ images: [] }));
			const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

			expect(await runner.emitInput("keep text", [image], "interactive")).toEqual({ images: [] });
		});

		it("omits unchanged images from a text-only transform result", async () => {
			const runner = inputRunner(event => ({ text: event.text.toUpperCase() }));
			const image: ImageContent = { type: "image", mimeType: "image/png", data: "aW1hZ2U=" };

			expect(await runner.emitInput("rewrite me", [image], "interactive")).toEqual({ text: "REWRITE ME" });
		});
	});
});
