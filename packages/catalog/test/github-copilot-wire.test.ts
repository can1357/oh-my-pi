import { describe, expect, it } from "bun:test";
import {
	getGitHubCopilotBaseUrl,
	normalizeGitHubCopilotApiEndpoint,
	normalizeGitHubCopilotEnterpriseDomain,
	parseGitHubCopilotApiKey,
} from "@oh-my-pi/pi-catalog/wire/github-copilot";

describe("GitHub Copilot OAuth helpers", () => {
	it("treats github.com as the public Copilot host", () => {
		expect(normalizeGitHubCopilotEnterpriseDomain("github.com")).toBeUndefined();
		expect(normalizeGitHubCopilotEnterpriseDomain("https://api.github.com")).toBeUndefined();
		expect(getGitHubCopilotBaseUrl("github.com")).toBe("https://api.githubcopilot.com");
	});

	it("maps enterprise domains to the Copilot enterprise host", () => {
		expect(normalizeGitHubCopilotEnterpriseDomain("https://ghe.example.com")).toBe("ghe.example.com");
		expect(getGitHubCopilotBaseUrl("ghe.example.com")).toBe("https://copilot-api.ghe.example.com");
		expect(getGitHubCopilotBaseUrl("copilot-api.ghe.example.com")).toBe("https://copilot-api.ghe.example.com");
	});

	it("normalizes Copilot API endpoints", () => {
		expect(normalizeGitHubCopilotApiEndpoint("https://api.business.githubcopilot.com/")).toBe(
			"https://api.business.githubcopilot.com",
		);
		expect(normalizeGitHubCopilotApiEndpoint("http://api.business.githubcopilot.com")).toBeUndefined();
	});

	it("parses structured Copilot api keys", () => {
		expect(
			parseGitHubCopilotApiKey(
				JSON.stringify({
					token: "ghu_test_token",
					enterpriseUrl: "https://ghe.example.com",
					apiEndpoint: "https://api.business.githubcopilot.com/",
				}),
			),
		).toEqual({
			accessToken: "ghu_test_token",
			enterpriseUrl: "ghe.example.com",
			apiEndpoint: "https://api.business.githubcopilot.com",
		});
	});
});
