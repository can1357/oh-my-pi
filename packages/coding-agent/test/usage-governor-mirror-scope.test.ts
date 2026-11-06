import { describe, expect, spyOn, test } from "bun:test";
import { ModelRegistry, type ModelRegistryOwner } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { SessionUsageRouting } from "../src/session/usage-routing";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { authService } from "../src/thread/services/auth";
import { startServiceWorker } from "./helpers/service-worker";
import type { Probe } from "./fixtures/usage-governor-mirror-scope/worker";
import {
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	PROVIDER,
	seedAccounts,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";

describe("mirror routing scope invalidation", () => {
	test("notifies once after discovery, isolates listener failures, and does not echo or notify skipped changes", async () => {
		const storage = createInMemoryAuthStorage();
		const registry = new ModelRegistry(storage, undefined, { owner: {} as ModelRegistryOwner });
		const events: number[] = [];
		registry.subscribeMirror(() => {
			throw new Error("listener failure");
		});
		registry.subscribeMirror(batch => events.push(batch.seq));
		registry.applyMirrorBatch({
			seq: 1,
			changes: [{ seq: 1, kind: "invalidateCommands", provider: undefined }],
			discovery: { states: [] },
		});
		expect(events).toEqual([1]);
		registry.applyMirrorBatch({ seq: 1, changes: [{ seq: 1, kind: "invalidateCommands", provider: undefined }] });
		expect(events).toEqual([1]);
		registry.applyMirrorBatch({ seq: 1, changes: [], discovery: { states: [] } });
		expect(events).toEqual([1, 1]);
		await Promise.resolve();
		expect(events).toEqual([1, 1]);
	});

	test("failed forced reconstruction revokes the old scope and retries an unchanged signature", () => {
		const storage = createInMemoryAuthStorage();
		const settings = Settings.isolated({});
		const registry = new ModelRegistry(storage, undefined, { settings, owner: {} as ModelRegistryOwner });
		const remove = spyOn(storage.governor, "removeRoutingScope");
		const routing = new SessionUsageRouting(settings, registry);
		try {
			const original = routing.refresh();
			expect(original).toBeDefined();
			const roles = spyOn(settings, "getModelRoles").mockImplementation(() => {
				throw new Error("rebuild failed");
			});
			registry.applyMirrorBatch({ seq: 1, changes: [], discovery: { states: [] } });
			expect(remove).toHaveBeenCalledWith(original!.id);
			roles.mockRestore();
			const rebuilt = routing.refresh();
			expect(rebuilt?.id).toBe(original?.id);
			expect(rebuilt?.revision).toBeGreaterThan(original!.revision);
		} finally {
			routing.dispose();
			remove.mockRestore();
		}
	});
});

test("worker forwards explicit serving account and null unchanged in header RPC", async () => {
	const h = await createHarness(ENABLED);
	await seedAccounts(h, PROVIDER, [
		{ accountId: "a", email: "a@example.test", window: windowAt(30_000, 60_000, 0.1) },
		{ accountId: "b", email: "b@example.test", window: windowAt(30_000, 60_000, 0.1) },
	]);
	const worker = await startServiceWorker<Probe>(
		new URL("./fixtures/usage-governor-mirror-scope/worker.ts", import.meta.url),
		[authService],
	);
	const ingest = spyOn(h.storage.usage, "ingestHeaders").mockReturnValue(true);
	try {
		const b = credentialIdOf(h, PROVIDER, "b");
		expect(await worker.probe.ingest(h.storage, PROVIDER, { sessionId: "s", credentialId: b })).toBe(true);
		expect(ingest).toHaveBeenLastCalledWith(PROVIDER, { "x-test": "1" }, { sessionId: "s", credentialId: b });
		expect(await worker.probe.ingest(h.storage, PROVIDER, { credentialId: null })).toBe(true);
		expect(ingest).toHaveBeenLastCalledWith(PROVIDER, { "x-test": "1" }, { credentialId: null });
	} finally {
		ingest.mockRestore();
		await worker.stop();
		await disposeHarness();
	}
});
