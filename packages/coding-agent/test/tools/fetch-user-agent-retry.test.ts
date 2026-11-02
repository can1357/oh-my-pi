import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { loadPage } from "@oh-my-pi/pi-coding-agent/web/scrapers/types";

function makeSession(): ToolSession {
	const cwd = process.cwd();
	const artifactsDir = path.join(cwd, ".fetch-user-agent-retry-artifacts");
	return {
		cwd,
		hasUI: false,
		getSessionFile: () => path.join(cwd, "session.jsonl"),
		getArtifactsDir: () => artifactsDir,
		getSessionSpawns: () => null,
		allocateOutputArtifact: async toolType => ({ id: "test", path: path.join(artifactsDir, `test.${toolType}.log`) }),
		settings: Settings.isolated({ "fetch.enabled": true }),
	};
}

const ARTICLE = `<html><head><title>Filing</title></head><body><main><h1>Quarterly report</h1>
<p>${"Revenue grew in the quarter while operating costs held steady across every segment. ".repeat(4)}</p>
</main></body></html>`;

describe("read URL refused for one user agent", () => {
	const servers: Bun.Server<undefined>[] = [];
	afterEach(() => {
		for (const server of servers) server.stop(true);
		servers.length = 0;
	});

	function serveRefusingCurl(refusal: () => Response): Bun.Server<undefined> {
		const server = Bun.serve({
			port: 0,
			fetch: request =>
				request.headers.get("user-agent")?.startsWith("curl/")
					? refusal()
					: new Response(ARTICLE, { headers: { "content-type": "text/html" } }),
		});
		servers.push(server);
		return server;
	}

	async function readText(server: Bun.Server<undefined>) {
		const result = await new ReadTool(makeSession()).execute("call", {
			path: `http://127.0.0.1:${server.port}/filing.htm`,
		});
		return { method: result.details?.method, text: result.content.find(block => block.type === "text")?.text };
	}

	it("reads the page from the next user agent when a bare 403 page names no bot check", async () => {
		const server = serveRefusingCurl(
			() =>
				new Response("<html><head><title>403 Forbidden</title></head><body><h1>403 Forbidden</h1></body></html>", {
					status: 403,
					headers: { "content-type": "text/html" },
				}),
		);

		const { method, text } = await readText(server);

		expect(method).not.toBe("failed");
		expect(text).toContain("Revenue grew in the quarter");
	});

	it("reads the page from the next user agent before waiting out a 429's Retry-After", async () => {
		const server = serveRefusingCurl(
			() => new Response("Too Many Requests", { status: 429, headers: { "retry-after": "10" } }),
		);

		const started = performance.now();
		const { method, text } = await readText(server);

		expect(method).not.toBe("failed");
		expect(text).toContain("Revenue grew in the quarter");
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	it("sends a caller's own User-Agent once instead of repeating a refused request, whatever its spelling", async () => {
		const agents: (string | null)[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				agents.push(request.headers.get("user-agent"));
				return new Response("Access denied by bot detection", { status: 403 });
			},
		});
		servers.push(server);

		for (const name of ["User-Agent", "user-agent"]) {
			const result = await loadPage(`http://127.0.0.1:${server.port}/api`, { headers: { [name]: "omp/test" } });
			expect(result.ok).toBe(false);
			expect(result.status).toBe(403);
		}

		expect(agents).toEqual(["omp/test", "omp/test"]);
	});

	it("still retries a caller's own User-Agent after a transport error", async () => {
		const agents: (string | null)[] = [];
		const server = Bun.serve({
			port: 0,
			fetch: request => {
				agents.push(request.headers.get("user-agent"));
				// The first request never answers, so loadPage's own timeout ends it.
				if (agents.length === 1) return Promise.withResolvers<Response>().promise;
				return new Response("recovered", { headers: { "content-type": "text/plain" } });
			},
		});
		servers.push(server);

		const result = await loadPage(`http://127.0.0.1:${server.port}/api`, {
			headers: { "User-Agent": "omp/test" },
			timeout: 0.2,
		});

		expect(result.ok).toBe(true);
		expect(result.content).toBe("recovered");
		expect(agents).toEqual(["omp/test", "omp/test"]);
	});
});
