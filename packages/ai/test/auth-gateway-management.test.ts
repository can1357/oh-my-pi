import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { RouteDecisionTraceLog, startAuthGateway } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	clearCustomApis();
});

const primaryId = "primary-id";
const virtualId = "virtual-a";
const apiKeySecret = "sk-secret-live-key";
const oauthAccess = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.sig";

type ErrorBody = { error?: string };
type OkBody = { ok?: boolean };
type ListBody<T> = { object: string; generation?: number; data: T[] };
type HealthRouteRow = { id: string; generation: number; targets: string[]; fallbacks?: unknown };
type CredentialRow = { id: number; provider: string; type: string; [key: string]: unknown };
type ExecutionTraceRow = {
	requestId: string;
	routeId: string;
	generation: number;
	selectedTarget: string;
	disposition: string;
	reason?: string;
	recordedAtMs: number;
	prompt?: unknown;
};

const UNAUTH_ENDPOINTS: Array<{ method: string; path: string }> = [
	{ method: "GET", path: "/v1/executions/exec-1" },
	{ method: "GET", path: "/v1/health/routes" },
	{ method: "GET", path: "/v1/credentials" },
	{ method: "POST", path: "/v1/credentials/1/disable" },
	{ method: "POST", path: "/v1/credentials/1/pin" },
];

async function withManagementGateway(
	run: (ctx: { url: string; storage: AuthStorage; traces: RouteDecisionTraceLog }) => Promise<void>,
	setup?: (storage: AuthStorage, traces: RouteDecisionTraceLog) => void,
): Promise<void> {
	registerMockApi();
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-mgmt-"));
	const storage = await AuthStorage.create(path.join(dir, "auth.db"));
	const traces = new RouteDecisionTraceLog();
	setup?.(storage, traces);
	const primary = createMockModel({ provider: "openrouter", id: primaryId });
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: ["t"],
		storage,
		resolveModel: (id: string) => (id === primaryId ? primary.model : undefined),
		listModels: () => [primary.model],
		routes: [
			{
				id: virtualId,
				root: { type: "target", model: primaryId },
			},
		],
		decisionTraces: traces,
		version: "test",
	});
	try {
		await run({ url: handle.url, storage, traces });
	} finally {
		await handle.close();
		storage.close();
		await fs.rm(dir, { recursive: true, force: true });
	}
}

