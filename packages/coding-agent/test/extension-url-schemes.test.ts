import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
// Type-only from the package root: the handler types an extension implements stay importable there.
import type {
	Extension,
	ExtensionAPI,
	ExtensionFactory,
	ExtensionRuntime,
	InternalUrl,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	WriteContext,
} from "@oh-my-pi/pi-coding-agent";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
	bindPreparedExtensions,
	loadExtensionFromFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { emitSessionShutdownEvent, ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { claimExtensionUrlScheme } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/url-schemes";
import { InternalUrlRouter } from "@oh-my-pi/pi-coding-agent/internal-urls/router";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { getInternalUrlSuggestions } from "@oh-my-pi/pi-tui/prompt/internal-url-autocomplete";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * Contract: `pi.registerUrlScheme` routes `read`, `write` and composer completion of its scheme to
 * the extension's handler with the caller's context; a scheme belongs to one extension source,
 * every load of which may register it, and each call reaches the load of the calling session. A
 * suspended load stops serving until it resumes; a torn-down load leaves the process-global router.
 */
function runtime(): ExtensionRuntime {
	return { flagValues: new Map(), pendingProviderRegistrations: [] } as unknown as ExtensionRuntime;
}

/** Bind `factory` as a load of the path-backed source `source`, as for an extension file. */
async function load(source: string, factory: ExtensionFactory = () => {}): Promise<Extension> {
	const { extensions, errors } = await bindPreparedExtensions(
		[{ path: source, resolvedPath: source, factory, error: null }],
		"/tmp",
		new EventBus(),
		runtime(),
	);
	if (errors[0]) throw new Error(errors[0].error);
	return extensions[0];
}

/** Load `source` and keep its API so a test can register after the factory returns. */
async function loadWithApi(source: string): Promise<{ extension: Extension; pi: ExtensionAPI }> {
	let api: ExtensionAPI | undefined;
	const extension = await load(source, pi => {
		api = pi;
	});
	if (!api) throw new Error("factory did not run");
	return { extension, pi: api };
}

/** A runner adopting `extensions` for the session `sessionId`, as a session's creation does. */
function sessionRunner(sessionId: string, extensions: Extension[]): ExtensionRunner {
	return new ExtensionRunner(
		extensions,
		runtime(),
		"/tmp",
		{ getCwd: () => "/tmp", getSessionId: () => sessionId } as never,
		{} as never,
	);
}

/** Read-only scheme whose resources name the handler that served them. */
function readOnly(scheme: string, label: string): ProtocolHandler {
	return {
		scheme,
		spec: { backing: "remote", selectors: "none", immutable: true },
		resolve: async (url: InternalUrl) => ({
			url: url.href,
			content: `${label}:${url.href}`,
			contentType: "text/plain",
		}),
	};
}

/** Writable scheme recording which handler took each write. */
function writable(scheme: string, label: string, writes: string[]): ProtocolHandler {
	return {
		...readOnly(scheme, label),
		spec: {
			backing: "remote",
			selectors: "none",
			immutable: false,
			write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "write" },
		},
		write: async (_url, content) => {
			writes.push(`${label}:${content}`);
		},
		complete: async () => [{ value: label }],
	};
}

function served(scheme: string, context?: ResolveContext): Promise<string> {
	return InternalUrlRouter.instance()
		.resolve(`${scheme}://x`, context)
		.then(resource => resource.content);
}

beforeEach(() => {
	InternalUrlRouter.resetForTests();
});

afterEach(() => {
	InternalUrlRouter.resetForTests();
});

