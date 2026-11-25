import { afterAll, expect, test } from "bun:test";
import { getJson } from "../src/client";
import { MAX_RETRIES } from "../src/config";

let hits = 0;
const server = Bun.serve({
	port: 0,
	fetch() {
		hits++;
		return hits < MAX_RETRIES ? new Response("busy", { status: 503 }) : Response.json({ ok: true });
	},
});
afterAll(() => server.stop(true));

test("retries 503s until the server answers", async () => {
	expect(await getJson(server.url.href)).toEqual({ ok: true });
	expect(hits).toBe(MAX_RETRIES);
});
