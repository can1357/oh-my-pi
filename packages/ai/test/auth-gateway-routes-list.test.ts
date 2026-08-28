import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

const primaryId = "primary-id";
const backupId = "backup-id";

type RoutesListResponse = {
	object: string;
	generation: number;
	data: Array<{
		id: string;
		generation: number;
		targets: string[];
		fallbacks: Record<string, string[]>;
	}>;
};

describe("auth-gateway GET /v1/routes", () => {
	it("lists two registered virtual ids with generation greater than 1", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-routes-list-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const primary = createMockModel({ provider: "openrouter", id: primaryId });
		const backup = createMockModel({ provider: "openrouter", id: backupId });
		const resolveModel = (id: string) => {
			if (id === primaryId) return primary.model;
			if (id === backupId) return backup.model;
			return undefined;
		};
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			listModels: () => [primary.model, backup.model],
			routes: [
				{
					id: "virtual-a",
					root: {
						type: "fallback",
						on: ["provider_unavailable"],
						children: [
							{ type: "target", model: primaryId },
							{ type: "target", model: backupId },
						],
					},
				},
				{
					id: "virtual-b",
					root: { type: "target", model: backupId },
				},
			],
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/routes`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as RoutesListResponse;
			expect(body.object).toBe("list");
			expect(body.generation).toBeGreaterThan(1);
			expect(body.data.map(row => row.id)).toEqual(["virtual-a", "virtual-b"]);
			expect(body.data).toEqual([
				{
					id: "virtual-a",
					generation: 2,
					targets: [primaryId, backupId],
					fallbacks: { provider_unavailable: [backupId] },
				},
				{
					id: "virtual-b",
					generation: 3,
					targets: [backupId],
					fallbacks: {},
				},
			]);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns 401 without a bearer token (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-routes-list-unauth-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => undefined,
			routes: [
				{
					id: "virtual-a",
					root: { type: "target", model: primaryId },
				},
			],
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/routes`);
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toBe("unauthorized");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns 404 JSON for a non-GET method on /v1/routes (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-routes-list-method-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel: () => undefined,
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/routes`, {
				method: "POST",
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error?: string };
			expect(body.error).toBe("No route: POST /v1/routes");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("returns empty data for a concrete-only gateway (negative)", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-routes-list-empty-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const primary = createMockModel({ provider: "openrouter", id: primaryId });
		const backup = createMockModel({ provider: "openrouter", id: backupId });
		const resolveModel = (id: string) => {
			if (id === primaryId) return primary.model;
			if (id === backupId) return backup.model;
			return undefined;
		};
		const handle = startAuthGateway({
			bind: "127.0.0.1:0",
			bearerTokens: ["t"],
			storage,
			resolveModel,
			listModels: () => [primary.model, backup.model],
			version: "test",
		});
		try {
			const res = await fetch(`${handle.url}/v1/routes`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as RoutesListResponse;
			expect(body.object).toBe("list");
			expect(body.data).toEqual([]);
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain(primaryId);
			expect(serialized).not.toContain(backupId);
			expect(serialized).not.toContain("openrouter/");
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
