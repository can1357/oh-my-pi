/**
 * Interactive startup binds startup-safe extensions after the composer accepts
 * input (`deferredExtensionPaths`) and gates the first request on them. These
 * tests pin the two halves of that contract: which sources may defer, and that
 * a deferred source ends up as live as an eagerly loaded one.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	partitionStartupExtensions,
	recordStartupVerdicts,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/startup-deferral";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Registers `urlprobe://`, completion included, and logs each bind to `logPath`. */
const URL_SCHEME_EXTENSION = (logPath: string) => `
	import * as fs from "node:fs";
	export default function(pi) {
		pi.registerUrlScheme({
			scheme: "urlprobe",
			spec: { backing: "remote", selectors: "none", immutable: true },
			resolve: async url => ({ url: url.href, content: "probe", contentType: "text/plain" }),
			complete: async () => [{ value: "probe" }],
		});
		fs.appendFileSync(${JSON.stringify(logPath)}, "bound\\n");
	}
`;

const DEFERRED_TOOL_EXTENSION = (logPath: string) => `
	import * as fs from "node:fs";
	export default function(pi) {
		const { Type } = pi.typebox;
		pi.registerTool({
			name: "deferred_probe",
			label: "Deferred probe",
			description: "Registered by a startup-deferred extension.",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		});
		pi.on("session_start", () => { fs.appendFileSync(${JSON.stringify(logPath)}, "deferred\\n"); });
	}
`;

describe("startup-deferred extensions", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-deferred-ext-");
		authStorage = createInMemoryAuthStorage();
	});

	afterEach(() => {
		AgentStorage.close();
		authStorage.close();
		tempDir.removeSync();
		InternalUrlRouter.resetForTests();
	});

	it("defers only sources whose recorded verdict matches their current file", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const toolOnly = path.join(tempDir.path(), "tool-only.ts");
		const withShortcut = path.join(tempDir.path(), "with-shortcut.ts");
		const neverLoaded = path.join(tempDir.path(), "never-loaded.ts");
		fs.writeFileSync(toolOnly, DEFERRED_TOOL_EXTENSION(path.join(tempDir.path(), "unused.log")));
		fs.writeFileSync(
			withShortcut,
			`export default function(pi) { pi.registerShortcut("ctrl+shift+y", { handler: () => {} }); }`,
		);
		// The first frame replays the transcript with message and reply renderers, and link schemes
		// reach the markdown renderer at UI init: each alone keeps an extension eager.
		const drawing = {
			"link-scheme.ts": `pi.registerLinkScheme("demo-link");`,
			"message-renderer.ts": `pi.registerMessageRenderer("demo-message", () => undefined);`,
			"text-renderer.ts": `pi.registerAssistantTextRenderer(() => undefined);`,
			"thinking-renderer.ts": `pi.registerAssistantThinkingRenderer(() => undefined);`,
		};
		const drawingPaths = Object.entries(drawing).map(([name, body]) => {
			const file = path.join(tempDir.path(), name);
			fs.writeFileSync(file, `export default function(pi) { ${body} }`);
			return file;
		});
		fs.writeFileSync(neverLoaded, `export default function() {}`);

		const loaded = await loadExtensions([toolOnly, withShortcut, ...drawingPaths], tempDir.path());
		expect(loaded.errors).toEqual([]);
		await recordStartupVerdicts(storage, loaded.extensions);

		const paths = [toolOnly, withShortcut, ...drawingPaths, neverLoaded];
		expect(await partitionStartupExtensions(storage, paths, tempDir.path())).toEqual({
			eager: [withShortcut, ...drawingPaths, neverLoaded],
			deferred: [toolOnly],
		});

		// An edited source may now register something startup needs: load it eagerly again.
		fs.appendFileSync(toolOnly, "\n// edited\n");
		expect(await partitionStartupExtensions(storage, paths, tempDir.path())).toEqual({
			eager: [toolOnly, withShortcut, ...drawingPaths, neverLoaded],
			deferred: [],
		});
	});

	it("keeps an extension that registers a URL scheme eager", async () => {
		const storage = await AgentStorage.open(path.join(tempDir.path(), "agent.db"));
		const urlOnly = path.join(tempDir.path(), "url-only.ts");
		fs.writeFileSync(urlOnly, URL_SCHEME_EXTENSION(path.join(tempDir.path(), "unused.log")));

		const loaded = await loadExtensions([urlOnly], tempDir.path());
		await recordStartupVerdicts(storage, loaded.extensions);

		// Its promptDoc and composer completion must exist before the first prompt.
		expect(await partitionStartupExtensions(storage, [urlOnly], tempDir.path())).toEqual({
			eager: [urlOnly],
			deferred: [],
		});
	});

	it("releases a URL scheme a deferred bind registers after its session was disposed", async () => {
		const logPath = path.join(tempDir.path(), "bind.log");
		const deferredPath = path.join(tempDir.path(), "deferred-url.ts");
		fs.writeFileSync(deferredPath, URL_SCHEME_EXTENSION(logPath));

		const eventBus = new EventBus();
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated(),
			eventBus,
			preloadedExtensions: await loadExtensions([], tempDir.path(), eventBus),
			deferredExtensionPaths: [deferredPath],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});
		await session.dispose();

		await session.loadDeferredExtensions();

		expect(fs.readFileSync(logPath, "utf8")).toBe("bound\n");
		expect(InternalUrlRouter.instance().canHandle("urlprobe://x")).toBe(false);
	});

	it("binds a deferred extension into the live session and replays session_start to it alone", async () => {
		const logPath = path.join(tempDir.path(), "session-start.log");
		const eagerPath = path.join(tempDir.path(), "eager.ts");
		const deferredPath = path.join(tempDir.path(), "deferred.ts");
		fs.writeFileSync(
			eagerPath,
			`import * as fs from "node:fs";
			export default function(pi) {
				pi.on("session_start", () => { fs.appendFileSync(${JSON.stringify(logPath)}, "eager\\n"); });
			}`,
		);
		fs.writeFileSync(deferredPath, DEFERRED_TOOL_EXTENSION(logPath));

		const eventBus = new EventBus();
		const preloaded = await loadExtensions([eagerPath], tempDir.path(), eventBus);
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: SessionManager.inMemory(),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated(),
			eventBus,
			preloadedExtensions: preloaded,
			deferredExtensionPaths: [deferredPath],
			enableLsp: false,
			enableMCP: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			preloadedCustomToolPaths: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			toolNames: ["read"],
		});

		try {
			const runner = session.extensionRunner;
			if (!runner) throw new Error("expected an extension runner");
			await runner.emit({ type: "session_start" });
			expect(session.getAllToolNames()).not.toContain("deferred_probe");

			await session.loadDeferredExtensions();

			expect(session.getAllToolNames()).toContain("deferred_probe");
			expect(session.getEnabledToolNames()).toContain("deferred_probe");
			expect(fs.readFileSync(logPath, "utf8")).toBe("eager\ndeferred\n");
			// Subagents and forks inherit the deferred source like an eager one.
			expect(session.extensionPaths).toContain(deferredPath);
		} finally {
			await session.dispose();
		}
	});
});
