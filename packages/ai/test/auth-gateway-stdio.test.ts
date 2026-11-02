import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createAuthGatewayRouter, serveAuthGatewayStdio } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";

/** Serves `lines` through `route`; the parsed output lines. */
async function serve(lines: string[], route: (req: Request) => Promise<Response>): Promise<unknown[]> {
	const output: unknown[] = [];
	await serveAuthGatewayStdio({
		input: new Response(`${lines.join("\n")}\n`).body!,
		write: line => output.push(JSON.parse(line)),
		route,
		version: "test",
	});
	return output;
}

afterEach(() => {
	clearCustomApis();
});

describe("auth-gateway stdio transport", () => {
	it("answers a chat request line through the gateway routes", async () => {
		registerMockApi();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-stdio-"));
		const storage = await AuthStorage.create(path.join(dir, "auth.db"));
		storage.keys.setRuntime("openrouter", "test-key");
		const mock = createMockModel({ provider: "openrouter", id: "mock/stdio-model" });
		const router = createAuthGatewayRouter({ storage, resolveModel: () => mock.model });
		try {
			mock.push({ content: ["hello"] });
			const request = {
				id: "a",
				path: "/v1/chat/completions",
				body: { model: "mock/stdio-model", messages: [{ role: "user", content: "hi" }] },
			};
			const output = await serve([JSON.stringify(request)], req => router.route(req, "test"));
			expect(output[0]).toEqual({ ready: true, version: "test" });
			expect(output[1]).toMatchObject({
				id: "a",
				status: 200,
				body: { object: "chat.completion", choices: [{ message: { role: "assistant", content: "hello" } }] },
			});
		} finally {
			router.close();
			storage.close();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("answers in completion order by id, rejects malformed lines and waits for requests in flight", async () => {
		const fastAnswered = Promise.withResolvers<void>();
		const route = async (req: Request): Promise<Response> => {
			const { pathname } = new URL(req.url);
			if (pathname === "/slow") {
				await fastAnswered.promise;
				return Response.json({ echoed: await req.json() });
			}
			queueMicrotask(() => fastAnswered.resolve());
			return new Response(new Uint8Array([0xff, 0x00, 0x7f]), { headers: { "content-type": "audio/mpeg" } });
		};
		const output = await serve(
			[
				JSON.stringify({ id: 1, path: "/slow", body: { n: 1 } }),
				"{not json",
				JSON.stringify({ id: 2, path: "relative" }),
				JSON.stringify({ id: 3, path: "/fast" }),
			],
			route,
		);
		expect(output.slice(1)).toEqual([
			{ id: null, status: 400, body: { error: expect.objectContaining({ type: "invalid_request_error" }) } },
			{ id: 2, status: 400, body: { error: expect.objectContaining({ type: "invalid_request_error" }) } },
			{ id: 3, status: 200, body: "/wB/", encoding: "base64" },
			{ id: 1, status: 200, body: { echoed: { n: 1 } } },
		]);
	});
});
