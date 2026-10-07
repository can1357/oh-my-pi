import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { createBrowserPrelude, resolveBrowserKind } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { acquireBrowser } from "@oh-my-pi/pi-coding-agent/tools/browser/registry";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();

function session(): ToolSession {
	return {
		cwd: process.cwd(),
		hasUI: false,
		getSessionId: () => "ownership-host-task",
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.relay": true,
			"browser.cdpUrl": "http://127.0.0.1:9",
		}),
	};
}

describe("browser host ownership boundaries", () => {
	it("standing relay/CDP settings and env cannot select a user browser", () => {
		const host = session();
		expect(resolveBrowserKind({ action: "open" }, host, { PI_BROWSER_RELAY: "1" }).kind).toBe("headless");
		expect(
			resolveBrowserKind({ action: "open", headed: false }, host, {
				PI_BROWSER_RELAY: "1",
				TERN_PANE_SOCKET: "/tmp/tern.sock",
				TERN_PANE: "42",
				CMUX_SOCKET_PATH: "/tmp/cmux.sock",
			}),
		).toMatchObject({ kind: "headless", headless: true });
		expect(() =>
			resolveBrowserKind({ action: "open", app: { relay: true } }, host, { PI_BROWSER_RELAY: "0" }),
		).toThrow("Explicit browser relay requested");
	});

	it("explicit attachment without interactive selection fails before accessing an endpoint", async () => {
		const host = session();
		const prelude = createBrowserPrelude(host);
		for (const app of [{ relay: true }, { cdp_url: "http://127.0.0.1:9", target: "approved-looking title" }]) {
			await expect(prelude.invoke({ action: "open", app }, { session: host, toolCallId: "no-ui" })).rejects.toThrow(
				"interactive host-user tab selection",
			);
		}
		await expect(
			acquireBrowser({ kind: "connected", cdpUrl: "http://127.0.0.1:9" }, { cwd: host.cwd }),
		).rejects.toThrow("host-user-selected target ID");
	});

	it("fails before connection when an explicitly chosen endpoint is an older unscoped relay", async () => {
		let connectionAttempts = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname === "/json/version") {
					return Response.json({
						Browser: "Chrome/151",
						ompRelayVersion: "old-relay",
						webSocketDebuggerUrl: "ws://127.0.0.1:9/cdp",
					});
				}
				if (new URL(request.url).pathname === "/json") {
					return Response.json([{ id: "PAGEwork.7", type: "page", title: "Work", url: "https://work.test/" }]);
				}
				connectionAttempts++;
				return new Response("Must not attach", { status: 500 });
			},
		});
		try {
			const host = session();
			await expect(
				createBrowserPrelude(host).invoke(
					{
						action: "open",
						app: { cdp_url: `http://127.0.0.1:${server.port}` },
						url: "https://task.test/",
					},
					{
						session: host,
						toolCallId: "old-relay",
						context: {
							hasUI: true,
							ui: { select: async (_title: string, rows: string[]) => rows[0] } as never,
						} as never,
					},
				),
			).rejects.toThrow("Restart the relay under the fixed OMP runtime");
			expect(connectionAttempts).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it("cancelled host picker never connects or navigates a listed user tab", async () => {
		let discoveryCalls = 0;
		let unexpectedCalls = 0;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				if (new URL(request.url).pathname !== "/json") {
					unexpectedCalls++;
					return new Response("Must not connect", { status: 500 });
				}
				discoveryCalls++;
				return Response.json([
					{ id: "PAGEuser.7", type: "page", title: "Visible private tab", url: "https://private.test/" },
				]);
			},
		});
		try {
			const host = session();
			const prelude = createBrowserPrelude(host);
			await expect(
				prelude.invoke(
					{
						action: "open",
						url: "https://must-not-navigate.test/",
						app: { cdp_url: `http://127.0.0.1:${server.port}` },
					},
					{
						session: host,
						toolCallId: "cancel-picker",
						context: { hasUI: true, ui: { select: async () => undefined } as never } as never,
					},
				),
			).rejects.toThrow("attachment cancelled");
			expect(discoveryCalls).toBe(1);
			expect(unexpectedCalls).toBe(0);
		} finally {
			server.stop(true);
		}
	});

	it.skipIf(!CHROMIUM_AVAILABLE)(
		"managed Chromium still navigates independently of attachment defaults",
		async () => {
			const host = session();
			const prelude = createBrowserPrelude(host);
			const name = `owned-${crypto.randomUUID()}`;
			try {
				const result = await prelude.invoke(
					{ action: "open", name, headed: false, url: "data:text/html,<title>Agent owned</title>" },
					{
						session: host,
						toolCallId: "managed-navigation",
					},
				);
				expect(result.details).toMatchObject({ browser: "headless" });
				const title = await prelude.invoke(
					{ action: "run", name, code: "return await tab.title();" },
					{ session: host, toolCallId: "managed-title" },
				);
				expect(title.details).toMatchObject({ value: "Agent owned" });
			} finally {
				await prelude.invoke({ action: "close", name }, { session: host, toolCallId: "managed-close" });
			}
		},
		30_000,
	);
});
