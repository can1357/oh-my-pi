import { describe, expect, it } from "bun:test";

describe("Buffer.toBase64", async () => {
	await import("@oh-my-pi/pi-coding-agent/utils/image-resize");

	it("should return a base64 string", () => {
		const buffer = Buffer.from("Hello, world!");
		expect(buffer.toBase64()).toBe("SGVsbG8sIHdvcmxkIQ==");
	});
});
