import { afterAll, describe, expect, test } from "bun:test";
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
const server = Bun.serve({
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/api") {
			return Response.json({ source: "fixture" }, { headers: { "access-control-allow-origin": "*" } });
		}
		if (pathname === "/text") {
			return new Response("response body", {
				headers: { "content-type": "text/plain", "access-control-allow-origin": "*" },
			});
		}
		if (pathname === "/image") {
			return new Response(Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), {
				headers: { "content-type": "image/png", "access-control-allow-origin": "*" },
			});
		}
		return new Response("<!doctype html><title>network fixture</title>", {
			headers: { "content-type": "text/html" },
		});
	},
});
const baseUrl = `http://127.0.0.1:${server.port}`;
const crossHostUrl = `http://localhost:${server.port}`;
const harPath = path.join(os.tmpdir(), `omp-browser-network-${process.pid}-${Date.now()}.har`);

function createHost() {
	const session: ToolSession = {
		cwd: process.cwd(),
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
	return (parameters: unknown) => prelude.invoke(parameters, { session, toolCallId: "browser-network-test" });
}

function valueOf(result: { details?: unknown }): unknown {
	return (result.details as { value?: unknown } | undefined)?.value;
}

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server.stop(true);
	await fs.rm(harPath, { force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser network helpers", () => {
	test("persists cooperative routes across runs and removes them with unroute", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "routes", url: `${baseUrl}/` });
		await invoke({
			action: "call",
			name: "routes",
			chain: [{ method: "route", args: ["**/api", { body: { source: "route" } }] }],
		});

		const first = valueOf(
			await invoke({
				action: "run",
				name: "routes",
				code: `return await tab.evaluate(async url => await (await fetch(url)).json(), ${JSON.stringify(`${baseUrl}/api`)})`,
			}),
		);
		expect(first).toEqual({ source: "route" });

		const second = valueOf(
			await invoke({
				action: "run",
				name: "routes",
				code: `let seen = 0;
await page.setRequestInterception(true);
page.on("request", async request => {
  if (request.url().endsWith("/api")) seen += 1;
  if (!request.isInterceptResolutionHandled()) await request.continue({}, 5);
});
const body = await tab.evaluate(async url => await (await fetch(url)).json(), ${JSON.stringify(`${baseUrl}/api`)});
return { body, seen };`,
			}),
		);
		expect(second).toEqual({ body: { source: "route" }, seen: 1 });

		await invoke({ action: "call", name: "routes", chain: [{ method: "unroute", args: ["**/api"] }] });
		const original = valueOf(
			await invoke({
				action: "run",
				name: "routes",
				code: `return await tab.evaluate(async url => await (await fetch(url)).json(), ${JSON.stringify(`${baseUrl}/api`)})`,
			}),
		);
		expect(original).toEqual({ source: "fixture" });
	});

	test("limits abort routes by resource type", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "resource-route", url: `${baseUrl}/` });
		await invoke({
			action: "call",
			name: "resource-route",
			chain: [{ method: "route", args: ["**/image", { abort: true, resourceType: "image" }] }],
		});
		const result = valueOf(
			await invoke({
				action: "run",
				name: "resource-route",
				code: `return await tab.evaluate(async url => {
  const fetched = await fetch(url).then(response => response.status);
  const image = await new Promise(resolve => {
    const element = new Image();
    element.onload = () => resolve("loaded");
    element.onerror = () => resolve("blocked");
    element.src = url;
  });
  return { fetched, image };
}, ${JSON.stringify(`${baseUrl}/image`)})`,
			}),
		);
		expect(result).toEqual({ fetched: 200, image: "blocked" });
	});

	test("filters request logs, loads response bodies, and writes matching HAR entries", async () => {
		const invoke = createHost();
		await invoke({ action: "open", name: "log", url: `${baseUrl}/` });
		await invoke({ action: "call", name: "log", chain: [{ method: "clearRequests", args: [] }] });
		await invoke({
			action: "run",
			name: "log",
			code: `await tab.evaluate(async urls => { for (const url of urls) await fetch(url); }, ${JSON.stringify([
				`${baseUrl}/text`,
				`${baseUrl}/missing`,
			])});`,
		});
		const successful = valueOf(
			await invoke({
				action: "call",
				name: "log",
				chain: [{ method: "requests", args: [{ status: "2xx" }] }],
			}),
		) as Array<{ id: string; url: string; status: number }>;
		expect(successful.some(request => request.url.endsWith("/text") && request.status === 200)).toBe(true);
		const textRequest = successful.find(request => request.url.endsWith("/text"));
		expect(textRequest).toBeDefined();
		const detail = valueOf(
			await invoke({
				action: "call",
				name: "log",
				chain: [{ method: "request", args: [textRequest!.id] }],
			}),
		) as { body?: unknown };
		expect(detail.body).toBe("response body");

		await invoke({ action: "call", name: "log", chain: [{ method: "harStart", args: [{ content: "text" }] }] });
		await invoke({
			action: "run",
			name: "log",
			code: `await tab.evaluate(async urls => { for (const url of urls) await fetch(url); }, ${JSON.stringify([
				`${baseUrl}/text?har=1`,
				`${baseUrl}/api?har=2`,
			])});`,
		});
		const stoppedPath = valueOf(
			await invoke({
				action: "call",
				name: "log",
				chain: [{ method: "harStop", args: [{ path: harPath }] }],
			}),
		);
		expect(stoppedPath).toBe(harPath);
		const har = JSON.parse(await Bun.file(harPath).text()) as { log: { entries: unknown[] } };
		expect(har.log.entries).toHaveLength(2);
	});

	test("enforces allowed_domains and logs blocked cross-host fetches", async () => {
		const invoke = createHost();
		await invoke({
			action: "open",
			name: "allowlist",
			url: `${baseUrl}/`,
			allowed_domains: ["127.0.0.1"],
		});
		const result = valueOf(
			await invoke({
				action: "run",
				name: "allowlist",
				code: `return await tab.evaluate(async urls => {
  const allowed = await fetch(urls.allowed).then(response => response.text());
  const blocked = await fetch(urls.blocked).then(() => false, () => true);
  return { allowed, blocked };
}, ${JSON.stringify({ allowed: `${baseUrl}/text`, blocked: `${crossHostUrl}/text` })})`,
			}),
		);
		expect(result).toEqual({ allowed: "response body", blocked: true });
		expect(
			valueOf(
				await invoke({
					action: "call",
					name: "allowlist",
					chain: [{ method: "allowedDomains", args: [] }],
				}),
			),
		).toEqual(["127.0.0.1"]);
		const blocked = valueOf(
			await invoke({
				action: "call",
				name: "allowlist",
				chain: [{ method: "requests", args: [{ filter: "localhost" }] }],
			}),
		) as Array<{ failureText?: string }>;
		expect(blocked.some(request => request.failureText === "blocked by allowed_domains")).toBe(true);
	});
});
