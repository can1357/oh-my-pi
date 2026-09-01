import type { Mock } from "bun:test";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { loginAlibabaCodingPlan } from "../src/registry/alibaba-coding-plan";
import * as apiKeyValidation from "../src/registry/api-key-validation";
import { getOAuthApiKey } from "../src/registry/oauth/index";
import type { OAuthController } from "../src/registry/oauth/types";

describe("alibaba-coding-plan endpoint selection", () => {
	let validateSpy: Mock<typeof apiKeyValidation.validateOpenAICompatibleApiKey>;
	let validateModelsSpy: Mock<typeof apiKeyValidation.validateApiKeyAgainstModelsEndpoint>;

	beforeEach(() => {
		validateSpy = spyOn(apiKeyValidation, "validateOpenAICompatibleApiKey").mockResolvedValue(undefined);
		validateModelsSpy = spyOn(apiKeyValidation, "validateApiKeyAgainstModelsEndpoint").mockResolvedValue(undefined);
	});

	afterEach(() => {
		validateSpy.mockRestore();
		validateModelsSpy.mockRestore();
	});

	it("option 1 uses international endpoint and auth URL", async () => {
		let capturedAuth: { url: string; instructions?: string } | undefined;
		const options: OAuthController = {
			onAuth: info => {
				capturedAuth = info;
			},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "1";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		const result = await loginAlibabaCodingPlan(options);

		expect(result.access).toBe("sk-test-key");
		expect(result.refresh).toBe("sk-test-key");
		expect(result.enterpriseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
		expect(capturedAuth?.url).toBe("https://modelstudio.console.alibabacloud.com/");
		expect(capturedAuth?.instructions).toContain("International");

		expect(validateSpy).toHaveBeenCalledWith({
			provider: "Alibaba Coding Plan",
			apiKey: "sk-test-key",
			baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
			model: "qwen3.5-plus",
			signal: undefined,
		});
	});

	it("option 2 uses China endpoint and auth URL", async () => {
		let capturedAuth: { url: string; instructions?: string } | undefined;
		const options: OAuthController = {
			onAuth: info => {
				capturedAuth = info;
			},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "2";
				if (prompt.message.includes("Paste your")) return "sk-cn-key";
				return "";
			},
		};

		const result = await loginAlibabaCodingPlan(options);

		expect(result.access).toBe("sk-cn-key");
		expect(result.refresh).toBe("sk-cn-key");
		expect(result.enterpriseUrl).toBe("https://coding.dashscope.aliyuncs.com/v1");
		expect(capturedAuth?.url).toBe("https://bailian.console.aliyun.com/?tab=model#/api-key");
		expect(capturedAuth?.instructions).toBe(
			"Copy your API key from the Alibaba Cloud Bailian console (China mainland)",
		);

		expect(validateSpy).toHaveBeenCalledWith({
			provider: "Alibaba Coding Plan",
			apiKey: "sk-cn-key",
			baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
			model: "qwen3.5-plus",
			signal: undefined,
		});
	});

	it("option 3 prompts for custom URL and uses it", async () => {
		validateSpy.mockRejectedValue(new Error("404 model_not_found"));
		let capturedAuth: { url: string; instructions?: string } | undefined;
		const options: OAuthController = {
			onAuth: info => {
				capturedAuth = info;
			},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "https://my-proxy.com/v1";
				if (prompt.message.includes("Paste your")) return "sk-custom-key";
				return "";
			},
		};

		const result = await loginAlibabaCodingPlan(options);

		expect(result.access).toBe("sk-custom-key");
		expect(result.refresh).toBe("sk-custom-key");
		expect(result.enterpriseUrl).toBe("https://my-proxy.com/v1");
		expect(capturedAuth?.url).toBe("https://modelstudio.console.alibabacloud.com/");

		expect(validateModelsSpy).toHaveBeenCalledWith({
			provider: "Alibaba Coding Plan",
			apiKey: "sk-custom-key",
			modelsUrl: "https://my-proxy.com/v1/models",
			signal: undefined,
		});
	});

	it("empty input defaults to international endpoint and auth URL", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		const result = await loginAlibabaCodingPlan(options);

		expect(result.enterpriseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
	});

	it("strips trailing slashes from custom URL", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "https://my-proxy.com/v1///";
				if (prompt.message.includes("Paste your")) return "sk-test-key";
				return "";
			},
		};

		const result = await loginAlibabaCodingPlan(options);

		expect(result.enterpriseUrl).toBe("https://my-proxy.com/v1");
	});

	it("throws error when custom URL is empty", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "3";
				if (prompt.message.includes("custom base URL")) return "";
				return "";
			},
		};

		await expect(loginAlibabaCodingPlan(options)).rejects.toThrow("Custom URL is required for option 3");
	});

	it("throws error when API key is empty", async () => {
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) return "1";
				if (prompt.message.includes("Paste your")) return "";
				return "";
			},
		};

		await expect(loginAlibabaCodingPlan(options)).rejects.toThrow("API key is required");
	});

	it("checks abort signal after endpoint selection", async () => {
		const controller = new AbortController();
		const options: OAuthController = {
			onAuth: () => {},
			onProgress: () => {},
			onPrompt: async prompt => {
				if (prompt.message.includes("Select Alibaba")) {
					controller.abort();
					return "";
				}
				return "";
			},
			signal: controller.signal,
		};

		await expect(loginAlibabaCodingPlan(options)).rejects.toThrow("Login cancelled");
	});
});

describe("alibaba-coding-plan JSON apiKey", () => {
	it("getOAuthApiKey returns JSON with token and enterpriseUrl", async () => {
		const credentials = {
			"alibaba-coding-plan": {
				access: "sk-test-key",
				refresh: "refresh-token",
				expires: Date.now() + 3600000,
				enterpriseUrl: "https://coding.dashscope.aliyuncs.com/v1",
			},
		};
		const result = await getOAuthApiKey("alibaba-coding-plan", credentials);
		expect(result).not.toBeNull();
		const parsed = JSON.parse(result!.apiKey);
		expect(parsed.token).toBe("sk-test-key");
		expect(parsed.enterpriseUrl).toBe("https://coding.dashscope.aliyuncs.com/v1");
	});

	it("JSON apiKey parsing extracts token for Bearer header", () => {
		const rawApiKey = JSON.stringify({
			token: "sk-bearer-token",
			enterpriseUrl: "https://custom.endpoint.com/v1",
		});
		const parsed = JSON.parse(rawApiKey);
		const apiKey = typeof parsed?.token === "string" ? parsed.token : rawApiKey;
		expect(apiKey).toBe("sk-bearer-token");
	});

	it("JSON apiKey parsing extracts enterpriseUrl for baseUrl", () => {
		const rawApiKey = JSON.stringify({
			token: "sk-test",
			enterpriseUrl: "https://china.dashscope.aliyuncs.com/v1",
		});
		const parsed = JSON.parse(rawApiKey);
		const baseUrl = typeof parsed?.enterpriseUrl === "string" ? parsed.enterpriseUrl : undefined;
		expect(baseUrl).toBe("https://china.dashscope.aliyuncs.com/v1");
	});

	it("non-JSON apiKey falls back to raw value", () => {
		const rawApiKey = "sk-plain-key";
		let apiKey = rawApiKey;
		try {
			const parsed = JSON.parse(rawApiKey);
			if (typeof parsed?.token === "string") {
				apiKey = parsed.token;
			}
		} catch {
			// Not JSON — use raw apiKey
		}
		expect(apiKey).toBe("sk-plain-key");
	});
});
