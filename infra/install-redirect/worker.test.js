import { describe, expect, it } from "bun:test";
import worker from "./worker.js";

function collabBinding(calls) {
	return {
		fetch(request) {
			calls.push(request.url);
			return Promise.resolve(new Response("collab client", { status: 200 }));
		},
	};
}

describe("oh-my-pk product host collab route", () => {
	it("proxies the collab app root and assets through the collab Worker binding", async () => {
		const calls = [];
		const env = { COLLAB: collabBinding(calls) };

		const rootResponse = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/collab/"), env, {});
		const assetResponse = await worker.fetch(
			new Request("https://oh-my-pk.pkking.computer/collab/client.js?v=1"),
			env,
			{},
		);

		expect(await rootResponse.text()).toBe("collab client");
		expect(await assetResponse.text()).toBe("collab client");
		expect(calls).toEqual([
			"https://oh-my-pk.pkking.computer/",
			"https://oh-my-pk.pkking.computer/client.js?v=1",
		]);
	});

	it("redirects the slashless collab path so relative client assets stay under /collab/", async () => {
		const response = await worker.fetch(
			new Request("https://oh-my-pk.pkking.computer/collab?source=cli"),
			{ COLLAB: collabBinding([]) },
			{},
		);

		expect(response.status).toBe(308);
		expect(response.headers.get("Location")).toBe("https://oh-my-pk.pkking.computer/collab/?source=cli");
	});

	it("returns a service error when the collab Worker binding is unavailable", async () => {
		const response = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/collab/"), {}, {});

		expect(response.status).toBe(503);
		expect(await response.text()).toBe("Collab client unavailable");
	});
});
