import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-storage-state-"));
const session: ToolSession = {
	cwd: root,
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-storage-state-test" };
let server: Bun.Server<undefined>;
let pageUrl = "";

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

function valueFrom(result: { details?: unknown }): unknown {
	const details = result.details;
	if (!details || typeof details !== "object" || !("value" in details)) return undefined;
	return details.value;
}

async function call(name: string, method: string, args: unknown[] = []): Promise<unknown> {
	return valueFrom(await invoke({ action: "call", name, chain: [{ method, args }] }));
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch() {
			return new Response("<!doctype html><title>storage fixture</title>", {
				headers: { "Set-Cookie": "server_cookie=from_header; Path=/; HttpOnly; SameSite=Lax" },
			});
		},
	});
	pageUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(async () => {
	server?.stop(true);
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	await fs.rm(root, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser cookie and storage state helpers", () => {
	it("imports cookies, round-trips storage, and restores a saved state in a fresh tab", async () => {
		await invoke({ action: "open", name: "state-source", url: pageUrl });
		try {
			const responseCookies = (await call("state-source", "cookies")) as Array<Record<string, unknown>>;
			expect(responseCookies).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						name: "server_cookie",
						value: "from_header",
						httpOnly: true,
						path: "/",
						sameSite: "Lax",
					}),
				]),
			);

			await call("state-source", "setCookies", ["a=1; b=2", { url: pageUrl }]);
			await call("state-source", "setCookies", [`curl '${pageUrl}' -H 'cookie: curl_cookie=imported'`]);
			await call("state-source", "setCookies", [
				JSON.stringify([{ name: "json_cookie", value: "json-imported", url: pageUrl }]),
			]);
			const imported = (await call("state-source", "cookies")) as Array<Record<string, unknown>>;
			expect(imported.map(cookie => cookie.name)).toEqual(
				expect.arrayContaining(["a", "b", "curl_cookie", "json_cookie", "server_cookie"]),
			);

			await call("state-source", "setStorage", ["local", "plain", "round-trip"]);
			await call("state-source", "setStorage", ["local", { structured: { enabled: true } }]);
			await call("state-source", "setStorage", ["session", "session-key", "session-value"]);
			expect(await call("state-source", "storage", ["local", { key: "plain" }])).toBe("round-trip");
			expect(await call("state-source", "storage", ["local"])).toMatchObject({
				plain: "round-trip",
				structured: '{"enabled":true}',
			});

			const saved = await call("state-source", "saveState", ["saved-state.json"]);
			expect(saved).toBe(path.join(root, "saved-state.json"));
		} finally {
			await invoke({ action: "close", name: "state-source" });
		}

		await invoke({ action: "open", name: "state-target", url: pageUrl });
		try {
			await call("state-target", "clearCookies");
			await call("state-target", "clearStorage", ["local"]);
			await call("state-target", "clearStorage", ["session"]);
			expect(await call("state-target", "cookies")).toEqual([]);
			expect(await call("state-target", "storage", ["local"])).toEqual({});

			const restored = await call("state-target", "loadState", ["saved-state.json"]);
			expect(restored).toEqual({ loadedOrigins: [new URL(pageUrl).origin], skippedOrigins: [] });
			const restoredCookies = (await call("state-target", "cookies")) as Array<Record<string, unknown>>;
			expect(restoredCookies.map(cookie => cookie.name)).toEqual(
				expect.arrayContaining(["a", "b", "curl_cookie", "json_cookie", "server_cookie"]),
			);
			expect(await call("state-target", "storage", ["local", { key: "plain" }])).toBe("round-trip");
			expect(await call("state-target", "storage", ["session", { key: "session-key" }])).toBe("session-value");
		} finally {
			await invoke({ action: "close", name: "state-target" });
		}
	}, 30_000);

	it("does not echo cookie values from malformed imports", async () => {
		await invoke({ action: "open", name: "bad-cookie", url: pageUrl });
		const secret = "cookie-secret-must-not-leak";
		try {
			let message = "";
			try {
				await call("bad-cookie", "setCookies", [`[{"name":"broken","value":"${secret}"}`]);
			} catch (error) {
				message = error instanceof Error ? error.message : String(error);
			}
			expect(message).toContain("malformed cookie input");
			expect(message).not.toContain(secret);
		} finally {
			await invoke({ action: "close", name: "bad-cookie" });
		}
	}, 15_000);
});
