import { describe, expect, it } from "bun:test";
import { type RequestBody, transformRequestBody } from "@oh-my-pi/pi-ai/providers/openai-codex/request-transformer";
import { createCodexModel } from "./helpers";

describe("openai-codex include handling", () => {
	it("always includes reasoning.encrypted_content when caller include is custom", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), { include: ["foo"] });
		expect(transformed.include).toEqual(["foo", "reasoning.encrypted_content"]);
	});

	it("does not duplicate reasoning.encrypted_content", async () => {
		const body: RequestBody = {
			model: "gpt-5.1-codex",
		};

		const transformed = await transformRequestBody(body, createCodexModel(body.model), {
			include: ["foo", "reasoning.encrypted_content"],
		});
		expect(transformed.include).toEqual(["foo", "reasoning.encrypted_content"]);
	});
});
