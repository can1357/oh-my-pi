/**
 * Contract: `pi.registerUrlScheme` records a handler on the extension; each session serves the
 * schemes of its own active extensions through its router (read, write, composer completion,
 * system prompt), a suspended extension stops serving until it resumes, two active extensions of
 * one session registering one scheme is an error at session build, and built-in, standard,
 * malformed, repeated and RPC host schemes are refused.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
// Type-only from the package root: the handler types an extension implements are importable there.
import type { ExtensionAPI, ExtensionFactory, ProtocolHandler, ResolveContext } from "@oh-my-pi/pi-coding-agent";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getInternalUrlSuggestions } from "@oh-my-pi/pi-coding-agent/internal-urls/completion";
import { RpcHostUriBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/host-uris";
import { type CreateAgentSessionResult, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/** Read-only scheme whose resources name the handler that served them. */
function readOnly(scheme: string, label: string): ProtocolHandler {
	return {
		scheme,
		spec: { backing: "remote", selectors: "none", immutable: true },
		resolve: async url => ({ url: url.href, content: `${label}:${url.href}`, contentType: "text/plain" }),
	};
}

/** A factory registering `handler` from the extension's factory. */
function registering(handler: ProtocolHandler): ExtensionFactory {
	return pi => {
		pi.registerUrlScheme(handler);
	};
}

/** Text of a read through `session`'s own read tool; a failure's message when it throws. */
async function readThrough(session: AgentSession, url: string): Promise<string> {
	const read = session.getToolByName("read");
	if (!read) throw new Error("Expected a read tool");
	try {
		const result = await read.execute(`read-${url}`, { path: url });
		return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

let tempDir: TempDir;
let authStorage: AuthStorage;
const sessions: AgentSession[] = [];

beforeEach(() => {
	tempDir = TempDir.createSync("@pi-extension-url-schemes-");
	authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("anthropic", "test-key");
});

afterEach(async () => {
	for (const session of sessions.splice(0).reverse()) await session.dispose();
	authStorage.close();
	tempDir.removeSync();
});

/** A real session in the temp dir loading only `extensions`. */
async function open(...extensions: ExtensionFactory[]): Promise<CreateAgentSessionResult> {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");
	const result = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false, "todo.enabled": false }),
		model,
		toolNames: ["read", "write"],
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		extensions,
	});
	sessions.push(result.session);
	return result;
}

