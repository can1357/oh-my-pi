/**
 * omp's WebKit browser keeps a session cookie a plain-http site sets without
 * `Secure` or `SameSite`, and sends it back: a login answered with HTTP 299
 * and the session in such a cookie (as a Nokia ONT's web UI answers), then a
 * request only that session may make, which otherwise redirects to the login
 * page. Runs on the installed engine (or `PI_BROWSER_WEBKIT_PATH`'s).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import { resolveWebKitKind } from "@oh-my-pi/pi-coding-agent/tools/browser/webkit/kind";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";

const ENGINE_INSTALLED = resolveWebKitKind() !== null;
const SESSION = "c0ffee";

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		const { pathname } = new URL(request.url);
		if (pathname === "/login" && request.method === "POST") {
			return new Response(JSON.stringify({ result: 0, sid: SESSION }), {
				status: 299,
				headers: {
					"content-type": "text/html;charset=UTF-8;",
					"set-cookie": `sid=${SESSION}; path=/;HttpOnly;`,
					"x-sid": SESSION,
				},
			});
		}
		if (pathname === "/capabilities") {
			if (request.headers.get("cookie")?.split(/;\s*/).includes(`sid=${SESSION}`)) {
				return Response.json({ AdminUserData: 1 });
			}
			return new Response(null, { status: 302, headers: { location: "/" } });
		}
		return new Response("<!doctype html><title>login</title>", { headers: { "content-type": "text/html" } });
	},
});
const origin = `http://127.0.0.1:${server.port}`;

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	server.stop(true);
});

describe.skipIf(!ENGINE_INSTALLED)("omp's WebKit browser on a plain-http site", () => {
	test("sends the session cookie a login answer set back with the next request", async () => {
		const session: ToolSession = {
			cwd: process.cwd(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({
				"browser.enabled": true,
				"browser.webkit": true,
				"browser.relay": false,
				"browser.cmux": false,
				"browser.tern": false,
				"tools.maxTimeout": 0,
			}),
		};
		const prelude = createBrowserPrelude(session);
		const invoke = (parameters: unknown) =>
			prelude.invoke(parameters, { session, toolCallId: "browser-webkit-session-cookie" });

		await invoke({ action: "open", name: "plain-http-login", app: "webkit", url: `${origin}/` });
		const result = await invoke({
			action: "run",
			name: "plain-http-login",
			code: `return await tab.evaluate(async () => {
  const login = await fetch("/login", { method: "POST", body: "userhash=x" });
  const capabilities = await fetch("/capabilities");
  return { login: login.status, capabilities: capabilities.status, redirected: capabilities.redirected, body: await capabilities.text() };
});`,
		});

		expect((result.details as { value?: unknown } | undefined)?.value).toEqual({
			login: 299,
			capabilities: 200,
			redirected: false,
			body: JSON.stringify({ AdminUserData: 1 }),
		});
	});
});
