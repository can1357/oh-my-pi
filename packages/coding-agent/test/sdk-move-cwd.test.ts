import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { LspConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import * as lspMuxDaemon from "@oh-my-pi/pi-coding-agent/lsp/mux/daemon";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "@oh-my-pi/pi-coding-agent/lsp/startup-events";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import { rebindMemoryBackendForCwd } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { loadEntriesFromFile } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import {
	getProjectAgentDir,
	getProjectDir,
	removeSyncWithRetries,
	setProjectDir,
	Snowflake,
	withTimeout,
} from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

function textContent(result: { content?: Array<{ type: string; text?: string }> }): string {
	return (
		result.content
			?.filter(
				(block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string",
			)
			.map(block => block.text)
			.join("\n") ?? ""
	);
}

function lspResponseBody(result: { content?: Array<{ type: string; text?: string }> }): string {
	const text = textContent(result);
	const separator = text.indexOf("\n");
	if (separator === -1) throw new Error(`Expected an LSP response body, got: ${text}`);
	return text.slice(separator + 1);
}

interface NativeLspExecutionContext {
	cwd: string;
	rootUri: string | null;
	workspaceFolders: Array<{ uri: string; name: string }> | null;
}

interface NativeLspState {
	didOpen: Record<string, number>;
}

const fakeLspFixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");

describe("createAgentSession cwd after /move", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	async function createDivergentNativeFixture(lazy: boolean) {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-native-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const home = path.join(tempDir, "home");
		const execution = path.join(tempDir, "execution");
		const agentDir = path.join(tempDir, "agent");
		const sessionStore = path.join(tempDir, "sessions");
		await Promise.all([
			Bun.write(path.join(home, "sentinel.txt"), "HOME\n"),
			Bun.write(path.join(execution, "sentinel.txt"), "EXECUTION\n"),
			Bun.write(path.join(home, "sentinel.native"), "HOME LSP\n"),
			Bun.write(path.join(execution, "sentinel.native"), "EXECUTION LSP\n"),
			Bun.write(path.join(home, "edit.native"), "home edit\n"),
			Bun.write(path.join(execution, "edit.native"), "before edit\n"),
		]);

		const sessionManager = SessionManager.create(home, sessionStore);
		await sessionManager.ensureOnDisk();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted home session");
		const initialArtifactId = await sessionManager.saveArtifact("before execution split", "read");
		if (!initialArtifactId) throw new Error("Expected an initial artifact");
		const initialArtifactPath = await sessionManager.getArtifactPath(initialArtifactId);
		if (!initialArtifactPath) throw new Error("Expected an initial artifact path");
		sessionManager.setCwdWithoutRelocation(execution);

		const serverConfig: ServerConfig = {
			command: process.execPath,
			resolvedCommand: process.execPath,
			args: ["run", fakeLspFixturePath],
			fileTypes: [".native"],
			rootMarkers: [],
			warmupTimeoutMs: 5_000,
		};
		const executionConfig: LspConfig = { servers: { "fake-native": serverConfig } };
		const homeConfig: LspConfig = { servers: {} };
		lspConfig.configCache.set(path.resolve(execution), executionConfig);
		lspConfig.configCache.set(path.resolve(home), homeConfig);
		vi.spyOn(lspConfig, "loadConfig").mockImplementation(cwd =>
			path.resolve(cwd) === path.resolve(execution) ? executionConfig : homeConfig,
		);
		vi.spyOn(lspClient, "setSharedLspEnabled").mockImplementation(() => {});
		vi.spyOn(lspMuxDaemon, "connectSharedLspTransport").mockResolvedValue(null);

		const eventBus = new EventBus();
		const startup = Promise.withResolvers<LspStartupEvent>();
		const unsubscribe = eventBus.on(LSP_STARTUP_EVENT_CHANNEL, event => {
			startup.resolve(event as LspStartupEvent);
		});
		const authStorage = createInMemoryAuthStorage();
		let session: AgentSession | undefined;
		let disposed = false;
		const dispose = async (): Promise<void> => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			try {
				if (session) await session.dispose();
				else await sessionManager.close();
			} finally {
				try {
					await Promise.all([
						lspClient.shutdownStaleClients(home, []),
						lspClient.shutdownStaleClients(execution, []),
					]);
				} finally {
					lspConfig.configCache.delete(path.resolve(home));
					lspConfig.configCache.delete(path.resolve(execution));
					authStorage.close();
					vi.restoreAllMocks();
				}
			}
		};

		try {
			const created = await createAgentSession({
				cwd: home,
				agentDir,
				sessionManager,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
				settings: Settings.isolated({
					"async.enabled": false,
					"bash.autoBackground.enabled": false,
					"bashInterceptor.enabled": false,
					"eval.autoBackground.enabled": false,
					"lsp.diagnosticsOnEdit": true,
					"lsp.diagnosticsOnWrite": true,
					"lsp.formatOnWrite": false,
					"lsp.lazy": lazy,
					"startup.quiet": false,
				}),
				model: getBundledModel("openai", "gpt-4o-mini"),
				eventBus,
				hasUI: true,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: true,
				skipPythonPreflight: true,
				rules: [],
				preloadedCustomToolPaths: [],
				toolNames: ["read", "write", "edit", "bash", "eval", "lsp"],
			});
			session = created.session;
			return {
				...created,
				home,
				execution,
				sessionFile,
				sessionManager,
				initialArtifactId,
				initialArtifactPath,
				serverConfig,
				startup: startup.promise,
				dispose,
			};
		} catch (error) {
			await dispose();
			throw error;
		}
	}

	it.each(["disabled", "empty", "failed"] as const)(
		"drops source Hindsight context after cwd rebind when destination recall is %s",
		async destinationRecall => {
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-memory-prompt-move-"));
			tempDirs.push(tempDir);
			const cwdA = path.join(tempDir, "cwd-a");
			const cwdB = path.join(tempDir, "cwd-b");
			const agentDir = path.join(tempDir, "agent");
			let moved = false;
			const recalledBanks: string[] = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const pathname = new URL(request.url).pathname;
					if (request.method === "PUT") return Response.json({});
					if (pathname.endsWith("/mental-models")) {
						return Response.json({
							items: [{ id: "source-model", name: "Source model", content: "SOURCE-MODEL-CANARY" }],
						});
					}
					if (pathname.endsWith("/memories/recall")) {
						recalledBanks.push(pathname.split("/")[4]!);
						if (moved && destinationRecall === "failed") return new Response("unavailable", { status: 503 });
						return Response.json({ results: moved ? [] : [{ id: "source-fact", text: "SOURCE-RECALL-CANARY" }] });
					}
					return new Response("Unexpected request", { status: 404 });
				},
			});
			const authStorage = createInMemoryAuthStorage();
			let session: AgentSession | undefined;
			try {
				// The failed-recall case keeps the bank but changes configuration.
				const destinationBank = destinationRecall === "failed" ? "source" : "destination";
				await Promise.all(
					[cwdA, cwdB].map(cwd =>
						Bun.write(
							path.join(getProjectAgentDir(cwd), "config.yml"),
							Bun.YAML.stringify({
								memory: { backend: "hindsight" },
								hindsight: {
									apiUrl: server.url.href,
									bankId: cwd === cwdA ? "source" : destinationBank,
									autoRecall: cwd === cwdA || destinationRecall !== "disabled",
									autoRetain: false,
									mentalModelsEnabled: cwd === cwdA,
									mentalModelAutoSeed: false,
								},
							}),
						),
					),
				);
				const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
				const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
				authStorage.setRuntimeApiKey("openai", "test-key");
				({ session } = await createAgentSession({
					cwd: cwdA,
					agentDir,
					sessionManager,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
					settings,
					model: getBundledModel("openai", "gpt-4o-mini"),
					toolNames: ["read"],
					disableExtensionDiscovery: true,
					skills: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
					rules: [],
					preloadedCustomToolPaths: [],
				}));
				const model = createMockModel({ handler: { content: ["ok"] } });
				session.agent.streamFn = model.stream;
				await session.getHindsightSessionState()?.mentalModelsLoadPromise;
				await session.prompt("Summarize this project.");
				const sourcePrompt = model.calls[0]!.context.systemPrompt!.join("\n");
				expect(sourcePrompt).toContain("SOURCE-RECALL-CANARY");
				expect(sourcePrompt).toContain("SOURCE-MODEL-CANARY");

				moved = true;
				await sessionManager.moveTo(cwdB);
				await settings.reloadForCwd(cwdB);
				// Rebinding must clear memory without depending on a later skill/tool refresh.
				await rebindMemoryBackendForCwd(session);
				expect(session.getHindsightSessionState()?.bankId).toBe(destinationBank);
				const movedPrompt = session.agent.state.systemPrompt.join("\n");
				await session.prompt("Summarize the destination project.");
				expect(model.calls).toHaveLength(2);
				const destinationPrompt = model.calls[1]!.context.systemPrompt!.join("\n");
				expect(recalledBanks).toEqual(destinationRecall === "disabled" ? ["source"] : ["source", destinationBank]);
				for (const prompt of [movedPrompt, destinationPrompt]) {
					expect(prompt).not.toContain("SOURCE-RECALL-CANARY");
					expect(prompt).not.toContain("SOURCE-MODEL-CANARY");
					expect(prompt).toContain("# Memory");
				}
			} finally {
				await session?.dispose();
				authStorage.close();
				await server.stop(true);
			}
		},
	);

	it("runs tools from the moved session directory", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `pi-sdk-move-cwd-${Snowflake.next()}-`));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		fs.mkdirSync(cwdA, { recursive: true });
		fs.mkdirSync(cwdB, { recursive: true });

		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir: tempDir,
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["bash"],
		});

		try {
			await sessionManager.moveTo(cwdB);

			const bashTool = session.getToolByName("bash");
			if (!bashTool) throw new Error("Expected bash tool");
			const result = await bashTool.execute("pwd-after-move", { command: "pwd" });

			expect(textContent(result)).toContain(cwdB);
		} finally {
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});
	it.each(["hindsight", "mnemopi"] as const)("keeps %s disabled in restricted sessions after /move", async backend => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-sdk-restricted-memory-move-"));
		tempDirs.push(tempDir);
		const cwdA = path.join(tempDir, "cwd-a");
		const cwdB = path.join(tempDir, "cwd-b");
		const agentDir = path.join(tempDir, "agent");
		await Promise.all(
			[cwdA, cwdB].map(cwd =>
				Bun.write(
					path.join(getProjectAgentDir(cwd), "config.yml"),
					Bun.YAML.stringify({
						memory: { backend },
						hindsight: { apiUrl: "http://127.0.0.1:1", mentalModelsEnabled: false },
						mnemopi: { noEmbeddings: true, llmMode: "none" },
					}),
				),
			),
		);
		const settings = await Settings.loadIsolated({ cwd: cwdA, agentDir });
		const sessionManager = SessionManager.create(cwdA, path.join(tempDir, "sessions"));
		const authStorage = createInMemoryAuthStorage();
		const { session } = await createAgentSession({
			cwd: cwdA,
			agentDir,
			sessionManager,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			restrictToolNames: true,
			toolNames: ["read"],
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
		});
		const originalProjectDir = getProjectDir();
		try {
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			const output: string[] = [];
			await executeAcpBuiltinSlashCommand("/move " + cwdB, {
				session,
				sessionManager,
				settings,
				cwd: cwdA,
				output: text => {
					output.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			});
			expect(output.join("\n")).toContain("Moved to ");
			expect(sessionManager.getCwd()).toBe(cwdB);
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			// Explicit backend reapplication must preserve the same startup policy.
			await session.applyMemoryBackend();
			expect(session.getHindsightSessionState()).toBeUndefined();
			expect(session.getMnemopiSessionState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		} finally {
			setProjectDir(originalProjectDir);
			try {
				await session.dispose();
			} finally {
				authStorage.close();
			}
		}
	});

	it("keeps native execution on the divergent cwd while persistence stays home", async () => {
		const fixture = await createDivergentNativeFixture(false);
		try {
			const startupEvent = await withTimeout(fixture.startup, 10_000, "Timed out waiting for native LSP warmup");
			if (startupEvent.type === "failed") throw new Error(startupEvent.error);
			expect(startupEvent.servers).toEqual([
				expect.objectContaining({ name: "fake-native", status: "ready", fileTypes: [".native"] }),
			]);
			expect(fixture.lspServers).toEqual([
				expect.objectContaining({ name: "fake-native", status: "ready", fileTypes: [".native"] }),
			]);

			const bashTool = fixture.session.getToolByName("bash");
			const readTool = fixture.session.getToolByName("read");
			const writeTool = fixture.session.getToolByName("write");
			const editTool = fixture.session.getToolByName("edit");
			const evalTool = fixture.session.getToolByName("eval");
			const lspTool = fixture.session.getToolByName("lsp");
			if (!bashTool || !readTool || !writeTool || !editTool || !evalTool || !lspTool) {
				throw new Error("Expected native bash/read/write/edit/eval/lsp tools");
			}

			const bashResult = await bashTool.execute("native-cwd-bash", { command: "pwd" });
			expect(bashResult.isError).not.toBe(true);
			expect(textContent(bashResult)).toContain(fixture.execution);

			const readResult = await readTool.execute("native-cwd-read", { path: "sentinel.txt" });
			expect(readResult.isError).not.toBe(true);
			expect(textContent(readResult)).toContain("EXECUTION");
			expect(textContent(readResult)).not.toContain("HOME");

			const writtenContent = "written through execution\n";
			const writeResult = await writeTool.execute("native-cwd-write", {
				path: "written.native",
				content: writtenContent,
			});
			expect(writeResult.isError).not.toBe(true);
			expect(await Bun.file(path.join(fixture.execution, "written.native")).text()).toBe(writtenContent);
			expect(await Bun.file(path.join(fixture.home, "written.native")).exists()).toBe(false);

			const editReadResult = await readTool.execute("native-cwd-edit-read", { path: "edit.native" });
			expect(editReadResult.isError).not.toBe(true);
			const editHeader = textContent(editReadResult)
				.split("\n")
				.find(line => /^\[edit\.native#[0-9A-F]{4}\]$/.test(line));
			if (!editHeader) throw new Error("Expected a hashline header for edit.native");
			const editResult = await editTool.execute("native-cwd-edit", {
				input: `${editHeader}\nPUT 1.=1:\n+edited through execution\n`,
			});
			expect(editResult.isError).not.toBe(true);
			expect(await Bun.file(path.join(fixture.execution, "edit.native")).text()).toBe("edited through execution\n");
			expect(await Bun.file(path.join(fixture.home, "edit.native")).text()).toBe("home edit\n");

			const evalResult = await evalTool.execute("native-cwd-eval", {
				language: "js",
				code: 'display(await tool.read({ path: "sentinel.txt" }))',
			});
			expect(evalResult.isError).not.toBe(true);
			expect(textContent(evalResult)).toContain("EXECUTION");
			expect(textContent(evalResult)).not.toContain("HOME");

			const contextResult = await lspTool.execute("native-cwd-lsp-context", {
				action: "request",
				file: "sentinel.native",
				query: "test/executionContext",
			});
			expect(contextResult.isError).not.toBe(true);
			const executionContext = JSON.parse(lspResponseBody(contextResult)) as NativeLspExecutionContext;
			expect(executionContext.cwd).toBe(fs.realpathSync(fixture.execution));
			expect(executionContext.rootUri).toBe(fileToUri(fixture.execution));
			expect(executionContext.workspaceFolders).toContainEqual({
				uri: fileToUri(fixture.execution),
				name: path.basename(fixture.execution),
			});

			for (const [fileName, expectedContent] of [
				["sentinel.native", "EXECUTION LSP\n"],
				["written.native", writtenContent],
				["edit.native", "edited through execution\n"],
			] as const) {
				const documentResult = await lspTool.execute(`native-cwd-lsp-document-${fileName}`, {
					action: "request",
					file: "sentinel.native",
					query: "test/documentText",
					payload: JSON.stringify({ uri: fileToUri(path.join(fixture.execution, fileName)) }),
				});
				expect(documentResult.isError).not.toBe(true);
				expect(lspResponseBody(documentResult)).toBe(expectedContent);
			}

			const stateResult = await lspTool.execute("native-cwd-lsp-state", {
				action: "request",
				file: "sentinel.native",
				query: "test/state",
			});
			expect(stateResult.isError).not.toBe(true);
			const state = JSON.parse(lspResponseBody(stateResult)) as NativeLspState;
			const openedUris = Object.keys(state.didOpen);
			expect(openedUris).toEqual(
				expect.arrayContaining([
					fileToUri(path.join(fixture.execution, "sentinel.native")),
					fileToUri(path.join(fixture.execution, "written.native")),
					fileToUri(path.join(fixture.execution, "edit.native")),
				]),
			);
			expect(openedUris.every(uri => !uri.startsWith(`${fileToUri(fixture.home)}/`))).toBe(true);

			fixture.sessionManager.appendMessage({
				role: "user",
				content: "persist after native execution",
				timestamp: Date.now(),
			});
			await fixture.sessionManager.flush();
			const secondArtifactId = await fixture.sessionManager.saveArtifact("after execution split", "bash");
			if (!secondArtifactId) throw new Error("Expected a second artifact");
			const secondArtifactPath = await fixture.sessionManager.getArtifactPath(secondArtifactId);
			if (!secondArtifactPath) throw new Error("Expected a second artifact path");
			const persistedHeader = (await loadEntriesFromFile(fixture.sessionFile)).find(
				entry => entry.type === "session",
			);
			if (!persistedHeader) throw new Error("Expected a persisted session header");

			expect(fixture.sessionManager.getCwd()).toBe(path.resolve(fixture.execution));
			expect(fixture.sessionManager.getSessionHome()).toBe(path.resolve(fixture.home));
			expect(fixture.sessionManager.getSessionFile()).toBe(fixture.sessionFile);
			expect(persistedHeader.cwd).toBe(path.resolve(fixture.home));
			expect(path.dirname(fixture.initialArtifactPath)).toBe(fixture.sessionFile.slice(0, -6));
			expect(path.dirname(secondArtifactPath)).toBe(fixture.sessionFile.slice(0, -6));
			expect(await Bun.file(fixture.initialArtifactPath).text()).toBe("before execution split");
			expect(await Bun.file(secondArtifactPath).text()).toBe("after execution split");
			expect(await Bun.file(path.join(fixture.home, "sentinel.txt")).text()).toBe("HOME\n");
			expect(await Bun.file(path.join(fixture.home, "sentinel.native")).text()).toBe("HOME LSP\n");
		} finally {
			await fixture.dispose();
		}
	}, 30_000);

	it("discovers lazy native LSP servers from execution cwd and starts there on demand", async () => {
		const fixture = await createDivergentNativeFixture(true);
		try {
			expect(fixture.lspServers).toEqual([
				expect.objectContaining({ name: "fake-native", status: "available", fileTypes: [".native"] }),
			]);
			expect(await lspClient.getActiveOrPendingClient(fixture.serverConfig, fixture.execution)).toBeUndefined();
			const lspTool = fixture.session.getToolByName("lsp");
			if (!lspTool) throw new Error("Expected native lsp tool");
			const contextResult = await lspTool.execute("native-cwd-lazy-lsp", {
				action: "request",
				file: "sentinel.native",
				query: "test/executionContext",
			});
			expect(contextResult.isError).not.toBe(true);
			const executionContext = JSON.parse(lspResponseBody(contextResult)) as NativeLspExecutionContext;
			expect(executionContext.cwd).toBe(fs.realpathSync(fixture.execution));
			expect(executionContext.rootUri).toBe(fileToUri(fixture.execution));
			expect(executionContext.workspaceFolders).toContainEqual({
				uri: fileToUri(fixture.execution),
				name: path.basename(fixture.execution),
			});
		} finally {
			await fixture.dispose();
		}
	});
});
