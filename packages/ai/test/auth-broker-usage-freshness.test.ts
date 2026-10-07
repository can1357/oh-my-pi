import { expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { AuthBrokerClient, RemoteAuthCredentialStore, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import type { UsageProvider } from "@oh-my-pi/pi-ai/usage";
import { TempDir } from "@oh-my-pi/pi-utils";

test("display freshness reaches the broker without extending shared recovery caches", async () => {
	await using tempDir = await TempDir.create("@usage-freshness-");
	const store = await SqliteAuthCredentialStore.open(tempDir.join("agent.db"));
	let now = Date.now();
	let probes = 0;
	const provider: UsageProvider = {
		id: "usage-refresh-test",
		async fetchUsage() {
			return {
				provider: "usage-refresh-test",
				fetchedAt: now,
				limits: [
					{
						id: "quota",
						scope: { provider: "usage-refresh-test" },
						label: "Quota",
						amount: { used: ++probes * 10, limit: 100, unit: "requests" },
					},
				],
			};
		},
	};
	await store.saveOAuth("usage-refresh-test", {
		access: "test-token",
		refresh: "test-refresh",
		expires: now + 3_600_000,
	});
	const storage = new AuthStorage(store, {
		usageProviderResolver: id => (id === provider.id ? provider : undefined),
	});
	await storage.credentials.reload();
	const broker = startAuthBroker({ storage, bind: "127.0.0.1:0", bearerTokens: ["test"], disableRefresher: true });
	const client = new AuthBrokerClient({ url: broker.url, token: "test" });
	const snapshot = await client.fetchSnapshot();
	if (snapshot.status !== 200) throw new Error("Expected broker snapshot");
	const remote = new RemoteAuthCredentialStore({ client, initialSnapshot: snapshot.snapshot, streamSnapshots: false });
	const display = new AuthStorage(remote, { usageProviderResolver: () => undefined });
	const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
	try {
		const first = await display.usage.reports();
		expect(first?.[0]?.limits[0]?.amount.used).toBe(10);

		now += 90_000;
		// A stricter caller must not inherit an in-flight default poll's old
		// report through either the remote 15s cache or the broker's 5m cache.
		const [cached, fresh] = await Promise.all([display.usage.reports(), display.usage.reports({ maxAgeMs: 60_000 })]);
		expect(cached?.[0]?.limits[0]?.amount.used).toBe(10);
		expect(fresh?.[0]?.limits[0]?.amount.used).toBe(20);
		expect(probes).toBe(2);

		now += 60_000;
		const peers = await Promise.all([
			display.usage.reports({ maxAgeMs: 60_000 }),
			display.usage.reports({ maxAgeMs: 60_000 }),
		]);
		expect(peers.map(reports => reports?.[0]?.limits[0]?.amount.used)).toEqual([30, 30]);
		expect(probes).toBe(3);

		now += 90_000;
		await display.usage.reports({ maxAgeMs: 600_000 });
		const beforeRecoveryPoll = probes;
		// A long display interval must not leave normal recovery/ranking reads
		// accepting a ten-minute-old report from the shared credential cache.
		now += 400_000;
		await storage.usage.reports();
		expect(probes).toBe(beforeRecoveryPoll + 1);

		const invalid = await fetch(`${broker.url}/v1/usage?maxAgeMs=1000`, {
			headers: { Authorization: "Bearer test" },
		});
		expect(invalid.status).toBe(400);
	} finally {
		display.close();
		await broker.close();
		storage.close();
		clock.mockRestore();
	}
});
