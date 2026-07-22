import { afterEach, describe, expect, it, vi } from "bun:test";
import worker from "./worker.js";

afterEach(() => {
	vi.restoreAllMocks();
});

function collabBinding(calls) {
	return {
		fetch(request) {
			calls.push(request.url);
			return Promise.resolve(new Response("collab client", { status: 200 }));
		},
	};
}

describe("oh-my-pk product host docs route", () => {
	it("serves the complete documentation home and links from the landing page", async () => {
		const docsResponse = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/docs"), {}, {});
		const docsHtml = await docsResponse.text();
		expect(docsResponse.status).toBe(200);
		expect(docsHtml).toContain("oh-my-pk docs");
		expect(docsHtml).toContain("Tool reference");
		expect(docsHtml).toContain('/docs/tools/search_tool_bm25');
		expect(docsHtml).toContain('/docs/collab');

		const landingResponse = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/"), {}, {});
		const landingHtml = await landingResponse.text();
		expect(landingResponse.status).toBe(200);
		expect(landingHtml).toContain('/docs">Documentation</a>');
	});

	it("serves the slash-suffixed docs route as the same documentation home", async () => {
		const response = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/docs/"), {}, {});
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("oh-my-pk docs");
	});
});

describe("oh-my-pk installer script proxy", () => {
	it("proxies install.sh from the canonical kingkillery/oh-my-pk raw source", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("#!/bin/sh\necho canonical\n"));

		const response = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/install.sh"), {}, {});
		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://raw.githubusercontent.com/kingkillery/oh-my-pk/main/scripts/install.sh",
		);
	});

	it("proxies install.ps1 from the canonical kingkillery/oh-my-pk raw source", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("# ps1\n"));

		const response = await worker.fetch(new Request("https://oh-my-pk.pkking.computer/install.ps1"), {}, {});
		expect(response.status).toBe(200);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://raw.githubusercontent.com/kingkillery/oh-my-pk/main/scripts/install.ps1",
		);
	});
});

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
