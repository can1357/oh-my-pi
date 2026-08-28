/**
 * `/collab` host lifecycle fires `collab_start`/`collab_end` extension events
 * and keeps `ctx.collab` (hosting/roomId) in sync, without ever handing a
 * loaded extension the room key or write token that make the link joinable
 * (see `CollabStartEvent` in extensibility/extensions/types.ts).
 *
 * Mirrors the `session_start` handler-dispatch convention used elsewhere in
 * the extension test suite (extensions-runner.test.ts): a real extension
 * module is written to disk, loaded through `loadExtensions`, and run by a
 * real `ExtensionRunner`; handler observations are recorded to a marker file
 * since the extension executes in its own module scope. `CollabHost` itself
 * runs unchanged over the in-memory relay transport used by the rest of the
 * collab suite (see ./helpers/in-memory-relay).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { CollabHost } from "@oh-my-pi/pi-coding-agent/collab/host";
import { parseCollabLink } from "@oh-my-pi/pi-coding-agent/collab/protocol";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { installInMemoryRelay, uninstallInMemoryRelay } from "./helpers/in-memory-relay";

interface RecordedEvent {
	type: "collab_start" | "collab_end";
	event: {
		type: "collab_start" | "collab_end";
		roomId: string;
		relayUrl: string;
		webLink: string;
		hasWriteToken: boolean;
	};
	collab: { hosting: boolean; roomId: string | undefined };
}

const RELAY_URL = "ws://localhost:8787";

describe("/collab host extension events", () => {
	let tempDir: TempDir;
	let markerPath: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let runner: ExtensionRunner;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-collab-extension-events-");
		markerPath = path.join(tempDir.path(), "events.jsonl");
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		fs.writeFileSync(
			path.join(extensionsDir, "record-collab-events.ts"),
			`
				import * as fs from "node:fs";

				export default function(pi) {
					const record = (type, event, ctx) => {
						fs.appendFileSync(${JSON.stringify(markerPath)}, JSON.stringify({ type, event, collab: ctx.collab }) + "\\n");
					};
					pi.on("collab_start", (event, ctx) => record("collab_start", event, ctx));
					pi.on("collab_end", (event, ctx) => record("collab_end", event, ctx));
				}
			`,
		);

		const discoveredPaths = fs
			.readdirSync(extensionsDir, { withFileTypes: true })
			.filter(entry => entry.isFile())
			.map(entry => path.join(extensionsDir, entry.name));
		const result = await loadExtensions(discoveredPaths, tempDir.path());

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory();
		runner = new ExtensionRunner(result.extensions, result.runtime, tempDir.path(), sessionManager, modelRegistry);

		installInMemoryRelay();
	});

	afterEach(() => {
		uninstallInMemoryRelay();
		authStorage.close();
		tempDir.removeSync();
	});

	function makeHostContext(): InteractiveModeContext {
		return {
			settings: { get: () => "" },
			sessionManager: {
				getSessionId: () => "sess-1",
				getCwd: () => "/tmp",
				snapshotForReplication: () => ({
					header: { type: "session", id: "sess-1", timestamp: new Date().toISOString(), cwd: "/tmp" },
					entries: [],
				}),
				onEntryAppended: undefined,
			},
			session: {
				isStreaming: false,
				queuedMessageCount: 0,
				sessionName: "test",
				model: undefined,
				thinkingLevel: undefined,
				subscribe: () => () => {},
				emitNotice: () => {},
				promptCustomMessage: () => Promise.resolve(),
				abort: () => Promise.resolve(),
				extensionRunner: runner,
			},
			eventBus: undefined,
			statusLine: {
				setCollabStatus: () => {},
				invalidate: () => {},
				getCachedContextBreakdown: () => ({ usedTokens: 0, contextWindow: 0 }),
			},
			ui: { requestRender: () => {} },
			showStatus: () => {},
			collabHost: undefined,
		} as unknown as InteractiveModeContext;
	}

	function readEvents(): RecordedEvent[] {
		if (!fs.existsSync(markerPath)) return [];
		return fs
			.readFileSync(markerPath, "utf8")
			.split("\n")
			.filter(line => line.length > 0)
			.map(line => JSON.parse(line) as RecordedEvent);
	}

	it("fires collab_start/collab_end with a secret-free payload and keeps ctx.collab in sync", async () => {
		expect(runner.createContext().collab).toEqual({ hosting: false, roomId: undefined });

		const ctx = makeHostContext();
		const host = new CollabHost(ctx);
		await host.start(RELAY_URL);

		const parsedLink = parseCollabLink(host.link);
		if ("error" in parsedLink) throw new Error(parsedLink.error);
		const keyText = Buffer.from(parsedLink.key).toString("base64url");
		const writeTokenText = parsedLink.writeToken ? Buffer.from(parsedLink.writeToken).toString("base64url") : "";

		// `runner.emit` for collab_start/collab_end is fire-and-forget (`void`), so
		// give its microtask a turn before reading the marker file back.
		await Promise.resolve();
		await Promise.resolve();

		expect(runner.createContext().collab).toEqual({ hosting: true, roomId: parsedLink.roomId });

		let events = readEvents();
		expect(events).toHaveLength(1);
		const started = events[0];
		if (!started) throw new Error("expected a recorded collab_start event");
		expect(started.type).toBe("collab_start");
		expect(started.event).toEqual({
			type: "collab_start",
			roomId: parsedLink.roomId,
			relayUrl: RELAY_URL,
			webLink: "http://localhost:8787",
			hasWriteToken: true,
		});
		// The event must never carry the room key or write token embedded in
		// `host.link`/`host.webLink` — only `roomId` (opaque, not by itself
		// sufficient to join) is safe to broadcast to every loaded extension.
		expect(started.event.webLink).not.toContain(keyText);
		expect(started.event.webLink).not.toContain(writeTokenText);
		expect(started.collab).toEqual({ hosting: true, roomId: parsedLink.roomId });

		await host.stop("test done");
		await Promise.resolve();
		await Promise.resolve();

		expect(runner.createContext().collab).toEqual({ hosting: false, roomId: undefined });

		events = readEvents();
		expect(events).toHaveLength(2);
		const ended = events[1];
		if (!ended) throw new Error("expected a recorded collab_end event");
		expect(ended.type).toBe("collab_end");
		expect(ended.event).toEqual({ ...started.event, type: "collab_end" });
		// By the time collab_end handlers run, the session has already torn down.
		expect(ended.collab).toEqual({ hosting: false, roomId: undefined });
	});

	it("does not fire collab_start/collab_end for a host that never came up", async () => {
		const ctx = makeHostContext();
		const host = new CollabHost(ctx);
		// Malformed relay URL: `start()` throws while formatting the link, before ever
		// opening a socket, so neither event should fire and hosting stays false.
		await expect(host.start("not a valid url")).rejects.toThrow();

		expect(readEvents()).toHaveLength(0);
		expect(runner.createContext().collab).toEqual({ hosting: false, roomId: undefined });
	});
});
