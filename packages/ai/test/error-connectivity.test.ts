import { describe, expect, it } from "bun:test";
import * as net from "node:net";
import { isConnectivityError } from "@oh-my-pi/pi-ai/error";
import { formatMessage } from "@oh-my-pi/pi-ai/error/format";

describe("provider connectivity evidence", () => {
	it("recognizes a real connection refusal after a listening endpoint disappears", async () => {
		const server = net.createServer();
		await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Expected a TCP address");
		await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
		let failure: unknown;
		try {
			await fetch(`http://127.0.0.1:${address.port}`, { signal: AbortSignal.timeout(2_000) });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		expect(isConnectivityError(failure)).toBe(true);
	});

	it.each(["ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "UND_ERR_SOCKET"])(
		"keeps nested %s evidence when a provider error is serialized",
		async code => {
			const cause = Object.assign(new Error("connect failed"), { code });
			const error = new Error("Provider request could not be sent", { cause });
			expect(isConnectivityError(error)).toBe(true);
			const message = await formatMessage(error);
			expect(isConnectivityError({ message })).toBe(true);
		},
	);

	it.each([400, 401, 403, 408, 429, 500, 503, 524])("does not turn HTTP %s into an unbounded wait", code => {
		const cause = Object.assign(new Error("fetch failed"), { code: "ECONNRESET" });
		expect(isConnectivityError({ status: code, message: "Connection error", cause })).toBe(false);
		expect(isConnectivityError({ message: `${code} Connection error` })).toBe(false);
	});

	it.each(["Request timed out", "stream stall", "invalid API key", "quota exceeded", "certificate has expired"])(
		"does not treat %s as proof of a lost connection",
		message => expect(isConnectivityError(new Error(message))).toBe(false),
	);

	it("does not wait for a caller abort and terminates cyclic causes", () => {
		expect(isConnectivityError(new DOMException("fetch failed", "AbortError"))).toBe(false);
		const error = Object.assign(new Error("Connection error"), { cause: undefined as unknown });
		error.cause = error;
		expect(isConnectivityError(error)).toBe(true);
	});

	it("preserves a nested certificate rejection instead of misclassifying its fetch-failed wrapper", async () => {
		const cause = Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" });
		const error = new TypeError("fetch failed", { cause });
		expect(isConnectivityError(error)).toBe(false);
		const message = await formatMessage(error);
		expect(isConnectivityError({ message })).toBe(false);
	});

	it("does not turn a real invalid-URL failure into a connection wait after wrapping and flattening", async () => {
		let failure: unknown;
		try {
			await fetch("http://[");
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(Error);
		const wrapped = new TypeError("fetch failed", { cause: failure });
		expect(isConnectivityError(wrapped)).toBe(false);
		expect(isConnectivityError({ message: await formatMessage(wrapped) })).toBe(false);
	});
});
