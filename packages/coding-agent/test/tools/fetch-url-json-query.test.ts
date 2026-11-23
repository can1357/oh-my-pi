import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { fetchReadUrl } from "@oh-my-pi/pi-coding-agent/tools/fetch";

let server: Bun.Server<undefined>;
let origin: string;
const queries: string[] = [];

beforeAll(() => {
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			queries.push(url.search);
			if (url.pathname === "/items.json") {
				return Response.json({
					items: [
						{ id: 1, name: "first" },
						{ id: 2, name: "second" },
					],
				});
			}
			if (url.pathname === "/search") {
				return new Response(
					`<html><body><main><h1>Results for ${url.searchParams.get("q")}</h1></main></body></html>`,
					{
						headers: { "content-type": "text/html" },
					},
				);
			}
			return new Response("Not found", { status: 404 });
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

const session: ToolSession = {
	cwd: process.cwd(),
	hasUI: false,
	settings: Settings.isolated({ "fetch.enabled": true }),
	getSessionFile: () => null,
	getSessionSpawns: () => null,
};

describe("?q= on an http(s) URL", () => {
	it("runs a jq filter over the JSON the URL returns instead of sending it to the server", async () => {
		queries.length = 0;
		const result = await fetchReadUrl(session, { path: `${origin}/items.json?q=.items[1].name` });
		expect(result.content.trim()).toBe('"second"');
		expect(queries).toEqual([""]);
	});

	it("sends a search term to the server as written", async () => {
		const result = await fetchReadUrl(session, { path: `${origin}/search?q=bun+test` });
		expect(result.content).toContain("Results for bun test");
	});
});
