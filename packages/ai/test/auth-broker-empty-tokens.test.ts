/**
 * Contract: an EMPTY bearerTokens set is only an unauthenticated opt-in on a
 * loopback bind (see `startAuthBroker`'s `allowUnauthenticated` gate). A
 * non-loopback bind with no tokens must fail closed — the health probe stays
 * public so liveness checks keep working, but every protected route requires
 * a bearer token no caller can possess.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai";
import { type AuthBrokerServerHandle, startAuthBroker } from "@oh-my-pi/pi-ai/auth-broker";
import { removeWithRetries } from "../../utils/src/temp";

describe("broker with empty bearerTokens on a non-loopback bind", () => {
	let tempDir = "";
	let storage: AuthStorage | undefined;
	let handle: AuthBrokerServerHandle | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-broker-empty-tokens-"));
		const store = await SqliteAuthCredentialStore.open(path.join(tempDir, "broker.db"));
		storage = new AuthStorage(store);
		await storage.reload();
		// 0.0.0.0 bind with zero tokens: unauthenticated access must stay OFF.
		handle = startAuthBroker({
			storage,
			bind: "0.0.0.0:0",
			bearerTokens: [],
			disableRefresher: true,
		});
	});

	afterEach(async () => {
		await handle?.close();
		storage?.close();
		await removeWithRetries(tempDir);
	});

	/** Connect via loopback regardless of the bind address the server reports. */
	function loopbackUrl(pathname: string): string {
		return `http://127.0.0.1:${handle!.port}${pathname}`;
	}

	test("health endpoint stays public and protected routes reject without a token", async () => {
		const health = await fetch(loopbackUrl("/v1/healthz"));
		expect(health.status).toBe(200);
		expect(await health.json()).toMatchObject({ ok: true });

		const snapshot = await fetch(loopbackUrl("/v1/snapshot"));
		expect(snapshot.status).toBe(401);
		expect(await snapshot.json()).toEqual({ error: "unauthorized" });

		// Any presented bearer token fails too: the token set is empty, so no
		// value can ever match.
		const bearer = await fetch(loopbackUrl("/v1/snapshot"), {
			headers: { authorization: "Bearer whatever" },
		});
		expect(bearer.status).toBe(401);
	});
});