describe("pi.registerUrlScheme routing", () => {
	let tmpDir: string;

	beforeAll(async () => {
		await Settings.init({ inMemory: true });
	});

	beforeEach(async () => {
		tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extension-url-schemes-"));
	});

	afterEach(async () => {
		await removeWithRetries(tmpDir);
	});

	it("routes read, write and composer completion to the handler with the caller's context", async () => {
		const reads: ResolveContext[] = [];
		const writes: Array<{ href: string; content: string; context: WriteContext | undefined }> = [];
		const completions: Array<{ query: string | undefined; context: ResolveContext | undefined }> = [];
		const handler: ProtocolHandler = {
			scheme: "murmur",
			spec: {
				backing: "remote",
				selectors: "none",
				immutable: false,
				write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "write" },
			},
			resolve: async (url, context) => {
				if (context) reads.push(context);
				return { url: url.href, content: `inbox of ${url.host}`, contentType: "text/plain" };
			},
			write: async (url, content, context) => {
				writes.push({ href: url.href, content, context });
			},
			complete: async (query, context) => {
				completions.push({ query, context });
				return [{ value: "peer-a" }, { value: "other" }];
			},
		};
		const extension = await load("murmur-ext", pi => {
			pi.registerUrlScheme(handler);
		});
		sessionRunner("session-1", [extension]);
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionId: () => "session-1",
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			settings: Settings.isolated({}),
			enableLsp: false,
		};

		const read = await new ReadTool(session).execute("read-1", { path: "murmur://peer-a" });
		expect(read.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n")).toContain(
			"inbox of peer-a",
		);
		expect(reads.at(-1)).toMatchObject({ cwd: tmpDir, sessionFile: path.join(tmpDir, "session.jsonl"), session });

		const write = new WriteTool(session);
		expect(write.approval({ path: "murmur://peer-a", content: "hi" })).toBe("write");
		await write.execute("write-1", { path: "murmur://peer-a", content: "hi" });
		expect(writes).toHaveLength(1);
		expect(writes[0]).toMatchObject({ href: "murmur://peer-a", content: "hi" });
		expect(writes[0]?.context).toMatchObject({ cwd: tmpDir, session });

		const suggestions = await getInternalUrlSuggestions("ask murmur://pe", undefined, undefined, () => ({
			cwd: tmpDir,
			sessionId: "session-1",
		}));
		expect(suggestions?.items.map(item => item.value)).toEqual(["murmur://peer-a"]);
		expect(completions.at(-1)).toMatchObject({ query: "pe", context: { cwd: tmpDir, sessionId: "session-1" } });
	});

	it("denies writes to a read-only extension scheme at the approval gate", async () => {
		await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const write = new WriteTool({ cwd: tmpDir, hasUI: false, settings: Settings.isolated({}) } as ToolSession);
		expect(write.approval({ path: "murmur://peer-a", content: "hi" })).toMatchObject({ policy: "deny" });
	});

	it("routes each session's calls to its own load of the source, and none to a session without one", async () => {
		const writes: string[] = [];
		const root = await load("murmur-ext", pi => {
			pi.registerUrlScheme(writable("murmur", "root", writes));
		});
		const subagent = await load("murmur-ext", pi => {
			pi.registerUrlScheme(writable("murmur", "subagent", writes));
		});
		sessionRunner("root-session", [root]);
		sessionRunner("subagent-session", [subagent]);
		const router = InternalUrlRouter.instance();

		expect(await served("murmur", { sessionId: "subagent-session" })).toBe("subagent:murmur://x");
		expect(await served("murmur", { sessionId: "root-session" })).toBe("root:murmur://x");
		await router.write("murmur://x", "hi", {
			session: { getSessionId: () => "subagent-session" } as unknown as ToolSession,
		});
		expect(writes).toEqual(["subagent:hi"]);
		expect(await router.complete("murmur", "", { sessionId: "subagent-session" })).toEqual([{ value: "subagent" }]);
		// A caller that names no session reaches the earliest load.
		expect(await served("murmur")).toBe("root:murmur://x");

		// A session with no load of the source gets no service.
		await expect(served("murmur", { sessionId: "other-session" })).rejects.toThrow(
			"murmur:// is not available in this session",
		);
		expect(await router.complete("murmur", "", { sessionId: "other-session" })).toEqual([]);
	});

	it("locates a read's display target through the reading session's own load", async () => {
		const linkable = (label: string): ProtocolHandler => ({
			...readOnly("murmur", label),
			spec: { backing: "remote", selectors: "none", immutable: true, linkable: true },
			locateSync: () => `/tmp/${label}`,
		});
		const root = await load("murmur-ext", pi => {
			pi.registerUrlScheme(linkable("root"));
		});
		const subagent = await load("murmur-ext", pi => {
			pi.registerUrlScheme(linkable("subagent"));
		});
		sessionRunner("root-session", [root]);
		sessionRunner("subagent-session", [subagent]);
		const session: ToolSession = {
			cwd: tmpDir,
			hasUI: false,
			getSessionFile: () => path.join(tmpDir, "session.jsonl"),
			getSessionId: () => "subagent-session",
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tmpDir, "artifacts"),
			settings: Settings.isolated({}),
			enableLsp: false,
		};

		const read = await new ReadTool(session).execute("read-1", { path: "murmur://x" });
		expect(read.details?.displayTarget).toBe("/tmp/subagent");
	});

	it("documents the scheme through the earliest active registration that has docs", async () => {
		const host: SchemeHost = {
			skillUriAccess: false,
			ruleCount: 0,
			securityEnabled: false,
			settingsApproval: false,
			outReplies: false,
			subagent: false,
		};
		const documented = (label: string): ProtocolHandler => ({
			...readOnly("murmur", label),
			promptDoc: () => `murmur docs from ${label}`,
		});
		await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const first = await load("murmur-ext", pi => {
			pi.registerUrlScheme(documented("first"));
		});
		await load("murmur-ext", pi => {
			pi.registerUrlScheme(documented("second"));
		});
		const runner = sessionRunner("first-session", [first]);
		const docs = () =>
			InternalUrlRouter.instance()
				.describe(host)
				.filter(line => line.startsWith("murmur docs"));
		expect(docs()).toEqual(["murmur docs from first"]);

		runner.setSuspendedExtensions(() => true);
		expect(docs()).toEqual(["murmur docs from second"]);
	});

	it("serves a session's own completion even when the earliest registration has none", async () => {
		const root = await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const subagent = await load("murmur-ext", pi => {
			pi.registerUrlScheme({ ...readOnly("murmur", "subagent"), complete: async () => [{ value: "peer" }] });
		});
		sessionRunner("root-session", [root]);
		sessionRunner("subagent-session", [subagent]);
		const router = InternalUrlRouter.instance();

		expect(await router.complete("murmur", "", { sessionId: "subagent-session" })).toEqual([{ value: "peer" }]);
		expect(await router.complete("murmur", "", { sessionId: "root-session" })).toEqual([]);
	});
});

