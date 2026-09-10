import { expect, it } from "bun:test";
import { AuthBrokerClient } from "../src/auth-broker/client";

for (const unknownField of [true, false]) {
	it(`credential blocks ${unknownField ? "retry legacy unknown-field responses" : "preserve unrelated validation errors"}`, async () => {
		const bodies: unknown[] = [];
		const fetchImpl: typeof fetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit) => {
				bodies.push(JSON.parse(String(init?.body)));
				if (bodies.length === 1)
					return Response.json(
						{ error: unknownField ? "retryAfter is an unrecognized key" : "invalid credential" },
						{ status: 400 },
					);
				return Response.json({ ok: true });
			},
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: "https://broker.example", token: "fixture", fetchImpl });
		const block = { providerKey: "fixture:oauth", blockScope: "chat", blockedUntilMs: 12345, retryAfter: true };
		const result = client.upsertCredentialBlock(1, block);
		if (unknownField) {
			await expect(result).resolves.toEqual({ ok: true });
			expect(bodies).toEqual([block, { providerKey: "fixture:oauth", blockScope: "chat", blockedUntilMs: 12345 }]);
		} else {
			await expect(result).rejects.toMatchObject({ status: 400 });
			expect(bodies).toEqual([block]);
		}
	});
}
