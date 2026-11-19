import { describe, expect, it } from "bun:test";
import { resolveDialect } from "@oh-my-pi/pi-coding-agent/sdk";

describe("resolveDialect", () => {
	it("uses preferred owned dialects in auto mode for models without native tools", () => {
		expect(resolveDialect("auto", { id: "MiniMax-M3", supportsTools: false })).toBe("minimax");
		expect(resolveDialect("auto", { id: "qwen3-coder-plus", supportsTools: false })).toBe("qwen3");
		expect(resolveDialect("auto", { id: "unclassified-model-id", supportsTools: false })).toBe("glm");
		expect(resolveDialect("auto", { supportsTools: false })).toBe("glm");
		expect(resolveDialect("auto", { supportsTools: true })).toBeUndefined();
		expect(resolveDialect("auto", {})).toBeUndefined();
		expect(resolveDialect("auto", undefined)).toBeUndefined();
	});

	it("keeps native unset and passes explicit in-band dialects through", () => {
		expect(resolveDialect("native", { supportsTools: false })).toBeUndefined();
		expect(resolveDialect("qwen3", undefined)).toBe("qwen3");
		expect(resolveDialect("minimax", undefined)).toBe("minimax");
	});
});