describe("auth-gateway management endpoints", () => {
	it("returns 401 without a bearer token on each endpoint (negative)", async () => {
		await withManagementGateway(async ({ url }) => {
			for (const endpoint of UNAUTH_ENDPOINTS) {
				const res = await fetch(`${url}${endpoint.path}`, { method: endpoint.method });
				expect(res.status).toBe(401);
				const body = (await res.json()) as ErrorBody;
				expect(body.error).toBe("unauthorized");
			}
		});
	});

	it("returns 404 for an unknown execution id (negative)", async () => {
		await withManagementGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/executions/missing`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrorBody;
			expect(body.error).toBe("Unknown execution: missing");
		});
	});

	it("returns redacted traces for a known execution and never includes prompts", async () => {
		await withManagementGateway(
			async ({ url }) => {
				const res = await fetch(`${url}/v1/executions/exec-1`, {
					headers: { Authorization: "Bearer t" },
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as ListBody<ExecutionTraceRow>;
				expect(body.object).toBe("list");
				expect(body.data).toHaveLength(1);
				expect(body.data[0]?.requestId).toBe("exec-1");
				expect(body.data[0]?.disposition).toBe("dispatched");
				expect(body.data[0]?.prompt).toBeUndefined();
				expect(JSON.stringify(body)).not.toContain("prompt");
			},
			(_storage, traces) => {
				traces.record({
					requestId: "exec-1",
					routeId: virtualId,
					generation: 2,
					selectedTarget: primaryId,
					disposition: "dispatched",
				});
			},
		);
	});

	it("lists virtual route ids, generations, and targets without credentials", async () => {
		await withManagementGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/health/routes`, {
				headers: { Authorization: "Bearer t" },
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as ListBody<HealthRouteRow>;
			expect(body.object).toBe("list");
			expect(typeof body.generation).toBe("number");
			expect(body.data).toHaveLength(1);
			expect(body.data[0]?.id).toBe(virtualId);
			expect(body.data[0]?.targets).toEqual([primaryId]);
			expect(body.data[0]?.fallbacks).toBeUndefined();
			const row = body.data[0];
			if (!row) throw new Error("expected a health route row");
			expect(Object.keys(row).sort()).toEqual(["generation", "id", "targets"]);
			expect(JSON.stringify(body)).not.toMatch(/sk-|eyJ/);
		});
	});

	it("lists snapshot credentials without tokens, refresh, or api keys (negative)", async () => {
		await withManagementGateway(
			async ({ url }) => {
				const res = await fetch(`${url}/v1/credentials`, {
					headers: { Authorization: "Bearer t" },
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as ListBody<CredentialRow>;
				expect(body.object).toBe("list");
				expect(body.data).toHaveLength(2);
				for (const row of body.data) {
					expect(Object.keys(row).sort()).toEqual(["id", "provider", "type"]);
					expect(row.type === "api_key" || row.type === "oauth").toBe(true);
				}
				const serialized = JSON.stringify(body);
				expect(serialized).not.toMatch(/sk-|eyJ/);
				expect(serialized).not.toContain(apiKeySecret);
				expect(serialized).not.toContain(oauthAccess);
				expect(serialized).not.toContain("refresh-secret");
			},
			storage => {
				storage.upsertCredential("openrouter", { type: "api_key", key: apiKeySecret });
				storage.upsertCredential("anthropic", {
					type: "oauth",
					access: oauthAccess,
					refresh: "refresh-secret",
					expires: Date.now() + 60_000,
				});
			},
		);
	});

	it("returns 404 when disabling an unknown credential (negative)", async () => {
		await withManagementGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/credentials/999999/disable`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(404);
			const body = (await res.json()) as ErrorBody;
			expect(body.error).toBe("No credential with id=999999");
		});
	});

	it("disables a stored credential and returns 200", async () => {
		await withManagementGateway(
			async ({ url, storage }) => {
				const id = storage.exportSnapshot().credentials[0]?.id;
				if (id === undefined) throw new Error("expected a stored credential");
				const res = await fetch(`${url}/v1/credentials/${id}/disable`, {
					method: "POST",
					headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
					body: "{}",
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as OkBody;
				expect(body.ok).toBe(true);
				const listed = await fetch(`${url}/v1/credentials`, {
					headers: { Authorization: "Bearer t" },
				});
				const listedBody = (await listed.json()) as ListBody<CredentialRow>;
				expect(listedBody.data).toEqual([]);
			},
			storage => {
				storage.upsertCredential("openrouter", { type: "api_key", key: apiKeySecret });
			},
		);
	});

	it("returns 400 when pin is missing provider or sessionId (negative)", async () => {
		await withManagementGateway(async ({ url }) => {
			const res = await fetch(`${url}/v1/credentials/1/pin`, {
				method: "POST",
				headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
				body: "{}",
			});
			expect(res.status).toBe(400);
			const body = (await res.json()) as ErrorBody;
			expect(body.error).toBe("provider and sessionId are required");
		});
	});

	it("pins a session to an OAuth credential", async () => {
		await withManagementGateway(
			async ({ url, storage }) => {
				const id = storage.exportSnapshot().credentials[0]?.id;
				if (id === undefined) throw new Error("expected a stored credential");
				const res = await fetch(`${url}/v1/credentials/${id}/pin`, {
					method: "POST",
					headers: { Authorization: "Bearer t", "Content-Type": "application/json" },
					body: JSON.stringify({ provider: "anthropic", sessionId: "sess-1" }),
				});
				expect(res.status).toBe(200);
				const body = (await res.json()) as OkBody;
				expect(body.ok).toBe(true);
			},
			storage => {
				storage.upsertCredential("anthropic", {
					type: "oauth",
					access: oauthAccess,
					refresh: "refresh-secret",
					expires: Date.now() + 60_000,
				});
			},
		);
	});
});
