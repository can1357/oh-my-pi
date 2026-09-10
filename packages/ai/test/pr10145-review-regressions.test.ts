import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	RouteRegistry,
	StreamCommitGate,
	releaseTurnOnStreamEnd,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { AssistantMessage } from "@oh-my-pi/pi-ai/types";

afterEach(() => {
	clearCustomApis();
	vi.restoreAllMocks();
});

function storageSpies(): Pick<AuthStorage, "releaseTurnReservation" | "settleQuotaProbeSuccess"> {
	return {
		releaseTurnReservation: vi.fn(),
		settleQuotaProbeSuccess: vi.fn(),
	} as unknown as Pick<AuthStorage, "releaseTurnReservation" | "settleQuotaProbeSuccess">;
}

const successfulMessage = { stopReason: "stop" } as AssistantMessage;

describe("PR10145 stream and eligibility regressions", () => {
	it("releases the reservation without probe success when a downstream read fails", async () => {
		const storage = storageSpies();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.error(new Error("downstream read failed"));
			},
		});
		const wrapped = releaseTurnOnStreamEnd(
			source,
			storage as AuthStorage,
			"request-read-error",
			new StreamCommitGate(),
			Promise.resolve(successfulMessage),
		);

		await expect(wrapped.getReader().read()).rejects.toThrow("downstream read failed");
		expect(storage.releaseTurnReservation).toHaveBeenCalledWith("request-read-error");
		expect(storage.settleQuotaProbeSuccess).not.toHaveBeenCalled();
	});

	it("releases a cancelled stream without awaiting or settling a hung result", async () => {
		const storage = storageSpies();
		const pending = Promise.withResolvers<AssistantMessage>();
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array([1]));
			},
		});
		const wrapped = releaseTurnOnStreamEnd(
			source,
			storage as AuthStorage,
			"request-cancelled",
			(() => {
				const gate = new StreamCommitGate();
				gate.classifyAndObserve("response.output_text.delta", 1);
				return gate;
			})(),
			pending.promise,
		);
		const reader = wrapped.getReader();

		await reader.read();
		await reader.cancel("client cancelled");
		expect(storage.releaseTurnReservation).toHaveBeenCalledWith("request-cancelled");
		expect(storage.settleQuotaProbeSuccess).not.toHaveBeenCalled();
	});

	it("continues after an unresolved intermediate fallback target", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pr10145-route-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.setRuntimeApiKey("openrouter", "test-key");
		const primary = createMockModel({
			provider: "openrouter",
			id: "primary-id",
			handler: () => {
				throw new Error("service unavailable");
			},
		});
		const backup = createMockModel({ provider: "openrouter", id: "backup-id", handler: { content: ["ok"] } });
		const resolveModel = (id: string) => {
			if (id === "primary-id") return primary.model;
			if (id === "backup-id") return backup.model;
			return undefined;
		};
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-pr10145",
			root: {
				type: "fallback",
				on: ["provider_unavailable", "model_unavailable"],
				children: [
					{ type: "target", model: "primary-id" },
					{ type: "target", model: "missing-id" },
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
			const response = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-pr10145",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			expect(response.status).toBe(200);
			expect(backup.calls).toHaveLength(1);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("does not use a context_overflow-only edge for a credentialless target", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-pr10145-negative-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		const primary = createMockModel({
			provider: "unconfigured-provider",
			id: "primary-id",
			handler: { content: ["bad"] },
		});
		const backup = createMockModel({ provider: "openrouter", id: "backup-id", handler: { content: ["bad"] } });
		const resolveModel = (id: string) =>
			id === "primary-id" ? primary.model : id === "backup-id" ? backup.model : undefined;
		const registry = new RouteRegistry(resolveModel);
		registry.register({
			id: "virtual-pr10145-negative",
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
			const response = await fetch(`${handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
				body: JSON.stringify({
					model: "virtual-pr10145-negative",
					messages: [{ role: "user", content: "hi" }],
					stream: false,
				}),
			});

			expect(response.status).toBe(503);
			expect(backup.calls).toHaveLength(0);
		} finally {
			await handle.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
