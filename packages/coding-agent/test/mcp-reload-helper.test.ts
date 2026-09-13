import { describe, expect, it, vi } from "bun:test";
import type { EffectiveExtensionRoots } from "@oh-my-pi/pi-coding-agent/capability/types";
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { getSessionExaApiKey, reloadMcpServers } from "@oh-my-pi/pi-coding-agent/mcp/reload";

// The shared MCP reload sequence is the single path every in-session refresh
// surface (`/mcp reload`, `/reload-plugins`, the `refresh` tool) funnels
// through. Two contracts it must uphold, both of which a divergent per-caller
// copy has historically dropped:
//   1. Extension roots are threaded into `discoverAndConnect` so
//      extension-declared servers survive the reconnect instead of vanishing
//      until restart.
//   2. The MCP prompt commands are cleared before rediscovery so a removed
//      server cannot leave a stale `/server:prompt` command behind.
function fakeManager(
	tools: Array<{ name: string }> = [],
	overrides?: { exaApiKeys?: string[]; discoveryError?: Error },
) {
	return {
		disconnectAll: vi.fn(async () => {}),
		discoverAndConnect: vi.fn(async (_options?: unknown) => {
			if (overrides?.discoveryError) throw overrides.discoveryError;
			return {
				tools: [],
				errors: new Map<string, string>(),
				connectedServers: [],
				exaApiKeys: overrides?.exaApiKeys ?? [],
			};
		}),
		getTools: vi.fn(() => tools),
	};
}

const roots: EffectiveExtensionRoots = {
	explicit: ["/ext/pkg"],
	mode: "merge",
	configured: [],
	provenance: "session",
} as unknown as EffectiveExtensionRoots;

describe("reloadMcpServers", () => {
	it("threads the session's extension roots into discoverAndConnect", async () => {
		const manager = fakeManager();
		const setMCPPromptCommands = vi.fn();
		const refreshMCPTools = vi.fn(async () => {});

		await reloadMcpServers({
			manager: manager as unknown as MCPManager,
			setMCPPromptCommands,
			refreshMCPTools,
			extensionRoots: roots,
			enableProjectConfig: true,
			filterBrowser: false,
		});

		expect(manager.discoverAndConnect).toHaveBeenCalledTimes(1);
		expect(manager.discoverAndConnect.mock.calls[0]?.[0]).toMatchObject({
			enableProjectConfig: true,
			filterExa: true,
			filterBrowser: false,
			extensionRoots: roots,
		});
	});

	it("clears MCP prompt commands before rediscovery and rebinds tools after", async () => {
		const tools = [{ name: "mcp__srv_do" }];
		const manager = fakeManager(tools);
		const order: string[] = [];
		const setMCPPromptCommands = vi.fn(() => order.push("clear"));
		const refreshMCPTools = vi.fn(async () => {
			order.push("rebind");
		});
		manager.discoverAndConnect.mockImplementation(async () => {
			order.push("discover");
			return { tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] };
		});

		await reloadMcpServers({
			manager: manager as unknown as MCPManager,
			setMCPPromptCommands,
			refreshMCPTools,
			extensionRoots: undefined,
			enableProjectConfig: true,
			filterBrowser: false,
		});

		expect(setMCPPromptCommands).toHaveBeenCalledWith([]);
		expect(refreshMCPTools).toHaveBeenCalledWith(tools);
		// Clear must precede rediscovery; rebind follows it.
		expect(order).toEqual(["clear", "discover", "rebind"]);
	});

	// Startup adopts the credentials discovery extracts (`applyMCPEnvironment`).
	// A refresh that skips it leaves the operator strictly worse off than before
	// the reload: discovery filters the redundant Exa MCP server out (filterExa)
	// AND the native integration stays unauthenticated, so the capability
	// disappears entirely until the process restarts.
	it("applies Exa credentials that rediscovery extracted", async () => {
		// `Bun.env` is a string map at runtime, but after `delete` TypeScript's
		// control-flow analysis pins the property type to `undefined`, so read it
		// through a helper rather than casting the value at each use.
		const env: Record<string, string | undefined> = Bun.env;
		const readExaKey = (): string | undefined => env.EXA_API_KEY;
		const previous = readExaKey();
		delete env.EXA_API_KEY;
		try {
			const manager = fakeManager([], { exaApiKeys: ["exa-key-from-config"] });

			await reloadMcpServers({
				manager: manager as unknown as MCPManager,
				setMCPPromptCommands: vi.fn(),
				refreshMCPTools: vi.fn(async () => {}),
				extensionRoots: roots,
				enableProjectConfig: true,
				filterBrowser: false,
			});

			expect(readExaKey()).toBe("exa-key-from-config");
		} finally {
			if (previous === undefined) delete env.EXA_API_KEY;
			else env.EXA_API_KEY = previous;
		}
	});

	// `disconnectAll()` runs before rediscovery, so by the time discovery throws
	// (a hand-edited malformed mcp.json) every transport is already down.
	// Returning without reconciling would leave the session advertising the old
	// tool set against dead connections, so every later call hits a phantom
	// tool. A failed refresh must degrade to "no MCP tools", not "broken ones".
	it("rebinds the emptied tool set when rediscovery throws", async () => {
		const manager = fakeManager([], { discoveryError: new Error("malformed mcp.json") });
		const refreshMCPTools = vi.fn(async () => {});

		await expect(
			reloadMcpServers({
				manager: manager as unknown as MCPManager,
				setMCPPromptCommands: vi.fn(),
				refreshMCPTools,
				extensionRoots: roots,
				enableProjectConfig: true,
				filterBrowser: false,
			}),
		).rejects.toThrow("malformed mcp.json");

		expect(refreshMCPTools).toHaveBeenCalledTimes(1);
		expect(refreshMCPTools).toHaveBeenCalledWith([]);
	});
});

