/**
 * Reconstruction contract (host-owned): after a restart the embedder reopens the
 * durable session and rebuilds the replacement through the SAME factory, OMITTING
 * the discovery-backed preload fields (contextFiles / skills / promptTemplates /
 * slashCommands / preloadedExtensions) so `createAgentSession` re-runs disk
 * discovery and picks up host-staged changes — the whole point of restart.
 *
 * The in-process recycle shares OMP's process-global discovery/capability caches:
 * the first session's disk discovery warms them with the ORIGINAL bytes, so a
 * naive reopen re-reads the cache and serves stale content. `requestRestart()`
 * must invalidate those caches itself (inside `#doRequestRestart`, before the
 * host `onRestartRequested` callback) so a host following the callback contract
 * verbatim — reopen + rebuild, no manual cache reset — still sees disk. This
 * proves that boundary end to end: the host callback changes AGENTS.md on disk
 * and rebuilds, and the replacement's system prompt carries the CHANGED content,
 * with NO explicit resetDiscoveryCaches() anywhere in the reconstruction.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { mockFetch } from "./helpers/fetch-mock";

function buildLocalModel(api: string): Model<Api> {
	return buildModel({
		id: "restart-reattach-model",
		name: "Restart Reattach Model",
		api,
		provider: "managed-primary",
		baseUrl: "http://127.0.0.1:8080/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 4096,
		maxTokens: 1024,
	} as ModelSpec<Api>) as Model<Api>;
}

describe("restart reconstruction reattach", () => {
	const authStorages: AuthStorage[] = [];

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
	});

	it("recycled session reloads on-disk-changed context without a manual cache reset", async () => {
		using tempDir = TempDir.createSync("@pi-restart-reattach-");
		const marker = Bun.nanoseconds().toString(36);
		const original = `ORIGINAL_RULES_${marker}`;
		const updated = `UPDATED_RULES_${marker}`;
		const agentsMd = path.join(tempDir.path(), "AGENTS.md");
		await fs.writeFile(agentsMd, original);

		const api = `restart-reattach-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		let replacement: AgentSession | undefined;
		let reopenedManager: SessionManager | undefined;

		// The host reconstruction, wired exactly as an embedder would: reopen the
		// durable session and rebuild through the SAME factory with the
		// discovery-backed preload OMITTED — and NO manual cache reset. The recycle
		// only picks up the on-disk edit if requestRestart() cleared the shared
		// discovery caches itself before this callback fired.
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			// The host stages its AGENTS.md edit for the recycle to pick up.
			await fs.writeFile(agentsMd, updated);
			reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
			const rebuilt = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: reopenedManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: buildLocalModel(api),
				disableExtensionDiscovery: true,
				// Discovery-backed preload intentionally omitted so restart reloads disk.
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			replacement = rebuilt.session;
		};

		// First session: OMIT contextFiles so its own disk discovery warms the
		// process-global capability cache with the ORIGINAL bytes — the stale
		// content the recycle must not serve.
		const firstManager = SessionManager.create(tempDir.path());
		const { session: first } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: firstManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});
		await first.refreshBaseSystemPrompt();
		expect(first.systemPrompt.join("\n")).toContain(original);
		// Persist the transcript so the reopen inside the callback has a durable
		// file (requestRestart() runs flush + ensureOnDisk itself before dispose;
		// this mirrors it, since persistence is otherwise lazy until a turn writes).
		await firstManager.ensureOnDisk();
		await firstManager.flush();

		// Drive the real restart: waitForIdle -> durability barrier -> dispose ->
		// cache invalidation -> onRestartRequested. `ok` proves the callback ran.
		const result = await first.requestRestart();
		expect(result.ok).toBe(true);

		try {
			if (!replacement) throw new Error("Expected the restart callback to build a replacement session");
			await replacement.refreshBaseSystemPrompt();
			const rebuilt = replacement.systemPrompt.join("\n");
			expect(rebuilt).toContain(updated);
			expect(rebuilt).not.toContain(original);
		} finally {
			await replacement?.dispose();
			await reopenedManager?.close();
		}
	});

	it("preserves an empty moved session file across restart disposal so reattach can reopen it", async () => {
		using tempDir = TempDir.createSync("@pi-restart-empty-move-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		// The captured file the restart persists for reattachment: it must still
		// exist when onRestartRequested fires, even though it is an empty moved
		// session that generic dispose() would delete via cleanupEmptyMoveSession.
		let fileExistedInCallback: boolean | undefined;
		let openSucceeded: boolean | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			fileExistedInCallback = await fs
				.access(sessionFile)
				.then(() => true)
				.catch(() => false);
			try {
				reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
				openSucceeded = true;
			} catch {
				openSucceeded = false;
			}
		};

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			onRestartRequested,
		});

		// Mark the current (message-free) session file as the destination of an
		// empty /move, exactly as the move path does. No user/assistant message is
		// ever recorded, so cleanupEmptyMoveSession considers it deletable.
		const sessionFile = session.sessionFile;
		if (sessionFile === undefined) throw new Error("Expected a session file");
		session.markMovedFromEmptySessionFile(sessionFile);

		// Drive the real restart: waitForIdle -> flush + ensureOnDisk -> dispose
		// (which must NOT run empty-move cleanup for the handoff) -> callback.
		const result = await session.requestRestart();
		expect(result.ok).toBe(true);

		try {
			// The captured file survived disposal, so the documented reattachment
			// (SessionManager.open) succeeds.
			expect(fileExistedInCallback).toBe(true);
			expect(openSucceeded).toBe(true);
		} finally {
			await reopenedManager?.close();
		}
	});

	// The case above proves AgentSession.dispose() honours preserveSessionFile,
	// but it constructs AgentSession directly and so never crosses the public
	// factory. `createAgentSession` REPLACES session.dispose with a wrapper that
	// adds its own teardown (agent lifecycle, vibe scope, unregister); if that
	// wrapper does not forward its options to the original, restart's
	// dispose({ preserveSessionFile: true }) degrades to a bare dispose(), and
	// #doDispose runs cleanupEmptyMoveSession and deletes the very file
	// ensureOnDisk() just persisted for the handoff. Every real embedder goes
	// through this factory, so the option must survive the wrapper.
	it("forwards restart disposal options through the SDK dispose wrapper", async () => {
		using tempDir = TempDir.createSync("@pi-restart-wrapped-move-");
		const marker = Bun.nanoseconds().toString(36);
		const api = `restart-wrapper-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		let fileExistedInCallback: boolean | undefined;
		let openSucceeded: boolean | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			fileExistedInCallback = await fs
				.access(sessionFile)
				.then(() => true)
				.catch(() => false);
			try {
				reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
				openSucceeded = true;
			} catch {
				openSucceeded = false;
			}
		};

		const sessionManager = SessionManager.create(tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});

		// Same empty-/move destination as the direct-construction case, so a
		// dropped preserveSessionFile deletes the captured file.
		const sessionFile = session.sessionFile;
		if (sessionFile === undefined) throw new Error("Expected a session file");
		session.markMovedFromEmptySessionFile(sessionFile);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		const result = await session.requestRestart();
		expect(result.ok).toBe(true);

		try {
			expect(fileExistedInCallback).toBe(true);
			expect(openSucceeded).toBe(true);
		} finally {
			await reopenedManager?.close();
		}
	});

	// The wrapper forwards its options (above), but only for the call whose
	// options reach `originalDispose`. `AgentSession.dispose()` coalesces from the
	// moment it is ENTERED, and this wrapper awaits Vibe/subagent teardown first —
	// so a normal host shutdown calling `dispose()` while the restart is parked in
	// that teardown runs as a SECOND, independent disposal. If the normal call
	// reaches `originalDispose({})` first, the idempotence cache captures the
	// non-recycle options: `preserveSessionFile` is silently dropped, empty-move
	// cleanup deletes the file `ensureOnDisk()` just persisted, and the restart's
	// own later call merely joins it — then goes on to invoke
	// `onRestartRequested` with a path nothing can reopen. Ownership has to be
	// established in the outer wrapper, before its first await.
	it("coalesces a concurrent host dispose onto the restart's disposal inside the SDK wrapper", async () => {
		using tempDir = TempDir.createSync("@pi-restart-dispose-race-");
		const marker = Bun.nanoseconds().toString(36);
		const api = `restart-dispose-race-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		let fileExistedInCallback: boolean | undefined;
		let openSucceeded: boolean | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			fileExistedInCallback = await fs
				.access(sessionFile)
				.then(() => true)
				.catch(() => false);
			try {
				reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
				openSucceeded = true;
			} catch {
				openSucceeded = false;
			}
		};

		const sessionManager = SessionManager.create(tempDir.path());
		const { session } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});

		// Same empty-/move destination as the forwarding case above, so a disposal
		// that loses `preserveSessionFile` deletes the captured file.
		const sessionFile = session.sessionFile;
		if (sessionFile === undefined) throw new Error("Expected a session file");
		session.markMovedFromEmptySessionFile(sessionFile);
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		// Park the FIRST disposal inside the wrapper's Vibe teardown — its first
		// await, before `originalDispose` — and let any later one run straight
		// through. That is what makes the race deterministic rather than a coin
		// flip: pre-fix the host's `dispose({})` reaches the idempotence cache
		// while the restart is still held here, so its non-recycle options are the
		// ones that stick. `suspendReached` is the wrapper's own signal that it is
		// parked, so nothing here waits on wall-clock time.
		const registry = VibeSessionRegistry.global();
		const suspendReached = Promise.withResolvers<void>();
		const suspendGate = Promise.withResolvers<void>();
		let suspendCalls = 0;
		const realSuspendScope = registry.suspendScope.bind(registry);
		const suspendSpy = vi.spyOn(registry, "suspendScope").mockImplementation(async (scope, manager) => {
			if (++suspendCalls === 1) {
				suspendReached.resolve();
				await suspendGate.promise;
			}
			return realSuspendScope(scope, manager);
		});

		try {
			const restart = session.requestRestart();
			// The wrapper is now parked in the gated teardown, past beginDispose()
			// and before originalDispose().
			await suspendReached.promise;
			expect(suspendSpy).toHaveBeenCalledTimes(1);

			// The host shuts down concurrently. Pre-fix this is a second, complete
			// teardown; with ownership claimed it awaits the restart's instead. It
			// is dispatched synchronously here, so if it were going to enter the
			// wrapper it would have already: `dispose` claims ownership with no
			// await between the read and the assignment, so one microtask drain is
			// enough to observe either outcome.
			const hostDispose = session.dispose();
			await Promise.resolve();
			// The claim is what proves coalescing: an independent second disposal
			// would have entered the wrapper and called this again.
			expect(suspendSpy).toHaveBeenCalledTimes(1);

			suspendGate.resolve();
			const result = await restart;
			await hostDispose;
			// And the whole run produced exactly one wrapper teardown.
			expect(suspendSpy).toHaveBeenCalledTimes(1);

			// The disposal that ran is the restart's, so its `preserveSessionFile`
			// held: the callback found a file it could reopen. RED pre-fix — the
			// host's non-recycle disposal deleted it first and the restart handed
			// the callback an unreopenable path.
			expect(result.ok).toBe(true);
			expect(fileExistedInCallback).toBe(true);
			expect(openSucceeded).toBe(true);
		} finally {
			suspendGate.resolve();
			await reopenedManager?.close();
			vi.restoreAllMocks();
		}
	});

	// The registry is the one restart-sensitive surface a host is REQUIRED to
	// carry across the boundary unchanged: it holds the session-affine auth
	// storage, so the reconstruction contract preserves it rather than omitting it
	// like the discovery-backed preload fields. But `createAgentSession` calls
	// `refreshInBackground()` only when it constructed the registry itself
	// (sdk.ts), so a preserved caller-owned instance hands the replacement the
	// models.yml parsed at first launch — and a restart advertised for an on-disk
	// model change silently returns the stale catalog. requestRestart() must
	// reload it on the dispose->callback handoff, alongside the capability caches.
	it("reloads a caller-owned model registry so the replacement sees on-disk model changes", async () => {
		using tempDir = TempDir.createSync("@pi-restart-registry-");
		const modelsPath = tempDir.join("models.yml");
		// A modelOverrides rename is the minimal on-disk model change that is
		// observable offline: no provider HTTP, no credentials, just a reparse.
		const writeOverrideName = async (name: string) => {
			await fs.writeFile(
				modelsPath,
				JSON.stringify({
					providers: { openrouter: { modelOverrides: { "anthropic/claude-sonnet-4": { name } } } },
				}),
			);
		};
		await writeOverrideName("Name Before Restart");

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		// The caller-owned registry, preserved across the restart per contract.
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);
		const overrideName = () =>
			modelRegistry.getAll().find(m => m.provider === "openrouter" && m.id === "anthropic/claude-sonnet-4")?.name;
		expect(overrideName()).toBe("Name Before Restart");

		// The host stages its models.yml edit for the recycle to pick up, exactly
		// as it stages an AGENTS.md edit in the context-reload case above, and
		// performs NO manual registry refresh — the restart must do it.
		let nameSeenByReplacement: string | undefined;
		const onRestartRequested = async () => {
			nameSeenByReplacement = overrideName();
		};
		await writeOverrideName("Name After Restart");

		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			onRestartRequested,
		});

		const result = await session.requestRestart();
		expect(result.ok).toBe(true);

		// The replacement's registry reflects disk, not the first-launch parse.
		expect(nameSeenByReplacement).toBe("Name After Restart");
	});

	// The offline reload above is only half of what the reconstruction contract
	// promises a preserved registry. `reapplyModelPolicies()` is deliberately
	// offline — it must pick up a models.yml edit without blocking the handoff on
	// provider HTTP — so it reloads local configuration and whatever rows the
	// SQLite discovery cache already holds, and never talks to a provider.
	//
	// For a registry the CALLER owns that is the whole story, because
	// `createAgentSession` fires `refreshInBackground()` only when it constructed
	// the registry itself: an embedder that supplies `options.modelRegistry` gets
	// no online pass on the way in, and the recycle did not perform one either.
	// So a discovery-backed provider comes back holding exactly the catalog it
	// had at first launch — empty on a cold cache, or stale — even though restart
	// exists to pick up host-staged configuration, up to and including a newly
	// configured discovery endpoint.
	//
	// The recycle therefore starts discovery for the preserved registry itself,
	// in the BACKGROUND and after the host's callback has returned: the same
	// ordering a cold CLI start uses (`main.ts` fires it once the session is
	// built), so the replacement is never reading a catalog that a concurrent
	// online pass is rewriting underneath it, and the handoff never pays for
	// provider HTTP.
	//
	// Event-gated on the registry's own settle, never on elapsed time.
	//
	// RED (pre-fix): no discovery was ever started, so awaiting the background
	// refresh resolved at once and the provider's catalog stayed empty.
	it("starts discovery for a preserved caller-owned registry so newly available models arrive after restart", async () => {
		using tempDir = TempDir.createSync("@pi-restart-discovery-");
		const modelsPath = tempDir.join("models.yml");
		// A keyless discovery-backed provider: `auth: none` means discovery needs
		// no credential, so the only thing standing between the registry and this
		// model is whether an ONLINE pass is ever performed.
		await fs.writeFile(
			modelsPath,
			JSON.stringify({
				providers: {
					"restart-discovery": {
						api: "openai-completions",
						baseUrl: "http://127.0.0.1:1/v1",
						auth: "none",
						discovery: { type: "openai-models-list" },
					},
				},
			}),
		);

		// Stands in for the provider endpoint. Only an online discovery pass can
		// reach it, so a request arriving at all is the proof.
		let discoveryRequests = 0;
		const discoveryFetch = mockFetch(async input => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!url.endsWith("/models")) throw new Error(`unexpected request to ${url}`);
			discoveryRequests++;
			return new Response(JSON.stringify({ data: [{ id: "newly-available", context_length: 32000 }] }), {
				headers: { "Content-Type": "application/json" },
			});
		});

		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled model");
		const mock = createMockModel({ handler: () => ({ content: ["ok"] }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.create(tempDir.path());
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");

		// The caller-owned registry, preserved across the restart per contract.
		// Built exactly as an embedder builds one: no discovery performed.
		const modelRegistry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: tempDir.join("models.db"),
			fetch: discoveryFetch,
		});
		const discovered = () =>
			modelRegistry.getAll().filter(candidate => candidate.provider === "restart-discovery").length;
		// Nothing discovered yet, and nothing cached to discover offline from.
		expect(discovered()).toBe(0);
		expect(discoveryRequests).toBe(0);

		// The host reopens and rebuilds; it performs no registry refresh of its
		// own, exactly as in the offline-reload case above.
		let discoveredInsideCallback = 0;
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			onRestartRequested: () => {
				discoveredInsideCallback = discovered();
			},
		});

		const result = await session.requestRestart();
		expect(result.ok).toBe(true);

		// The handoff itself never blocked on provider HTTP: the callback saw only
		// what the offline reload could produce.
		expect(discoveredInsideCallback).toBe(0);

		// The recycle starts the online pass on a later macrotask — strictly after
		// this call settled — so the gate has to be the waiter that latches
		// whenever the refresh happens, not one that reads an in-flight promise
		// and resolves early because the pass has not begun yet.
		await modelRegistry.awaitInitialBackgroundRefresh();
		expect(discoveryRequests).toBeGreaterThan(0);
		expect(modelRegistry.getAll().some(candidate => candidate.id === "newly-available")).toBe(true);
	});

	// One layer past the registry reload above: that case asserts a REGISTRY
	// LOOKUP is fresh, which the reload alone satisfies. But the reconstruction
	// contract also tells the host to preserve `model`, and the replacement runs
	// on that object — not on a lookup. `createAgentSessionScoped` took
	// `options.model` verbatim, so a models.yml edit to the SELECTED model's own
	// fields left the replacement session's `model` holding the definition parsed
	// at first launch, even though the registry beside it had just been reloaded.
	// The factory must resolve the supplied model through the registry.
	it("re-resolves the preserved selected model through the refreshed registry", async () => {
		using tempDir = TempDir.createSync("@pi-restart-selected-model-");
		const modelsPath = tempDir.join("models.yml");
		// Edit a field ON THE SELECTED MODEL itself, offline-observable: the
		// context window the replacement's compaction and context bar read.
		const writeContextWindow = async (contextWindow: number) => {
			await fs.writeFile(
				modelsPath,
				JSON.stringify({
					providers: { anthropic: { modelOverrides: { "claude-sonnet-4-5": { contextWindow } } } },
				}),
			);
		};
		await writeContextWindow(111000);

		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, modelsPath);

		// The model the host holds and re-passes: the pre-restart definition,
		// carrying the pre-edit context window.
		const selected = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!selected) throw new Error("Expected the override-applied model");
		expect(selected.contextWindow).toBe(111000);

		let replacement: AgentSession | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			// The host stages its models.yml edit, reloads the registry it owns,
			// then rebuilds through the same factory preserving BOTH the registry
			// and the model, exactly as the reconstruction contract requires.
			//
			// The host reloads, not the session: `requestRestart()` reloads the
			// registry BEFORE invoking this callback, so that reload cannot see an
			// edit the host stages inside it. Restart exists so a host can swap
			// configuration during the recycle, which is necessarily after the
			// callback fires. Reloading here is the only ordering that can pick up
			// the host's own edit.
			await writeContextWindow(222000);
			await modelRegistry.reapplyModelPolicies();
			reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
			const rebuilt = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: reopenedManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: selected,
				// The host asks for the preserved selector to be re-read: the point
				// of this restart is a models.yml edit.
				resolveModelFromRegistry: true,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			replacement = rebuilt.session;
		};

		const firstManager = SessionManager.create(tempDir.path());
		const { session: first } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager: firstManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: selected,
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});
		expect(first.model?.contextWindow).toBe(111000);
		await firstManager.ensureOnDisk();
		await firstManager.flush();

		const result = await first.requestRestart();
		expect(result.ok).toBe(true);

		try {
			if (!replacement) throw new Error("Expected the restart callback to build a replacement session");
			// Same selector, refreshed definition: the replacement runs the model
			// the reloaded registry now describes, not the first-launch object.
			expect(replacement.model?.id).toBe("claude-sonnet-4-5");
			expect(replacement.model?.contextWindow).toBe(222000);
		} finally {
			await replacement?.dispose();
			await reopenedManager?.close();
		}
	});

	// Restart is documented to recycle ONLY the current session. But the parent's
	// teardown runs through the SDK factory's dispose wrapper, which for a `main`
	// session calls the PROCESS-level `AgentLifecycleManager.global().dispose()`
	// — and that `release()`s every adopted subagent, unregistering its AgentRef
	// and dropping the global manager. So an agent that was merely idle became
	// unresumable and unaddressable the moment the replacement session attached,
	// even though restart never claimed to touch it. A recycle must PARK the
	// adopted agents instead: dispose each live session (it must not outlive the
	// parent's shared kernels/MCP/LSP) while keeping the ref + sessionFile
	// registered and revivable.
	//
	// RED (pre-fix): the adopted ref was gone from the registry after the
	// recycle, so `registry.get()` returned undefined and `ensureLive()` threw
	// "Unknown agent".
	it("parks rather than releases adopted subagents across a restart recycle", async () => {
		using tempDir = TempDir.createSync("@pi-restart-adopted-");
		const marker = Bun.nanoseconds().toString(36);
		const api = `restart-adopted-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		// Isolate the process-global registry/lifecycle this test asserts on.
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();

		// An idle adopted subagent, exactly as the task executor hands one over:
		// a registered ref with a sessionFile, plus a reviver. Its session is a
		// stub — the lifecycle only ever calls dispose() on it, and what this
		// asserts is the REF's survival, not the session's.
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const subSessionFile = tempDir.join("sub-agent.jsonl");
		await fs.writeFile(subSessionFile, "");
		let subDisposeCalls = 0;
		const subSession = {
			dispose: async () => {
				subDisposeCalls++;
			},
		} as unknown as AgentSession;
		const subRef = registry.register({
			id: "Sub",
			displayName: "task",
			kind: "sub",
			session: subSession,
			sessionFile: subSessionFile,
			status: "idle",
		});
		// idleTtlMs 0 adopts WITHOUT arming a TTL timer, so the only park in this
		// test is the one the recycle drives.
		lifecycle.adopt("Sub", { idleTtlMs: 0, revive: async () => subSession }, subRef);
		expect(lifecycle.has("Sub")).toBe(true);

		let replacement: AgentSession | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
			const rebuilt = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: reopenedManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: buildLocalModel(api),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			replacement = rebuilt.session;
		};

		const sessionManager = SessionManager.create(tempDir.path());
		const { session: parent } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		const result = await parent.requestRestart();
		expect(result.ok).toBe(true);

		try {
			if (!replacement) throw new Error("Expected the restart callback to build a replacement session");
			// The ref SURVIVED the recycle and is parked, not unregistered: the
			// agent is still addressable (history://, hub) and revivable.
			const afterRecycle = registry.get("Sub");
			expect(afterRecycle).toBe(subRef);
			expect(afterRecycle?.status).toBe("parked");
			// Park detaches the live session and disposes it — it must not outlive
			// the parent's shared resources — but keeps the reattach handle.
			expect(afterRecycle?.session).toBeNull();
			expect(afterRecycle?.sessionFile).toBe(subSessionFile);
			expect(subDisposeCalls).toBe(1);
			// The replacement resolves the SAME global manager, so the parked agent
			// is still adopted and revives on demand rather than throwing "Unknown
			// agent". Revival goes through the replacement's factory: the recycle
			// marked the spawn-time closure stale, since it closes over the parent
			// this restart disposed.
			expect(AgentLifecycleManager.global()).toBe(lifecycle);
			lifecycle.setPersistedSubagentReviverFactory(async () => async () => subSession, 0);
			expect(await lifecycle.ensureLive("Sub")).toBe(subSession);
		} finally {
			await replacement?.dispose();
			await reopenedManager?.close();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	// The other half of the recycle's revival ordering. The case above proves the
	// adopted ref SURVIVES; this proves a waiter cannot revive it too early.
	//
	// The barrier `parkAll()` raises is what holds a hub `send` waiting inside
	// `ensureLive()`. Releasing it when the SDK dispose wrapper returns is too
	// soon: `AgentSession.#doRequestRestart()` invokes `onRestartRequested` only
	// AFTER that dispose returns, so between the two there is a window with no
	// parent at all. A waiter released into it revives through the reviver
	// captured before the recycle — one still closed over the disposed parent's
	// MCP and other shared dependencies — producing a child attached to a parent
	// that no longer exists. The release therefore belongs to the restart
	// HANDOFF: after the callback has finished reattaching.
	//
	// Event-gated on the revival itself: the reviver records when it ran relative
	// to the callback's own marker, so the assertion is an ordering, not a
	// timing.
	//
	// RED (pre-fix): the reviver ran BEFORE the callback's reattachment marker —
	// `["revived", "reattached"]` instead of `["reattached", "revived"]`.
	it("holds the revival barrier until the restart callback has reattached", async () => {
		using tempDir = TempDir.createSync("@pi-restart-barrier-handoff-");
		const marker = Bun.nanoseconds().toString(36);
		const api = `restart-barrier-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();

		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const subSessionFile = tempDir.join("sub-agent.jsonl");
		await fs.writeFile(subSessionFile, "");

		// Records the recycle's real ordering. The reviver stands in for every
		// shared dependency it closes over: whatever it captures belongs to the
		// OLD parent, so when it runs is exactly the question.
		const order: string[] = [];
		const subSession = { dispose: async () => {} } as unknown as AgentSession;
		const revivedSession = { dispose: async () => {} } as unknown as AgentSession;
		const subRef = registry.register({
			id: "Sub",
			displayName: "task",
			kind: "sub",
			session: subSession,
			sessionFile: subSessionFile,
			status: "idle",
		});
		lifecycle.adopt("Sub", { idleTtlMs: 0, revive: async () => subSession }, subRef);
		// The replacement parent's factory is the route back across a recycle (the
		// spawn-time closure above belongs to the parent being disposed), so the
		// ordering probe lives in the reviver it produces.
		lifecycle.setPersistedSubagentReviverFactory(
			async () => async () => {
				order.push("revived");
				return revivedSession;
			},
			0,
		);

		let replacement: AgentSession | undefined;
		let reopenedManager: SessionManager | undefined;
		const onRestartRequested = async ({ sessionFile }: { sessionId: string; sessionFile: string }) => {
			reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
			const rebuilt = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: reopenedManager,
				authStorage,
				modelRegistry,
				settings: Settings.isolated({ "compaction.enabled": false }),
				model: buildLocalModel(api),
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			replacement = rebuilt.session;
			// The replacement now exists: this is the first instant at which a
			// revived child has a live parent to borrow shared resources from.
			order.push("reattached");
		};

		const sessionManager = SessionManager.create(tempDir.path());
		const { session: parent } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		// A hub `send` racing the recycle. It has to enter ensureLive() while the
		// barrier is UP, so it is launched from inside parkAll() itself rather than
		// beside requestRestart(): the restart's own quiescence wait and durability
		// flush run first, and an ensureLive() started before the barrier exists
		// simply keeps the still-attached session and never reaches the revive
		// path this asserts on.
		let send: Promise<AgentSession> | undefined;
		const realParkAll = lifecycle.parkAll.bind(lifecycle);
		lifecycle.parkAll = async deadlineAt => {
			const release = await realParkAll(deadlineAt);
			// The barrier is raised and the children are parked; a send landing
			// here is exactly the waiter the release ordering governs.
			send = lifecycle.ensureLive("Sub");
			return release;
		};

		const result = await parent.requestRestart();
		expect(result.ok).toBe(true);
		if (!send) throw new Error("Expected the racing send to have been launched");
		// Own the outcome so a rejection can never surface as unhandled.
		const racingSend = send;
		const sendOutcome = racingSend.then(
			() => "resolved",
			() => "rejected",
		);

		try {
			if (!replacement) throw new Error("Expected the restart callback to build a replacement session");
			// Gate on the waiter's own settlement — not on elapsed time — so the
			// ordering below is read after the revival has actually happened.
			expect(await sendOutcome).toBe("resolved");
			// It really did revive: a barrier held forever would satisfy an
			// ordering assertion by never reviving at all.
			expect(await racingSend).toBe(revivedSession);
			expect(registry.get("Sub")?.session).toBe(revivedSession);
			// And it revived strictly AFTER reattachment, never into the gap
			// between the old parent's disposal and the replacement's existence.
			expect(order).toEqual(["reattached", "revived"]);
		} finally {
			await replacement?.dispose();
			await reopenedManager?.close();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	// Vibe workers are the second thing a recycle carries across, and the
	// dispose wrapper's `suspendScope()` DELETES their process-local records —
	// that is the correct half of a session switch, where the interactive
	// reconciliation immediately pairs it with `rehydrate()` from the reopened
	// journal. The SDK reconstruction path had only the suspend, so a host that
	// followed the documented contract came back with `vibe_list` empty and its
	// idle workers unaddressable, though their conversations were intact on
	// disk beside a spawn record in the parent transcript.
	//
	// Observable through the tool's own path (`screens()`, which backs
	// `vibe_list`), not an internal record count, plus the AgentRegistry row a
	// send would have to resolve.
	//
	// RED (pre-fix): `screens()` on the replacement is empty and the registry
	// has no row for the worker.
	it("restores suspended Vibe workers so the replacement session can still list them", async () => {
		using tempDir = TempDir.createSync("@pi-restart-vibe-");
		const marker = Bun.nanoseconds().toString(36);
		const api = `restart-vibe-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();

		let replacement: AgentSession | undefined;
		let reopenedManager: SessionManager | undefined;
		const sessionManager = SessionManager.create(tempDir.path());
		const { session: parent } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested: async ({ sessionFile }) => {
				reopenedManager = await SessionManager.open(sessionFile, tempDir.path());
				const rebuilt = await createAgentSession({
					cwd: tempDir.path(),
					agentDir: tempDir.path(),
					sessionManager: reopenedManager,
					authStorage,
					modelRegistry,
					settings: Settings.isolated({ "compaction.enabled": false }),
					model: buildLocalModel(api),
					disableExtensionDiscovery: true,
					enableMCP: false,
					enableLsp: false,
					skipPythonPreflight: true,
				});
				replacement = rebuilt.session;
			},
		});
		await sessionManager.ensureOnDisk();

		// A worker that took a real turn, recorded exactly as vibe_spawn records
		// one: a spawn event plus a settled turn in the PARENT journal, and a
		// persisted child transcript carrying its own session_init contract.
		const parentSessionId = sessionManager.getSessionId();
		const ownerId = parent.getAgentId() ?? "Main";
		const workerId = "vibe-worker-1";
		const parentSessionFile = sessionManager.getSessionFile();
		if (!parentSessionFile) throw new Error("Expected a persisted parent session file");
		const childDir = parentSessionFile.slice(0, -6);
		await fs.mkdir(childDir, { recursive: true });
		const childManager = SessionManager.create(tempDir.path(), childDir);
		childManager.appendSessionInit({
			systemPrompt: "worker",
			task: "worker task",
			tools: ["read"],
			agent: "sonic",
		});
		await childManager.ensureOnDisk();
		await childManager.flush();
		const childSessionFile = childManager.getSessionFile();
		if (!childSessionFile) throw new Error("Expected a persisted child session file");
		await childManager.close();
		// #resolvePersistedChild only accepts `<id>.jsonl` directly beside the
		// parent's artifacts dir, which is exactly what a real spawn writes.
		await fs.rename(childSessionFile, path.join(childDir, `${workerId}.jsonl`));

		const base = { version: 1 as const, id: workerId, ownerId, parentSessionId };
		sessionManager.appendCustomEntry("vibe-session-lifecycle", {
			...base,
			action: "spawn",
			cli: "fast",
			agent: "sonic",
			childSessionFile: `${workerId}.jsonl`,
			createdAt: Date.now(),
		});
		sessionManager.appendCustomEntry("vibe-session-lifecycle", { ...base, action: "turn-started", turn: 1 });
		sessionManager.appendCustomEntry("vibe-session-lifecycle", { ...base, action: "turn-settled", turn: 1 });
		await sessionManager.flush();

		const vibeRegistry = VibeSessionRegistry.global();
		const parentView = {
			getAgentId: () => ownerId,
			getSessionId: () => parentSessionId,
			getSessionFile: () => parentSessionFile,
			sessionManager,
			asyncJobManager: parent.asyncJobManager,
			settings: parent.settings,
		};
		// The pre-recycle state the recycle must not lose: a live, listable roster.
		expect(await vibeRegistry.rehydrate(parentView)).toBe(1);
		expect(vibeRegistry.listIds(parentView as never)).toEqual([workerId]);

		const result = await parent.requestRestart();
		expect(result.ok).toBe(true);

		try {
			if (!replacement) throw new Error("Expected the restart callback to build a replacement session");
			if (!reopenedManager) throw new Error("Expected the callback to reopen the transcript");
			// The replacement's own view of the same owner scope — the identity a
			// `vibe_list` call inside that session resolves.
			const replacementView = {
				getAgentId: () => replacement?.getAgentId() ?? "Main",
				getSessionId: () => reopenedManager?.getSessionId() ?? null,
				getSessionFile: () => reopenedManager?.getSessionFile() ?? null,
				sessionManager: reopenedManager,
				asyncJobManager: replacement.asyncJobManager,
				settings: replacement.settings,
			};
			// The documented path the director actually uses: `vibe_list` renders
			// exactly these screens.
			const screens = vibeRegistry.screens(replacementView as never);
			expect(screens.map(screen => screen.id)).toEqual([workerId]);
			expect(screens[0]!.state).toBe("idle");
			expect(screens[0]!.turns).toBe(1);
			// And a send can resolve it: the registry row is back too, parked with
			// the child transcript as its reattach handle.
			expect(AgentRegistry.global().get(workerId)).toMatchObject({
				kind: "sub",
				parentId: ownerId,
				status: "parked",
				sessionFile: path.join(childDir, `${workerId}.jsonl`),
			});
		} finally {
			await replacement?.dispose();
			await reopenedManager?.close();
			VibeSessionRegistry.resetGlobalForTests();
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});

	// The failure counterpart of the barrier-handoff ordering above. When the
	// host's reattachment THROWS there is no replacement parent at all, and the
	// release that reopens child revival runs from a `finally` — so it runs on
	// this path too.
	//
	// Reopening revival here is not the safer half of the trade. The teardown
	// below the parking already disposed the shared kernels/MCP/LSP every parked
	// child borrows, and with no new parent BOTH routes back to a live session
	// belong to the one that went away: the retained reviver closes over it, and
	// the factory that would have superseded that reviver is its own, because no
	// replacement installed one. A waiter let through comes back holding a
	// disconnected MCP.
	//
	// So the barrier must LIFT — holding it forever strands every later
	// ensureLive() — while REFUSING the waiter it was holding. Both are asserted:
	// either alone is satisfiable by breaking the other.
	//
	// Event-gated on the waiter's own settlement, never on elapsed time.
	//
	// RED (pre-fix): the release took no outcome, so the waiter resolved through
	// the reviver captured before the recycle and got a child bound to the
	// disposed parent's dependencies.
	it("refuses a waiting revival when the restart callback fails to reattach", async () => {
		using tempDir = TempDir.createSync("@pi-restart-handoff-failed-");
		const marker = Bun.nanoseconds().toString(36);
		const api = `restart-handoff-failed-${marker}`;
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("managed-primary", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();

		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		const subSessionFile = tempDir.join("sub-agent.jsonl");
		await fs.writeFile(subSessionFile, "");

		const subSession = { dispose: async () => {} } as unknown as AgentSession;
		// Stands in for every shared dependency the pre-recycle reviver closes
		// over. If it runs at all, the child was rebuilt against the parent whose
		// teardown just disconnected them.
		let staleReviverRuns = 0;
		const subRef = registry.register({
			id: "Sub",
			displayName: "task",
			kind: "sub",
			session: subSession,
			sessionFile: subSessionFile,
			status: "idle",
		});
		lifecycle.adopt(
			"Sub",
			{
				idleTtlMs: 0,
				revive: async () => {
					staleReviverRuns++;
					return { dispose: async () => {} } as unknown as AgentSession;
				},
			},
			subRef,
		);

		const reattachFailure = new Error(`reattachment failed ${marker}`);
		const onRestartRequested = async () => {
			throw reattachFailure;
		};

		const sessionManager = SessionManager.create(tempDir.path());
		const { session: parent } = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			authStorage,
			modelRegistry,
			settings: Settings.isolated({ "compaction.enabled": false }),
			model: buildLocalModel(api),
			disableExtensionDiscovery: true,
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			onRestartRequested,
		});
		await sessionManager.ensureOnDisk();
		await sessionManager.flush();

		// A hub `send` racing the recycle, launched from inside parkAll() so it
		// enters ensureLive() while the barrier is UP — the same seam the
		// success-path ordering test uses.
		// The refusal outcome, captured the instant the send is launched. This
		// waiter is EXPECTED to reject, and the restart's own rejection is awaited
		// first, so without owning it here it would surface as an unhandled
		// rejection before any assertion reaches it.
		let sendOutcome: Promise<string> | undefined;
		const realParkAll = lifecycle.parkAll.bind(lifecycle);
		lifecycle.parkAll = async deadlineAt => {
			const release = await realParkAll(deadlineAt);
			const racing = lifecycle.ensureLive("Sub");
			sendOutcome = racing.then(
				() => "resolved",
				(error: unknown) => (error instanceof Error ? error.message : String(error)),
			);
			return release;
		};

		try {
			// The restart propagates the callback's failure, as its contract says.
			await expect(parent.requestRestart()).rejects.toThrow(reattachFailure.message);
			if (!sendOutcome) throw new Error("Expected the racing send to have been launched");

			// The waiter is REFUSED rather than revived onto the disposed parent.
			expect(await sendOutcome).toMatch(/replacement failed to attach/);
			expect(staleReviverRuns).toBe(0);
			expect(registry.get("Sub")?.session).toBeNull();

			// A revival started AFTER the failed handoff, with the barrier already
			// lifted, is in the SAME position as the waiter above: the shared
			// dependencies that recycle disposed are still gone. So it is refused
			// too — the failure is retained state, not a window the barrier held
			// open, and scoping the refusal to overlapping waiters would let this
			// one through onto the disposed parent.
			await expect(lifecycle.ensureLive("Sub")).rejects.toThrow(/replacement failed to attach/);

			// And retained is not permanent: it ends when a replacement rebinds the
			// revival dependencies, which on this path is the host installing its
			// persisted-subagent reviver factory. That factory is built from the
			// new parent's auth, models, MCP and artifact managers, so its
			// existence is what proves the resources are live again — the retained
			// reviver never is, since it closes over the parent this recycle
			// disposed. A refusal that never lifted would strand every later send.
			let factoryReviverRuns = 0;
			lifecycle.setPersistedSubagentReviverFactory(async () => {
				factoryReviverRuns++;
				return async () => ({ dispose: async () => {} }) as unknown as AgentSession;
			}, 0);
			await expect(lifecycle.ensureLive("Sub")).resolves.toBeDefined();
			expect(factoryReviverRuns).toBe(1);
			// The stale closure stayed unused throughout.
			expect(staleReviverRuns).toBe(0);
		} finally {
			lifecycle.parkAll = realParkAll;
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
		}
	});
});
