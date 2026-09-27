import { afterEach, describe, expect, it, vi } from "bun:test";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tiny client judge guard", () => {
	it("chat() returns null for judge keys without touching a worker", async () => {
		await expect(tinyModelClient.chat("julia-1", [{ role: "user", content: "hi" }], {})).resolves.toBeNull();
	});

	it("generate() returns null for judge keys without touching a worker", async () => {
		await expect(tinyModelClient.generate("julia-1", "hi")).resolves.toBeNull();
	});

	it("judge() still returns null for non-judge keys", async () => {
		await expect(
			tinyModelClient.judge("lfm2.5-230m", "s", {
				q: { type: "noul", instructions: "i", options: ["no", "yes"] as [string, string] },
			}),
		).resolves.toBeNull();
	});
});
