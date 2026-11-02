/**
 * A session's disposal is asynchronous and can resume long after it started. Everything it
 * tears down must be the instance the session ran under, never whatever is global when the
 * teardown gets there: otherwise a slow disposal destroys the next owner's agents.
 */
import { expect, vi } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { TestCleanup } from "./helpers/test-cleanup";
import { trackTestLifetime } from "./helpers/test-lifetime";

const { test, beforeEach, afterEach } = trackTestLifetime();

let cleanup = new TestCleanup();

beforeEach(() => {
	cleanup = new TestCleanup();
});

afterEach(async () => {
	// Everything that touches shared state runs before the first await: a disposal can outlive
	// this hook's timeout, and code after the await would then run during the next test.
	vi.restoreAllMocks();
	const ending = cleanup.end();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	VibeSessionRegistry.resetGlobalForTests();
	const failures = await ending;
	if (failures.length > 0) throw new AggregateError(failures, "test cleanup failed");
});

test("a main session disposes the lifecycle and vibe owners it ran under, not the ones that replaced them", async () => {
	const owner = cleanup;
	const tempDir = TempDir.createSync("@pi-session-dispose-owner-");
	await owner.add(() => tempDir.removeSync());
	const authStorage = createInMemoryAuthStorage();
	await owner.add(() => authStorage.close());
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled test model");

	const { session } = await createAgentSession({
		cwd: tempDir.path(),
		agentDir: tempDir.path(),
		sessionManager: SessionManager.inMemory(tempDir.path()),
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
		settings: Settings.isolated({ "async.enabled": false, "compaction.enabled": false }),
		model,
		toolNames: ["read"],
		disableExtensionDiscovery: true,
	});
	await owner.add(() => session.dispose());

	// Stand in for the next test (or the next embedded session): new process-global owners,
	// with an adopted subagent of their own.
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	VibeSessionRegistry.resetGlobalForTests();
	const nextRegistry = AgentRegistry.global();
	const nextLifecycle = AgentLifecycleManager.global();
	const nextVibe = VibeSessionRegistry.global();
	let adoptedDisposals = 0;
	nextRegistry.register({
		id: "NextOwnerChild",
		displayName: "NextOwnerChild",
		kind: "sub",
		session: { dispose: async () => void adoptedDisposals++ } as never,
		status: "running",
	});
	nextLifecycle.adopt("NextOwnerChild", { idleTtlMs: 60_000 });
	const suspendScope = vi.spyOn(nextVibe, "suspendScope");

	await session.dispose();

	expect({
		adoptedDisposals,
		adoptedStillRegistered: Boolean(nextRegistry.get("NextOwnerChild")),
		lifecycleKept: AgentLifecycleManager.global() === nextLifecycle,
		vibeSuspensions: suspendScope.mock.calls.length,
	}).toEqual({
		adoptedDisposals: 0,
		adoptedStillRegistered: true,
		lifecycleKept: true,
		vibeSuspensions: 0,
	});
});
