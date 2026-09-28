import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { freezeTabsForOwner, releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const OWNER_ID = "browser-emulation-test-owner";
const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	getSessionFile: () => null,
	getSessionSpawns: () => "*",
	getSessionId: () => OWNER_ID,
	settings: Settings.isolated({
		"browser.enabled": true,
		"browser.headless": true,
		"browser.cmux": false,
		"tools.maxTimeout": 0,
	}),
};
const prelude = createBrowserPrelude(session);
const context = { session, toolCallId: "browser-emulation-test" };
let server: Bun.Server<undefined>;
let pageUrl = "";

async function invoke(parameters: unknown) {
	return await prelude.invoke(parameters, context);
}

function valueFrom(result: { details?: Record<string, unknown> }): unknown {
	return result.details?.value;
}

async function call(method: string, args: unknown[] = []): Promise<unknown> {
	const result = await invoke({ action: "call", name: "emulation", chain: [{ method, args }] });
	return valueFrom(result as { details?: Record<string, unknown> });
}

async function run(code: string): Promise<unknown> {
	const result = await invoke({ action: "run", name: "emulation", code });
	return valueFrom(result as { details?: Record<string, unknown> });
}

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === "/headers") {
				return Response.json({ value: request.headers.get("x-emulation") });
			}
			if (url.pathname === "/auth") {
				const expected = `Basic ${btoa("agent:secret")}`;
				if (request.headers.get("authorization") !== expected) {
					return new Response("authenticate", {
						status: 401,
						headers: { "WWW-Authenticate": 'Basic realm="emulation"' },
					});
				}
				return new Response("authorized");
			}
			return new Response(
				"<!doctype html><meta name='viewport' content='width=device-width'><title>emulation fixture</title><input id='paste'>",
				{ headers: { "Content-Type": "text/html" } },
			);
		},
	});
	pageUrl = `http://127.0.0.1:${server.port}/`;
});

afterAll(async () => {
	server?.stop(true);
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser device, network, media, and clipboard emulation", () => {
	it("persists independent overrides and exposes them to page APIs and requests", async () => {
		await invoke({ action: "open", name: "emulation", url: pageUrl });
		try {
			const deviceNames = (await call("devices")) as string[];
			expect(deviceNames).toContain("iPhone 14");

			const mediaState = await call("emulate", [{ colorScheme: "dark" }]);
			expect(mediaState).toMatchObject({ colorScheme: "dark" });
			expect(await run("return await tab.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)")).toBe(
				true,
			);

			await call("emulate", [{ device: "iPhone 14" }]);
			const initialDevice = (await run(
				"return await tab.evaluate(() => ({ width: innerWidth, userAgent: navigator.userAgent, touch: navigator.maxTouchPoints > 0 }))",
			)) as { width: number; userAgent: string; touch: boolean };
			expect(initialDevice.width).toBe(390);
			expect(initialDevice.userAgent).toContain("iPhone");
			expect(initialDevice.touch).toBe(true);
			await call("goto", [`${pageUrl}device`]);
			expect(await freezeTabsForOwner(OWNER_ID)).toBe(1);
			const navigatedDevice = (await run(
				"return await tab.evaluate(() => ({ width: innerWidth, userAgent: navigator.userAgent, dark: matchMedia('(prefers-color-scheme: dark)').matches }))",
			)) as { width: number; userAgent: string; dark: boolean };
			expect(navigatedDevice.width).toBe(390);
			expect(navigatedDevice.userAgent).toContain("iPhone");
			expect(navigatedDevice.dark).toBe(true);

			await call("emulate", [{ geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 12 } }]);
			const position = (await run(
				"return await tab.evaluate(() => { const {promise, resolve, reject} = Promise.withResolvers(); navigator.geolocation.getCurrentPosition(({coords}) => resolve({latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy}), reject); return promise; })",
			)) as { latitude: number; longitude: number; accuracy: number };
			expect(position).toEqual({ latitude: 37.7749, longitude: -122.4194, accuracy: 12 });

			await call("emulate", [{ offline: true }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url, { cache: "no-store" }).then(() => false, () => true), ${JSON.stringify(`${pageUrl}ping?offline=1`)})`,
				),
			).toBe(true);
			await call("emulate", [{ offline: false }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url, { cache: "no-store" }).then(response => response.ok), ${JSON.stringify(`${pageUrl}ping?offline=0`)})`,
				),
			).toBe(true);

			await call("emulate", [{ headers: { "x-emulation": "header-value" } }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url).then(response => response.json()), ${JSON.stringify(`${pageUrl}headers`)})`,
				),
			).toEqual({ value: "header-value" });

			await call("emulate", [{ credentials: { username: "agent", password: "secret" } }]);
			expect(
				await run(
					`return await tab.evaluate(url => fetch(url).then(response => response.text()), ${JSON.stringify(`${pageUrl}auth`)})`,
				),
			).toBe("authorized");

			const writeResult = (await call("clipboardWrite", ["clipboard round trip"])) as { source: string };
			const readResult = (await call("clipboardRead")) as { text: string; source: string };
			expect(readResult.text).toBe("clipboard round trip");
			expect(["page", "shim"]).toContain(writeResult.source);
			expect(["page", "shim"]).toContain(readResult.source);
		} finally {
			await invoke({ action: "close", name: "emulation" });
		}
	}, 30_000);
});
