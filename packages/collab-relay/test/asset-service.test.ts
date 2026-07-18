import { describe, expect, test } from "bun:test";
import { type ClientAssets, serveClientAsset } from "../src/asset-service";

const CSP = "default-src 'self'; script-src 'self' 'sha256-abc'";

function fakeAssets(files: Record<string, { body: string; type: string }>): ClientAssets {
	return {
		fetch(request: Request): Promise<Response> {
			const pathname = new URL(request.url).pathname;
			const file = files[pathname];
			if (!file) return Promise.resolve(new Response("not found", { status: 404 }));
			return Promise.resolve(new Response(file.body, { headers: { "Content-Type": file.type } }));
		},
	};
}

const clientFiles = {
	"/": { body: "<!doctype html><title>omp collab</title>", type: "text/html; charset=utf-8" },
	"/app.js": { body: "console.log(1)", type: "text/javascript" },
	"/csp.txt": { body: `${CSP}\n`, type: "text/plain" },
};

describe("serveClientAsset", () => {
	test("stamps CSP and security headers on HTML", async () => {
		const response = await serveClientAsset(new Request("https://relay.example/"), fakeAssets(clientFiles));
		expect(response.status).toBe(200);
		expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(response.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	test("leaves non-HTML assets untouched", async () => {
		const response = await serveClientAsset(new Request("https://relay.example/app.js"), fakeAssets(clientFiles));
		expect(response.headers.get("Content-Security-Policy")).toBeNull();
		expect(response.headers.get("X-Content-Type-Options")).toBeNull();
	});

	test("fails open without a csp.txt but keeps the other headers", async () => {
		const { "/csp.txt": _omitted, ...withoutCsp } = clientFiles;
		const response = await serveClientAsset(new Request("https://relay.example/"), fakeAssets(withoutCsp));
		expect(response.headers.get("Content-Security-Policy")).toBeNull();
		expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});

	test("rejects a csp.txt that is not a policy", async () => {
		const files = { ...clientFiles, "/csp.txt": { body: "<html>oops</html>", type: "text/plain" } };
		const response = await serveClientAsset(new Request("https://relay.example/"), fakeAssets(files));
		expect(response.headers.get("Content-Security-Policy")).toBeNull();
	});

	test("GET for an unknown path falls back to the SPA root with headers", async () => {
		const response = await serveClientAsset(new Request("https://relay.example/join/xyz"), fakeAssets(clientFiles));
		expect(response.status).toBe(200);
		expect(await response.text()).toContain("omp collab");
		expect(response.headers.get("Content-Security-Policy")).toBe(CSP);
	});

	test("non-GET misses pass through as 404", async () => {
		const response = await serveClientAsset(
			new Request("https://relay.example/join/xyz", { method: "POST" }),
			fakeAssets(clientFiles),
		);
		expect(response.status).toBe(404);
	});
});
