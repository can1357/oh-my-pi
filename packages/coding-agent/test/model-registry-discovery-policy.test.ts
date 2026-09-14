import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry } from "../src/config/model-registry";
import { resetSettingsForTest } from "../src/config/settings";
import { AuthStorage } from "../src/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";

let directory: string;
let configPath: string;
let auth: AuthStorage;
beforeEach(async () => {
	resetSettingsForTest();
	directory = mkdtempSync(join(tmpdir(), "omp-discovery-policy-"));
	configPath = join(directory, "models.json");
	auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("anthropic", "account-a");
});
afterEach(() => {
	auth.close();
	resetSettingsForTest();
	removeSyncWithRetries(directory);
});

test("replace membership survives errors and offline restart while explicit models remain", async () => {
	writeFileSync(
		configPath,
		JSON.stringify({
			modelDiscovery: { mode: "replace", cacheTtlMs: 0 },
			providers: {
				anthropic: {
					api: "anthropic-messages",
					apiKey: "fixture",
					baseUrl: "https://example.test",
					models: [{ id: "manual", name: "Manual" }],
				},
			},
		}),
	);
	let ids = ["discovered-a", "discovered-b"];
	let fail = false;
	const registry = new ModelRegistry(auth, configPath, {
		fetch: async input => {
			if (String(input) === "https://example.test/v1/models") {
				if (fail) throw Error("unavailable");
				return Response.json({ data: ids.map(id => ({ id, display_name: id })), has_more: false });
			}
			return new Response("", { status: 404 });
		},
	});
	await registry.refreshProvider("anthropic", "online");
	ids = ["discovered-b", "discovered-c"];
	await registry.refreshProvider("anthropic", "online");
	fail = true;
	await registry.refreshProvider("anthropic", "online");
	expect(
		registry
			.getAll()
			.filter(m => m.provider === "anthropic")
			.map(m => m.id)
			.sort(),
	).toEqual(["discovered-b", "discovered-c", "manual"]);
	const restarted = new ModelRegistry(auth, configPath, {
		fetch: async () => {
			throw Error("offline network access");
		},
	});
	await restarted.refreshProvider("anthropic", "offline");
	expect(
		restarted
			.getAll()
			.filter(m => m.provider === "anthropic")
			.map(m => m.id)
			.sort(),
	).toEqual(["discovered-b", "discovered-c", "manual"]);
});

test("provider merge overrides global replace", async () => {
	writeFileSync(
		configPath,
		JSON.stringify({
			modelDiscovery: { mode: "replace" },
			providers: { anthropic: { modelDiscovery: { mode: "merge" } } },
		}),
	);
	const registry = new ModelRegistry(auth, configPath, {
		fetch: async input =>
			String(input) === "https://api.anthropic.com/v1/models"
				? Response.json({ data: [{ id: "discovered", display_name: "Discovered" }], has_more: false })
				: new Response("", { status: 404 }),
	});
	await registry.refreshProvider("anthropic", "online");
	expect(registry.find("anthropic", getBundledModels("anthropic")[0]!.id)).toBeDefined();
	expect(registry.find("anthropic", "discovered")).toBeDefined();
});

test("runtime credential switching cannot reuse or display the previous account catalog", async () => {
	writeFileSync(configPath, JSON.stringify({ modelDiscovery: { mode: "replace" } }));
	let allowed = "account-a";
	const registry = new ModelRegistry(auth, configPath, {
		fetch: async input => {
			if (String(input) === "https://api.anthropic.com/v1/models")
				return Response.json({ data: [{ id: allowed, display_name: allowed }], has_more: false });
			return new Response("", { status: 404 });
		},
	});
	await registry.refreshProvider("anthropic", "online");
	auth.setRuntimeApiKey("anthropic", "account-b");
	allowed = "account-b";
	await registry.refreshProvider("anthropic", "online-if-uncached");
	expect(
		registry
			.getAll()
			.filter(m => m.provider === "anthropic")
			.map(m => m.id),
	).toEqual(["account-b"]);
	const restarted = new ModelRegistry(auth, configPath, {
		fetch: async () => {
			throw Error("offline");
		},
	});
	await restarted.refreshProvider("anthropic", "offline");
	expect(
		restarted
			.getAll()
			.filter(m => m.provider === "anthropic")
			.map(m => m.id),
	).toEqual(["account-b"]);
});

test("late discovery from an old runtime identity cannot replace the current picker", async () => {
	writeFileSync(configPath, JSON.stringify({ modelDiscovery: { mode: "replace" } }));
	const started = Promise.withResolvers<void>();
	const old = Promise.withResolvers<Response>();
	let calls = 0;
	const registry = new ModelRegistry(auth, configPath, {
		fetch: async input => {
			if (String(input) !== "https://api.anthropic.com/v1/models") return new Response("", { status: 404 });
			if (++calls === 1) {
				started.resolve();
				return old.promise;
			}
			return Response.json({ data: [{ id: "account-b", display_name: "B" }], has_more: false });
		},
	});
	const first = registry.refreshProvider("anthropic", "online");
	await started.promise;
	auth.setRuntimeApiKey("anthropic", "account-b");
	await registry.refreshProvider("anthropic", "online");
	old.resolve(Response.json({ data: [{ id: "account-a", display_name: "A" }], has_more: false }));
	await first;
	expect(
		registry
			.getAll()
			.filter(m => m.provider === "anthropic")
			.map(m => m.id),
	).toEqual(["account-b"]);
});
