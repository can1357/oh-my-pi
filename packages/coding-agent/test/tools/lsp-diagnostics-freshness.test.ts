import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createLspWritethrough, type FileDiagnosticsResult, FileFormatResult } from "@oh-my-pi/pi-coding-agent/lsp";
import * as lspClient from "@oh-my-pi/pi-coding-agent/lsp/client";
import * as lspConfig from "@oh-my-pi/pi-coding-agent/lsp/config";
import { formatContent } from "@oh-my-pi/pi-coding-agent/lsp/diagnostics";
import type { Diagnostic, LinterClient, LspClient, ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { EquivalentUriMap, fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { DeferredDiagnosticsEntry, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { type ptree, TempDir } from "@oh-my-pi/pi-utils";

const TEST_SERVER: ServerConfig = {
	command: "test-lsp",
	fileTypes: ["ts"],
	rootMarkers: [],
};

function createFormatter(format: (filePath: string, content: string) => Promise<string>): ServerConfig {
	return {
		command: "test-formatter",
		fileTypes: ["ts"],
		rootMarkers: [],
		createClient: () =>
			({
				format,
				lint: async () => [],
			}) satisfies LinterClient,
	};
}

function createDiagnostic(message: string): Diagnostic {
	return {
		message,
		severity: 1,
		range: {
			start: { line: 0, character: 0 },
			end: { line: 0, character: 1 },
		},
	};
}

function createClient(cwd: string, config: ServerConfig): LspClient {
	return {
		name: "test-lsp",
		cwd,
		config,
		proc: {} as ptree.ChildProcess<"pipe">,
		requestId: 0,
		diagnostics: new EquivalentUriMap(),
		diagnosticsVersion: 0,
		openFiles: new Map(),
		pendingRequests: new Map(),
		messageBuffer: new Uint8Array(),
		isReading: false,
		status: "ready",
		lastActivity: Date.now(),
		writeQueue: Promise.resolve(),
		activeProgressTokens: new Set(),
		projectLoaded: Promise.resolve(),
		resolveProjectLoaded: () => {},
	};
}

function publishDiagnostics(client: LspClient, uri: string, diagnostics: Diagnostic[], version: number | null): void {
	client.diagnostics.set(uri, { diagnostics, version });
	client.diagnosticsVersion += 1;
}

/**
 * Deterministic virtual clock that drives the production diagnostics poll/settle
 * loop and the inline-vs-deferred race without any real wall-clock waiting.
 *
 * The writethrough's only time sources are `Bun.sleep` (100ms poll interval,
 * 500ms inline budget) and `Date.now()` (poll-loop deadline + settle window).
 * {@link installVirtualTime} routes both through this clock: each `Bun.sleep(ms)`
 * advances virtual time by `ms` (firing any publish callbacks that come due) and
 * resolves on the microtask queue, so the loop spins to completion instantly and
 * `Date.now()` math stays consistent with the same advancing time. Server
 * publishes are scheduled on the clock via {@link VirtualClock.in}, so the loop's
 * own advancing drives exactly when fresh/stale diagnostics become visible.
 */
class VirtualClock {
	now: number;
	private seq = 0;
	private events: Array<{ at: number; seq: number; fn: () => void }> = [];
	constructor(base: number) {
		this.now = base;
	}
	/** Schedule `fn` to fire `delay` ms from the current virtual time. */
	in(delay: number, fn: () => void): void {
		this.events.push({ at: this.now + delay, seq: this.seq++, fn });
	}
	/** Advance virtual time by `ms`, firing every due callback in scheduled order. */
	advance(ms: number): void {
		const target = this.now + ms;
		this.events.sort((a, b) => a.at - b.at || a.seq - b.seq);
		while (this.events.length > 0 && this.events[0]!.at <= target) {
			const ev = this.events.shift()!;
			this.now = Math.max(this.now, ev.at);
			ev.fn();
		}
		this.now = target;
	}
}

/**
 * Replace real time with `clock` for the duration of a test. Restored by
 * `vi.restoreAllMocks()` in afterEach, keeping the file full-suite-safe.
 */
function installVirtualTime(clock: VirtualClock): void {
	vi.spyOn(Date, "now").mockImplementation(() => clock.now);
	vi.spyOn(Bun, "sleep").mockImplementation(((ms: number) => {
		clock.advance(ms);
		return Promise.resolve();
	}) as typeof Bun.sleep);
}

describe("LSP diagnostics freshness", () => {
	let tempDir: TempDir;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-lsp-freshness-");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	it("announces watched-file creates even when no server owns the file type", async () => {
		const filePath = path.join(tempDir.path(), "probe.module.scss");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([]);
		const notify = vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: false,
		});
		const result = await writethrough(filePath, ".section {}\n");

		expect(result).toBeUndefined();
		expect(await Bun.file(filePath).text()).toBe(".section {}\n");
		expect(notify).toHaveBeenCalledWith(
			tempDir.path(),
			[{ filePath, type: lspClient.FileChangeType.Created }],
			undefined,
		);
	});

	it("does not start an LSP server just to notify existing clients when write-time features are disabled", async () => {
		const filePath = path.join(tempDir.path(), "plain.ts");
		const loadConfig = vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		const getServers = vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		const getOrCreate = vi
			.spyOn(lspClient, "getOrCreateClient")
			.mockRejectedValue(new Error("disabled write-time LSP features must not start a server"));
		const notify = vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: false,
		});
		const result = await writethrough(filePath, "export const value = 1;\n");

		expect(result).toBeUndefined();
		expect(await Bun.file(filePath).text()).toBe("export const value = 1;\n");
		expect(notify).toHaveBeenCalledWith(
			tempDir.path(),
			[{ filePath, type: lspClient.FileChangeType.Created }],
			undefined,
		);
		expect(loadConfig).not.toHaveBeenCalled();
		expect(getServers).not.toHaveBeenCalled();
		expect(getOrCreate).not.toHaveBeenCalled();
	});

	it("does not cold-start an LSP server for custom formatting when diagnostics are disabled", async () => {
		const filePath = path.join(tempDir.path(), "formatted.ts");
		const formatter = createFormatter(async () => "export const value = 1;\n");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["test-lsp", TEST_SERVER],
			["formatter", formatter],
		]);
		const getOrCreate = vi
			.spyOn(lspClient, "getOrCreateClient")
			.mockRejectedValue(new Error("format-only writes must not cold-start an LSP server"));
		vi.spyOn(lspClient, "getActiveOrPendingClient").mockResolvedValue(undefined);
		const sync = vi.spyOn(lspClient, "syncContent").mockResolvedValue();
		const notifySaved = vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});
		const result = await writethrough(filePath, "export const value=1\n");

		expect(result?.formatter).toBe(FileFormatResult.FORMATTED);
		expect(await Bun.file(filePath).text()).toBe("export const value = 1;\n");
		expect(getOrCreate).not.toHaveBeenCalled();
		expect(sync).not.toHaveBeenCalled();
		expect(notifySaved).not.toHaveBeenCalled();
	});
	it("reports a rejected custom formatter instead of unchanged formatting", async () => {
		const filePath = path.join(tempDir.path(), "format-failure.ts");
		const formatter = createFormatter(async () => {
			throw new Error("formatter crashed");
		});
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["broken-formatter", formatter]]);
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});
		const content = "export const value=1\n";
		const result = await writethrough(filePath, content);

		expect(result?.formatter).toBe(FileFormatResult.FAILED);
		expect(await Bun.file(filePath).text()).toBe(content);
	});

	it("keeps an earlier formatter failure when a later server is unsupported", async () => {
		const failedClient = createClient(tempDir.path(), { ...TEST_SERVER, command: "capable" });
		failedClient.serverCapabilities = { documentFormattingProvider: true };
		const unsupportedClient = createClient(tempDir.path(), { ...TEST_SERVER, command: "unsupported" });
		unsupportedClient.serverCapabilities = {};
		vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(async config =>
			config.command === "capable" ? failedClient : unsupportedClient,
		);
		const sendRequest = vi.spyOn(lspClient, "sendRequest").mockRejectedValue(new Error("formatter crashed"));
		const content = "export const value=1\n";
		const failed = await formatContent(path.join(tempDir.path(), "failed.ts"), content, tempDir.path(), [
			["capable", failedClient.config],
			["unsupported", unsupportedClient.config],
		]);
		const unsupported = await formatContent(path.join(tempDir.path(), "unsupported.ts"), content, tempDir.path(), [
			["unsupported", unsupportedClient.config],
		]);

		expect(failed).toEqual({ content, failed: true, unsupported: false });
		expect(unsupported).toEqual({ content, failed: false, unsupported: true });
		expect(sendRequest).toHaveBeenCalledTimes(1);
	});

	it("keeps an already-running LSP client synchronized after custom formatting", async () => {
		const filePath = path.join(tempDir.path(), "formatted.ts");
		const client = createClient(tempDir.path(), TEST_SERVER);
		const formatter = createFormatter(async () => "export const value = 1;\n");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["test-lsp", TEST_SERVER],
			["formatter", formatter],
		]);
		const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");
		vi.spyOn(lspClient, "getActiveOrPendingClient").mockResolvedValue(client);
		const sync = vi.spyOn(lspClient, "syncContent").mockResolvedValue();
		const notifySaved = vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});
		await writethrough(filePath, "export const value=1\n");

		expect(getOrCreate).not.toHaveBeenCalled();
		expect(sync).toHaveBeenCalledWith(client, filePath, "export const value = 1;\n", expect.any(AbortSignal));
		expect(notifySaved).toHaveBeenCalledWith(client, filePath, expect.any(AbortSignal));
	});

	it("waits for an already-starting LSP client without cold-starting another one", async () => {
		const filePath = path.join(tempDir.path(), "formatted.ts");
		const client = createClient(tempDir.path(), TEST_SERVER);
		const pendingClient = Promise.withResolvers<LspClient | undefined>();
		const formatter = createFormatter(async () => "export const value = 1;\n");
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["test-lsp", TEST_SERVER],
			["formatter", formatter],
		]);
		const getOrCreate = vi.spyOn(lspClient, "getOrCreateClient");
		const getActiveOrPending = vi
			.spyOn(lspClient, "getActiveOrPendingClient")
			.mockImplementation(async () => pendingClient.promise);
		const sync = vi.spyOn(lspClient, "syncContent").mockResolvedValue();
		const notifySaved = vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: false,
		});
		const resultPromise = writethrough(filePath, "export const value=1\n");
		await Bun.sleep(0);
		expect(sync).not.toHaveBeenCalled();
		pendingClient.resolve(client);
		await resultPromise;

		expect(getOrCreate).not.toHaveBeenCalled();
		expect(getActiveOrPending).toHaveBeenNthCalledWith(1, TEST_SERVER, tempDir.path(), expect.any(AbortSignal));
		expect(getActiveOrPending).toHaveBeenNthCalledWith(2, TEST_SERVER, tempDir.path(), expect.any(AbortSignal));
		expect(sync).toHaveBeenCalledWith(client, filePath, "export const value = 1;\n", expect.any(AbortSignal));
		expect(notifySaved).toHaveBeenCalledWith(client, filePath, expect.any(AbortSignal));
	});

	it("starts cold diagnostic initialization before custom formatting completes", async () => {
		const filePath = path.join(tempDir.path(), "formatted.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		const init = Promise.withResolvers<LspClient>();
		let initStarted = false;
		const formatter = createFormatter(async () => {
			expect(initStarted).toBe(true);
			init.resolve(client);
			return "export const value = 1;\n";
		});
		const clock = new VirtualClock(Date.now());
		installVirtualTime(clock);
		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([
			["test-lsp", TEST_SERVER],
			["formatter", formatter],
		]);
		vi.spyOn(lspClient, "getOrCreateClient").mockImplementation(() => {
			initStarted = true;
			return init.promise;
		});
		vi.spyOn(lspClient, "syncContent").mockImplementation(async mockClient => {
			mockClient.openFiles.set(uri, { version: 1, languageId: "typescript" });
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			publishDiagnostics(mockClient, uri, [], 1);
		});
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockResolvedValue();

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: true,
			enableDiagnostics: true,
		});
		const result = await writethrough(filePath, "export const value=1\n");

		expect(result?.formatter).toBe(FileFormatResult.FORMATTED);
		expect(result?.messages).toEqual([]);
		expect(await Bun.file(filePath).text()).toBe("export const value = 1;\n");
	});

	it("announces batched sibling writes before syncing the diagnostic target", async () => {
		const stylesPath = path.join(tempDir.path(), "probe.module.scss");
		const tsPath = path.join(tempDir.path(), "probe.tsx");
		const tsUri = fileToUri(tsPath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		const events: string[] = [];
		const notifySignals: Array<AbortSignal | undefined> = [];

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockImplementation((_config, filePath) =>
			filePath.endsWith(".module.scss") ? [] : [["test-lsp", TEST_SERVER]],
		);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "notifyWorkspaceWatchedFiles").mockImplementation(async (_cwd, changes, notifySignal) => {
			notifySignals.push(notifySignal);
			for (const change of changes) {
				events.push(`watched:${path.basename(change.filePath)}:${change.type}`);
			}
		});
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			events.push(`sync:${path.basename(syncedFilePath)}`);
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			publishDiagnostics(mockClient, tsUri, [], mockClient.openFiles.get(tsUri)?.version ?? null);
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		await writethrough(stylesPath, ".section {}\n", undefined, undefined, { id: "batch", flush: false });
		const result = await writethrough(tsPath, 'import styles from "./probe.module.scss";\n', undefined, undefined, {
			id: "batch",
			flush: true,
		});

		expect(result?.summary).toBe("no issues");
		expect(events[0]).toBe(`watched:probe.module.scss:${lspClient.FileChangeType.Created}`);
		expect(notifySignals.some(signal => signal instanceof AbortSignal)).toBe(true);
		expect(events).toContain("sync:probe.tsx");
	});

	it("suppresses stale write diagnostics until the matching document version arrives", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		const clock = new VirtualClock(Date.now());
		installVirtualTime(clock);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			clock.in(10, () => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("stale error")], null);
			});
			clock.in(150, () => {
				publishDiagnostics(mockClient, savedUri, [], mockClient.openFiles.get(savedUri)?.version ?? null);
			});
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		const result = await writethrough(filePath, "export const value = 2;\n");

		expect(result).toBeDefined();
		expect(result?.messages).toEqual([]);
		expect(result?.summary).toBe("OK");
		expect(result?.errored).toBe(false);
		expect(await Bun.file(filePath).text()).toBe("export const value = 2;\n");
	});

	it("settles on the latest unversioned publish when the server never echoes a version", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		const clock = new VirtualClock(Date.now());
		installVirtualTime(clock);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			clock.in(10, () => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("stale error")], null);
			});
			clock.in(150, () => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("real error")], null);
			});
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		const result = await writethrough(filePath, "export const value: number = 'x';\n");

		expect(result).toBeDefined();
		expect(result?.errored).toBe(true);
		expect(result?.messages.some(m => m.includes("real error"))).toBe(true);
		expect(result?.messages.some(m => m.includes("stale error"))).toBe(false);
	});

	it("matches published diagnostics when the server renormalizes the document URI", async () => {
		const filePath = path.join(tempDir.path(), "renormalized.ts");
		const uri = fileToUri(filePath);
		const serverUri = uri.replace("/renormalized.ts", "/%72enormalized.ts");
		const client = createClient(tempDir.path(), TEST_SERVER);
		const clock = new VirtualClock(Date.now());
		installVirtualTime(clock);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			clock.in(10, () => {
				publishDiagnostics(mockClient, serverUri, [createDiagnostic("renormalized URI error")], 1);
			});
		});

		const writethrough = createLspWritethrough(tempDir.path(), {
			enableFormat: false,
			enableDiagnostics: true,
		});
		const result = await writethrough(filePath, "export const value = missing;\n");

		expect(result?.errored).toBe(true);
		expect(result?.messages.some(message => message.includes("renormalized URI error"))).toBe(true);
	});

	it("matches Windows drive-letter case and percent-encoding differences", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!platformDescriptor) throw new Error("process.platform descriptor is unavailable");
		Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
		try {
			const diagnostics = new EquivalentUriMap<string>();
			diagnostics.set("file:///c%3A/Users/serge/doc.md", "published");

			expect(diagnostics.get("file:///C:/Users/serge/doc.md")).toBe("published");
		} finally {
			Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("returns completed pull diagnostics inside the inline write window", async () => {
		const filePath = path.join(tempDir.path(), "pull-only.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		client.serverCapabilities = { diagnosticProvider: true };

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		vi.spyOn(lspClient, "notifySaved").mockResolvedValue();
		vi.spyOn(lspClient, "sendRequest").mockResolvedValue({
			kind: "full",
			items: [createDiagnostic("pull error")],
		});
		const onDeferredDiagnostics = vi.fn();
		const deferredController = new AbortController();
		const handle = {
			onDeferredDiagnostics,
			signal: deferredController.signal,
			finalize: () => {},
		};

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		const inline = await writethrough(
			filePath,
			"export const value: number = 'x';\n",
			undefined,
			undefined,
			undefined,
			() => handle,
		);
		deferredController.abort();

		expect(inline?.errored).toBe(true);
		expect(inline?.messages.some(message => message.includes("pull error"))).toBe(true);
		expect(onDeferredDiagnostics).not.toHaveBeenCalled();
	});

	it("returns promptly and delivers diagnostics via the deferred channel when the server is slow", async () => {
		const filePath = path.join(tempDir.path(), "example.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		client.openFiles.set(uri, { version: 1, languageId: "typescript" });
		const clock = new VirtualClock(Date.now());
		installVirtualTime(clock);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.diagnostics.delete(syncedUri);
			const openFile = mockClient.openFiles.get(syncedUri);
			if (openFile) {
				openFile.version += 1;
			} else {
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			}
		});
		// Publish far past the 500ms inline budget (INLINE_DIAGNOSTICS_WAIT_TIMEOUT_MS)
		// so the writethrough deterministically defers; virtual time keeps it instant.
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async (mockClient, savedFilePath) => {
			const savedUri = fileToUri(savedFilePath);
			clock.in(2000, () => {
				publishDiagnostics(mockClient, savedUri, [createDiagnostic("deferred error")], null);
			});
		});

		const late = Promise.withResolvers<FileDiagnosticsResult>();
		const handle = {
			onDeferredDiagnostics: (d: FileDiagnosticsResult) => late.resolve(d),
			signal: new AbortController().signal,
			finalize: () => {},
		};

		const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
		const inline = await writethrough(
			filePath,
			"export const value: number = 'x';\n",
			undefined,
			undefined,
			undefined,
			() => handle,
		);

		// Inline returns undefined: the writethrough deferred rather than blocking on
		// the slow publish. A result fresh within the inline budget would be returned
		// inline, so `undefined` is proof it returned promptly via the deferred path.
		expect(inline).toBeUndefined();

		// ...and the diagnostics arrive afterwards via the deferred channel.
		const lateResult = await late.promise;
		expect(lateResult.errored).toBe(true);
		expect(lateResult.messages.some(m => m.includes("deferred error"))).toBe(true);

		// The edit still landed on disk regardless of diagnostics timing.
		expect(await Bun.file(filePath).text()).toBe("export const value: number = 'x';\n");
	});

	it("returns the write tool result before slow diagnostics and queues them for the agent", async () => {
		const filePath = path.join(tempDir.path(), "write-tool.ts");
		const uri = fileToUri(filePath);
		const client = createClient(tempDir.path(), TEST_SERVER);
		const clock = new VirtualClock(Date.now());
		installVirtualTime(clock);

		vi.spyOn(lspConfig, "loadConfig").mockReturnValue({ servers: {}, idleTimeoutMs: undefined });
		vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["test-lsp", TEST_SERVER]]);
		vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
		vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
			const syncedUri = fileToUri(syncedFilePath);
			mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
		});
		vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
			clock.in(2000, () => {
				publishDiagnostics(mockClient, uri, [createDiagnostic("write tool deferred error")], null);
			});
		});

		const queued = Promise.withResolvers<DeferredDiagnosticsEntry>();
		const mutationVersions = new Map<string, number>();
		const session: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": true,
				"lsp.diagnosticsDeduplicate": true,
			}),
			enableLsp: true,
			queueDeferredDiagnostics: entry => queued.resolve(entry),
			bumpFileMutationVersion: target => {
				const version = (mutationVersions.get(target) ?? 0) + 1;
				mutationVersions.set(target, version);
				return version;
			},
			getFileMutationVersion: target => mutationVersions.get(target) ?? 0,
		};

		const result = await new WriteTool(session).execute("write-deferred", {
			path: filePath,
			content: "export const value: number = 'x';\n",
		});

		expect(result.details?.diagnostics).toBeUndefined();
		const late = await queued.promise;
		expect(late.isStale()).toBe(false);
		expect(late.errored).toBe(true);
		expect(late.messages.some(message => message.includes("write tool deferred error"))).toBe(true);
		expect(await Bun.file(filePath).text()).toBe("export const value: number = 'x';\n");
	});

	it("suppresses TypeScript project diagnostics for orphan files but keeps syntax errors", async () => {
		const server: ServerConfig = {
			...TEST_SERVER,
			rootMarkers: ["package.json", "tsconfig.json", "jsconfig.json"],
		};
		const orphanDir = TempDir.createSync("@omp-lsp-orphan-");
		try {
			const filePath = path.join(orphanDir.path(), "scratch.ts");
			const uri = fileToUri(filePath);
			const client = createClient(tempDir.path(), server);
			client.openFiles.set(uri, { version: 1, languageId: "typescript" });

			vi.spyOn(lspConfig, "loadConfig").mockReturnValue({
				servers: { "typescript-language-server": server },
				idleTimeoutMs: undefined,
			});
			vi.spyOn(lspConfig, "getServersForFile").mockReturnValue([["typescript-language-server", server]]);
			vi.spyOn(lspClient, "getOrCreateClient").mockResolvedValue(client);
			vi.spyOn(lspClient, "syncContent").mockImplementation(async (mockClient, syncedFilePath) => {
				const syncedUri = fileToUri(syncedFilePath);
				mockClient.openFiles.set(syncedUri, { version: 1, languageId: "typescript" });
			});
			vi.spyOn(lspClient, "notifySaved").mockImplementation(async mockClient => {
				const moduleDiagnostic = createDiagnostic(
					"Cannot find module 'bun:sqlite' or its corresponding type declarations.",
				);
				moduleDiagnostic.code = 2307;
				const bunDiagnostic = createDiagnostic(
					"Cannot find name 'Bun'. Do you need to install type definitions for Bun?",
				);
				bunDiagnostic.code = 2867;
				const syntaxDiagnostic = createDiagnostic("';' expected.");
				syntaxDiagnostic.code = 1005;
				mockClient.diagnostics.set(uri, {
					version: 1,
					diagnostics: [moduleDiagnostic, bunDiagnostic, syntaxDiagnostic],
				});
				mockClient.diagnosticsVersion += 1;
			});

			const writethrough = createLspWritethrough(tempDir.path(), { enableFormat: false, enableDiagnostics: true });
			const result = await writethrough(filePath, 'import { Database } from "bun:sqlite";\nawait Bun.sleep(1)\n');

			expect(result).toBeDefined();
			expect(result?.errored).toBe(true);
			expect(result?.messages.some(message => message.includes("bun:sqlite"))).toBe(false);
			expect(result?.messages.some(message => message.includes("Cannot find name 'Bun'"))).toBe(false);
			expect(result?.messages.some(message => message.includes("';' expected."))).toBe(true);
			expect(await Bun.file(filePath).text()).toBe('import { Database } from "bun:sqlite";\nawait Bun.sleep(1)\n');
		} finally {
			orphanDir.removeSync();
		}
	});
});