// Exa credential OWNERSHIP across successive reloads. `applyMCPEnvironment` runs
// on every reload, so "skip when EXA_API_KEY is already set" cannot distinguish
// the operator's launch environment from a value this helper itself installed on
// an earlier refresh — and a key that config rotated or removed could then never
// displace it, leaving the native Exa integration on an obsolete credential.
// Each test establishes ownership explicitly with a first reload, so they hold
// regardless of ordering against the module-scoped ownership record.
describe("reloadMcpServers: Exa credential ownership", () => {
	// `Bun.env` is a string map at runtime, but after `delete` TypeScript's
	// control-flow analysis pins the property type to `undefined`, so read it
	// through a widened alias rather than casting the value at each use.
	const env: Record<string, string | undefined> = Bun.env;
	const readExaKey = (): string | undefined => env.EXA_API_KEY;

	/**
	 * A single session's reload entry point. The `MCPManager` instance IS the
	 * ownership identity `applyMCPEnvironment` keys on (one per top-level
	 * SDK/ACP session), so a session that reloads repeatedly must reuse ONE
	 * manager — building a fresh one per call would impersonate a different
	 * session and be refused, which is the whole point of the ownership check.
	 */
	function makeSession(): { manager: object; reloadWith: (exaApiKeys?: string[]) => Promise<void> } {
		const manager = {
			disconnectAll: vi.fn(async () => {}),
			getTools: vi.fn(() => []),
			discoverAndConnect: vi.fn(async (_options?: unknown) => ({})),
		};
		return {
			manager,
			/**
			 * One reload whose discovery reports `exaApiKeys` exactly as given.
			 * Passing `undefined` OMITS the field entirely (the shape the TUI reload
			 * path's managers actually return) rather than sending an empty array,
			 * which is the distinct "config supplies no key" signal.
			 */
			reloadWith: async (exaApiKeys?: string[]) => {
				manager.discoverAndConnect = vi.fn(async (_options?: unknown) => ({
					tools: [],
					errors: new Map<string, string>(),
					connectedServers: [],
					...(exaApiKeys === undefined ? {} : { exaApiKeys }),
				}));
				await reloadMcpServers({
					manager: manager as unknown as MCPManager,
					setMCPPromptCommands: vi.fn(),
					refreshMCPTools: vi.fn(async () => {}),
					extensionRoots: roots,
					enableProjectConfig: true,
					filterBrowser: false,
				});
			},
		};
	}

	/** Runs `body` with EXA_API_KEY set as given, restoring the real value after. */
	async function withExaEnv(initial: string | undefined, body: () => Promise<void>): Promise<void> {
		const previous = readExaKey();
		if (initial === undefined) delete env.EXA_API_KEY;
		else env.EXA_API_KEY = initial;
		try {
			await body();
		} finally {
			if (previous === undefined) delete env.EXA_API_KEY;
			else env.EXA_API_KEY = previous;
		}
	}

	it("replaces a helper-injected key when config rotates it", async () => {
		await withExaEnv(undefined, async () => {
			const { reloadWith } = makeSession();
			// First reload installs the key — now helper-owned, not an operator value.
			await reloadWith(["exa-key-original"]);
			expect(readExaKey()).toBe("exa-key-original");

			// The key is rotated in config and a later refresh rediscovers it.
			await reloadWith(["exa-key-rotated"]);

			// Pre-fix: the `!$env.EXA_API_KEY` guard saw its OWN earlier injection,
			// treated it as an operator override, and skipped — so the native
			// integration kept authenticating with the obsolete credential.
			expect(readExaKey()).toBe("exa-key-rotated");
		});
	});

	it("clears a helper-injected key when config no longer supplies one", async () => {
		await withExaEnv(undefined, async () => {
			const { reloadWith } = makeSession();
			await reloadWith(["exa-key-original"]);
			expect(readExaKey()).toBe("exa-key-original");

			// The Exa server (and its key) is removed from config: discovery reports
			// an empty key list.
			await reloadWith([]);

			// Pre-fix: a removed key was retained indefinitely.
			expect(readExaKey()).toBeUndefined();
		});
	});

	it("never overwrites an operator-supplied launch value", async () => {
		await withExaEnv("exa-key-from-operator", async () => {
			const { reloadWith } = makeSession();
			// Config supplies a DIFFERENT key. The operator's environment is
			// authoritative and must win, both on the first reload...
			await reloadWith(["exa-key-from-config"]);
			expect(readExaKey()).toBe("exa-key-from-operator");

			// ...and on every later one — a repeated reload must not erode it.
			await reloadWith(["exa-key-from-config"]);
			expect(readExaKey()).toBe("exa-key-from-operator");
		});
	});

	it("never clears an operator-supplied value when config supplies no key", async () => {
		await withExaEnv("exa-key-from-operator", async () => {
			const { reloadWith } = makeSession();
			// The clearing path must be ownership-gated: with nothing of the
			// helper's installed, an empty config key list retracts nothing.
			await reloadWith([]);
			expect(readExaKey()).toBe("exa-key-from-operator");
		});
	});

	// Regression guard for the crash this helper's required-field version caused:
	// MCPManager implementations on the TUI reload path resolve discovery results
	// with NO `exaApiKeys` field at all (see reload-plugins-mcp.test.ts). That is
	// "this manager reported no credentials", not "config removed the key", so it
	// must neither throw nor retract helper-owned state.
	it("leaves helper-owned state intact when discovery omits exaApiKeys entirely", async () => {
		await withExaEnv(undefined, async () => {
			const { reloadWith } = makeSession();
			await reloadWith(["exa-key-original"]);
			expect(readExaKey()).toBe("exa-key-original");

			await reloadWith(undefined);

			expect(readExaKey()).toBe("exa-key-original");
		});
	});

	// The injection is process-GLOBAL but a key belongs to the session that
	// installed it. Several top-level SDK/ACP sessions share one process, so a
	// peer session's reload must not touch a key it does not own.
	it("does not let a peer session replace a key another session injected", async () => {
		await withExaEnv(undefined, async () => {
			const owner = makeSession();
			await owner.reloadWith(["exa-key-owner"]);
			expect(readExaKey()).toBe("exa-key-owner");

			// A DIFFERENT session reloads with its own configured key.
			await makeSession().reloadWith(["exa-key-peer"]);

			// Pre-fix, ownership was tracked as a bare value, so a value match was
			// enough to reclaim: the peer overwrote the owner's credential and the
			// owning session's Exa integration started authenticating as the peer.
			expect(readExaKey()).toBe("exa-key-owner");

			// The owner can still rotate its own key.
			await owner.reloadWith(["exa-key-owner-rotated"]);
			expect(readExaKey()).toBe("exa-key-owner-rotated");
		});
	});

	it("does not let a peer session clear a key another session injected", async () => {
		await withExaEnv(undefined, async () => {
			const owner = makeSession();
			await owner.reloadWith(["exa-key-owner"]);

			// The peer has no Exa key configured at all. Retraction is the more
			// damaging direction: it silently disables the owner's integration.
			await makeSession().reloadWith([]);

			expect(readExaKey()).toBe("exa-key-owner");
		});
	});

	// `EXA_API_KEY` is process-global while Exa credentials are per-session
	// config. The ownership guard correctly stops session B from REPLACING
	// session A's injected key — but that left B with no credential path at all,
	// and the native client reads the environment at execution time, so B
	// authenticated as A's account. Each session must resolve its OWN key.
	it("gives the second session its own key instead of the first session's", async () => {
		await withExaEnv(undefined, async () => {
			const a = makeSession();
			const b = makeSession();

			await a.reloadWith(["key-a"]);
			await b.reloadWith(["key-b"]);

			// A owns the environment, so it stays A's — B must not clobber it.
			expect(readExaKey()).toBe("key-a");
			// But each session resolves its own credential.
			expect(getSessionExaApiKey(a.manager)).toBe("key-a");
			expect(getSessionExaApiKey(b.manager)).toBe("key-b");
		});
	});

	it("drops a session's key when its config stops carrying one", async () => {
		await withExaEnv(undefined, async () => {
			const a = makeSession();
			await a.reloadWith(["key-a"]);
			expect(getSessionExaApiKey(a.manager)).toBe("key-a");

			// An explicit empty array is "config supplies no key", distinct from an
			// omitted field ("this manager reported no credentials").
			await a.reloadWith([]);

			expect(getSessionExaApiKey(a.manager)).toBeUndefined();
		});
	});

	it("leaves a session's key alone when a reload omits the field entirely", async () => {
		await withExaEnv(undefined, async () => {
			const a = makeSession();
			await a.reloadWith(["key-a"]);

			await a.reloadWith(undefined);

			expect(getSessionExaApiKey(a.manager)).toBe("key-a");
		});
	});
});
