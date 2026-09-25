import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteRegistry, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

it("does not use an overflow-only fallback for a credentialless target", async () => {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-conductor-wire-credentialless-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	storage.setRuntimeApiKey("backup-provider", "test-key");
	const primary = createMockModel({
		provider: "primary-provider",
		id: "primary-id",
		handler: { content: ["bad"] },
	});
	const backup = createMockModel({
		provider: "backup-provider",
		id: "backup-id",
		handler: { content: ["ok"] },
	});
	const resolveModel = (id: string) => {
		if (id === "primary-id") return primary.model;
		if (id === "backup-id") return backup.model;
		return undefined;
	};
	const registry = new RouteRegistry(resolveModel);
	registry.register({
		id: "virtual-impl",
		root: {
			type: "fallback",
			on: ["context_overflow"],
			children: [
				{ type: "target", model: "primary-id" },
				{ type: "target", model: "backup-id" },
			],
		},
	});
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel,
		routeRegistry: registry,
		version: "test",
	});
	try {
		const res = await fetch(`${handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
			body: JSON.stringify({
				model: "virtual-impl",
				messages: [{ role: "user", content: "hi" }],
				stream: false,
			}),
		});
		expect(res.status).toBe(401);
		expect(primary.calls).toHaveLength(0);
		expect(backup.calls).toHaveLength(0);
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
});
