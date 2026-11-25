import { afterAll, expect, test } from "bun:test";
import { request } from "../src/http";

const server = Bun.serve({
	port: 0,
	async fetch() {
		await Bun.sleep(5_000);
		return new Response("late");
	},
});
afterAll(() => server.stop(true));

test("aborts requests that outlive the deadline", async () => {
	await expect(request(server.url.href, {}, 3_000)).rejects.toThrow();
}, 10_000);