describe("pi.registerUrlScheme ownership", () => {
	it("rejects OMP-owned, standard, malformed and RPC-host schemes", async () => {
		const { pi } = await loadWithApi("murmur-ext");
		// "c" would capture the Windows drive path C:/… as c://….
		for (const scheme of ["local", "Agent", "https", "1bad", "c"]) {
			expect(() => pi.registerUrlScheme(readOnly(scheme, "ext"))).toThrow("registerUrlScheme");
		}
		const bridge = new RpcHostUriBridge(() => {});
		bridge.setSchemes([{ scheme: "db" }]);
		expect(() => pi.registerUrlScheme(readOnly("db", "ext"))).toThrow("registered outside extensions");
		bridge.clear("test cleanup");
		// The rejected registrations left the built-in and host handlers in place.
		expect(InternalUrlRouter.instance().fileWritable("local://x")).toBe(true);
	});

	it("rejects standard schemes in the claim itself, after lowercasing", () => {
		const owner = { source: "murmur-ext", label: "murmur-ext", sessionId: () => undefined };
		expect(() => claimExtensionUrlScheme(InternalUrlRouter.instance(), owner, readOnly("HTTPS", "ext"))).toThrow(
			"https:// is reserved for standard links",
		);
		expect(InternalUrlRouter.instance().getHandler("https")).toBeUndefined();
	});

	it("rejects a scheme another extension source holds", async () => {
		const owner = await loadWithApi("murmur-ext");
		const other = await loadWithApi("other-ext");
		owner.pi.registerUrlScheme(readOnly("murmur", "owner"));

		expect(() => other.pi.registerUrlScheme(readOnly("murmur", "other"))).toThrow(
			"murmur:// is registered by extension murmur-ext",
		);
		expect(await served("murmur")).toBe("owner:murmur://x");
	});

	it("tells unrelated inline factories apart even when their positional names collide", async () => {
		const first: ExtensionFactory = pi => {
			pi.registerUrlScheme(readOnly("murmur", "first"));
		};
		const unrelated: ExtensionFactory = pi => {
			pi.registerUrlScheme(readOnly("murmur", "unrelated"));
		};
		// Inline source ids restart at <inline-0> in every createAgentSession.
		await loadExtensionFromFactory(first, "/tmp", new EventBus(), runtime(), "<inline-0>");
		await expect(
			loadExtensionFromFactory(unrelated, "/tmp", new EventBus(), runtime(), "<inline-0>"),
		).rejects.toThrow("murmur:// is registered by extension <inline-0>");
		expect(await served("murmur")).toBe("first:murmur://x");

		// A child session rebinding the same prepared factory shares the scheme.
		const child = await bindPreparedExtensions(
			[{ path: "<inline-0>", resolvedPath: "<inline-0>", factory: first, error: null }],
			"/tmp",
			new EventBus(),
			runtime(),
		);
		expect(child.errors).toEqual([]);
		expect(child.extensions).toHaveLength(1);
	});

	it("keeps an extension-held scheme out of RPC host registration", async () => {
		const root = await loadWithApi("murmur-ext");
		root.pi.registerUrlScheme(readOnly("murmur", "root"));
		const bridge = new RpcHostUriBridge(() => {});

		expect(() => bridge.setSchemes([{ scheme: "db" }, { scheme: "Murmur" }])).toThrow(
			"Host URI scheme is registered by extension murmur-ext: murmur://",
		);
		expect(bridge.getSchemes()).toEqual([]);
		expect(InternalUrlRouter.instance().canHandle("db://x")).toBe(false);
		expect(await served("murmur")).toBe("root:murmur://x");
		// The claim still matches the router, so another load of the source joins it and serves its session.
		const subagent = await loadWithApi("murmur-ext");
		subagent.pi.registerUrlScheme(readOnly("murmur", "subagent"));
		sessionRunner("subagent-session", [subagent.extension]);
		expect(await served("murmur", { sessionId: "subagent-session" })).toBe("subagent:murmur://x");
		bridge.clear("test cleanup");
	});

	it("shares a scheme across loads of one source until the last load releases it", async () => {
		const root = await loadWithApi("murmur-ext");
		const subagent = await loadWithApi("murmur-ext");
		const releaseRoot = root.pi.registerUrlScheme(readOnly("murmur", "root"));
		subagent.pi.registerUrlScheme(readOnly("murmur", "subagent"));
		expect(await served("murmur")).toBe("root:murmur://x");

		releaseRoot();
		releaseRoot();
		root.extension.registrations?.release();
		expect(await served("murmur")).toBe("subagent:murmur://x");

		subagent.extension.registrations?.release();
		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);

		// A stale release never removes a later owner's registration.
		const next = await loadWithApi("other-ext");
		next.pi.registerUrlScheme(readOnly("murmur", "next"));
		releaseRoot();
		expect(await served("murmur")).toBe("next:murmur://x");
	});
});

