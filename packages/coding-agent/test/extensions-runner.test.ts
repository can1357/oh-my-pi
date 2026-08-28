/**
 * Tests for ExtensionRunner - conflict detection, error handling, tool wrapping.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, expectTypeOf, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@oh-my-pi/omptype/typebox";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";
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
			expect(select).toHaveBeenCalledWith(expect.stringContaining("Allow tool: dangerous_tool"), [
				"Approve",
				"Deny",
			]);
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

		it("exposes a single hashline edit path to extension gate handlers", async () => {
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
						if (typeof event.input.path !== "string") {
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
				input: "¶plans/switch-case-array-syntax.md#ABC1\n27 27\n+new content",
			});

			expect(resultMessage.content).toEqual([{ type: "text", text: "ok" }]);
			const events = fs
				.readFileSync(eventsPath, "utf8")
				.trim()
				.split("\n")
				.map(line => JSON.parse(line));
			expect(events).toEqual([
				{ path: "plans/switch-case-array-syntax.md", paths: ["plans/switch-case-array-syntax.md"] },
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
				input: "¶plans/foo.md#notatag\n27 27\n+new content",
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
				input: "¶src/secret.ts#ABC1\n27 27\n+evil content",
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
					input: "¶plans/switch-case-array-syntax.md#ABC1\n27 27\n+new content\n¶packages/coding-agent/src/main.ts#DEF2\n1 1\n+changed",
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