describe("pi.registerUrlScheme", () => {
	it("serves read, write and composer completion through the registering session's router", async () => {
		const reads: Array<ResolveContext | undefined> = [];
		const writes: string[] = [];
		const handler: ProtocolHandler = {
			scheme: "murmur",
			spec: {
				backing: "remote",
				selectors: "none",
				immutable: false,
				write: { via: "handler", payload: "verbatim", scope: "coordination", tier: () => "write" },
			},
			resolve: async (url, context) => {
				reads.push(context);
				return { url: url.href, content: `inbox of ${url.host}`, contentType: "text/plain" };
			},
			write: async (url, content) => {
				writes.push(`${url.href} ${content}`);
			},
			complete: async () => [{ value: "peer-a" }, { value: "other" }],
		};
		const { session } = await open(registering(handler));

		expect(await readThrough(session, "murmur://peer-a")).toContain("inbox of peer-a");
		expect(reads.at(-1)?.cwd).toBe(tempDir.path());

		const write = new WriteTool({
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			urlRouter: session.urlRouter,
			settings: Settings.isolated(),
		} as ToolSession);
		expect(write.approval({ path: "murmur://peer-a", content: "hi" })).toBe("write");
		await write.execute("write-1", { path: "murmur://peer-a", content: "hi" });
		expect(writes).toEqual(["murmur://peer-a hi"]);

		const suggestions = await getInternalUrlSuggestions("ask murmur://pe", session.urlRouter, tempDir.path());
		expect(suggestions?.items.map(item => item.value)).toEqual(["murmur://peer-a"]);
	});

	it("reaches each session's own handler, and no handler in a session without the extension", async () => {
		const { session: first } = await open(registering(readOnly("murmur", "first")));
		const { session: second } = await open(registering(readOnly("murmur", "second")));
		const { session: bare } = await open();

		expect(await readThrough(first, "murmur://x")).toContain("first:murmur://x");
		expect(await readThrough(second, "murmur://x")).toContain("second:murmur://x");
		expect(bare.urlRouter.getHandler("murmur")).toBeUndefined();
		expect(await readThrough(bare, "murmur://x")).not.toMatch(/(first|second):murmur:\/\/x/);
	});

	it("lists a scheme's prompt doc in its own session's system prompt only", async () => {
		const documented: ProtocolHandler = { ...readOnly("murmur", "docs"), promptDoc: () => "murmur:// peer inboxes" };
		const { session: owner } = await open(registering(documented));
		const { session: other } = await open();

		expect(owner.systemPrompt.join("\n")).toContain("murmur:// peer inboxes");
		expect(other.systemPrompt.join("\n")).not.toContain("murmur:// peer inboxes");
	});

	it("stops serving while its extension is suspended, serves again on resume, and leaves on dispose", async () => {
		let api: ExtensionAPI | undefined;
		const { session } = await open(pi => {
			api = pi;
		});
		const dispose = api?.registerUrlScheme(readOnly("murmur", "live"));
		if (!dispose) throw new Error("factory did not run");
		const runner = session.extensionRunner;
		if (!runner) throw new Error("Expected an extension runner");
		expect(await readThrough(session, "murmur://x")).toContain("live:murmur://x");

		runner.setSuspendedExtensions(() => true);
		expect(session.urlRouter.getHandler("murmur")).toBeUndefined();
		runner.setSuspendedExtensions(() => false);
		expect(await readThrough(session, "murmur://x")).toContain("live:murmur://x");

		dispose();
		expect(session.urlRouter.getHandler("murmur")).toBeUndefined();
	});

	it("reports two active extensions registering one scheme as an error, and the earlier one serves it", async () => {
		const { session, extensionsResult } = await open(
			registering(readOnly("murmur", "earlier")),
			registering(readOnly("Murmur", "later")),
		);

		expect(extensionsResult.errors).toEqual([
			{ path: expect.any(String), error: expect.stringContaining("murmur:// is already registered by") },
		]);
		expect(await readThrough(session, "murmur://x")).toContain("earlier:murmur://x");
	});

	it("refuses built-in, standard, malformed and repeated schemes, and a spec the handler contradicts", async () => {
		const refusals: string[] = [];
		const attempt = (pi: ExtensionAPI, handler: ProtocolHandler) => {
			try {
				pi.registerUrlScheme(handler);
			} catch (error) {
				refusals.push(error instanceof Error ? error.message : String(error));
			}
		};
		const { session } = await open(pi => {
			attempt(pi, readOnly("Local", "x"));
			attempt(pi, readOnly("https", "x"));
			attempt(pi, readOnly("c", "x"));
			attempt(pi, readOnly("murmur", "first"));
			attempt(pi, readOnly("MURMUR", "again"));
			attempt(pi, { ...readOnly("contra", "x"), write: async () => {} });
		});

		expect(refusals).toEqual([
			expect.stringContaining("local:// is an OMP built-in scheme"),
			expect.stringContaining("https:// is a standard scheme"),
			expect.stringContaining('"c" is not a URL scheme'),
			expect.stringContaining("murmur:// is already registered"),
			expect.stringContaining("handler has write()"),
		]);
		expect(await readThrough(session, "murmur://x")).toContain("first:murmur://x");
		expect(session.urlRouter.getHandler("contra")).toBeUndefined();
	});

	it("keeps an extension's scheme out of the session's RPC host URI schemes", async () => {
		const { session } = await open(registering(readOnly("murmur", "extension")));
		const bridge = new RpcHostUriBridge(() => {}, session.urlSchemes.hostUris);

		expect(() => bridge.setSchemes([{ scheme: "murmur" }])).toThrow(
			"Host URI scheme is already registered in this session: murmur://",
		);
		expect(await readThrough(session, "murmur://x")).toContain("extension:murmur://x");
	});
});