describe("pi.registerUrlScheme suspension", () => {
	it("leaves the router while its only load is suspended and returns on resume", async () => {
		const extension = await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const runner = sessionRunner("root-session", [extension]);

		runner.setSuspendedExtensions(() => true);
		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);

		runner.setSuspendedExtensions(() => false);
		expect(await served("murmur", { sessionId: "root-session" })).toBe("root:murmur://x");
	});

	it("stops routing a suspended session through its load while another session's load serves on", async () => {
		const root = await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const subagent = await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "subagent"));
		});
		const rootRunner = sessionRunner("root-session", [root]);
		sessionRunner("subagent-session", [subagent]);

		rootRunner.setSuspendedExtensions(() => true);
		await expect(served("murmur", { sessionId: "root-session" })).rejects.toThrow(
			"murmur:// is not available in this session",
		);
		expect(await served("murmur", { sessionId: "subagent-session" })).toBe("subagent:murmur://x");
		expect(await served("murmur")).toBe("subagent:murmur://x");

		rootRunner.setSuspendedExtensions(() => false);
		expect(await served("murmur", { sessionId: "root-session" })).toBe("root:murmur://x");
		expect(await served("murmur")).toBe("root:murmur://x");
	});
});

describe("pi.registerUrlScheme teardown", () => {
	it("leaves the router on session shutdown, suspended loads included", async () => {
		const extension = await load("murmur-ext", pi => {
			pi.registerUrlScheme(readOnly("murmur", "root"));
		});
		const runner = sessionRunner("root-session", [extension]);
		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(true);
		runner.setSuspendedExtensions(() => true);

		await emitSessionShutdownEvent(runner);
		runner.setSuspendedExtensions(() => false);

		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);
	});

	it("leaves the router when the registering factory throws", async () => {
		await expect(
			load("murmur-ext", pi => {
				pi.registerUrlScheme(readOnly("murmur", "failed"));
				throw new Error("factory failed");
			}),
		).rejects.toThrow("factory failed");

		expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);
	});

	it("keeps a caller's preloaded scheme out of the router after a failed startup, and back once a retry adopts it", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "extension-url-schemes-preloaded-"));
		const authStorage = createInMemoryAuthStorage();
		try {
			const eventBus = new EventBus();
			const preloaded = await loadExtensions([], cwd, eventBus);
			preloaded.extensions.push(
				await loadExtensionFromFactory(
					pi => {
						pi.registerUrlScheme(readOnly("murmur", "preloaded"));
						// Fails startup after extension loading, as a model-restore failure does before auto-resume retries.
						pi.registerProvider("broken", { streamSimple: (() => {}) as never });
					},
					cwd,
					eventBus,
					preloaded.runtime,
					"<inline-0>",
				),
			);
			expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(true);
			const attempt = () =>
				createAgentSession({
					cwd,
					agentDir: cwd,
					authStorage,
					modelRegistry: new ModelRegistry(authStorage, path.join(cwd, "models.yml")),
					sessionManager: SessionManager.inMemory(cwd),
					settings: Settings.isolated(),
					eventBus,
					preloadedExtensions: preloaded,
					enableLsp: false,
					enableMCP: false,
					skills: [],
					rules: [],
					contextFiles: [],
					promptTemplates: [],
					slashCommands: [],
				});

			await expect(attempt()).rejects.toThrow('"api" is required');
			// The stale handler serves no later session, yet the load stays usable for the caller's retry.
			expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);

			preloaded.runtime.pendingProviderRegistrations = [];
			const { session } = await attempt();
			expect(await served("murmur")).toBe("preloaded:murmur://x");
			await session.dispose();
			expect(InternalUrlRouter.instance().canHandle("murmur://x")).toBe(false);
		} finally {
			authStorage.close();
			await removeWithRetries(cwd);
		}
	});
});
