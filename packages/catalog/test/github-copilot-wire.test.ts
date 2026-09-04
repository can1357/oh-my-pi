import { describe, expect, it } from "bun:test";
import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	COPILOT_VSCODE_IDENTITY_HEADERS,
	getCopilotCapiIdentityHeaders,
	getGitHubCopilotBaseUrl,
	isCopilotVscodeMode,
	mergeCopilotApiHeaders,
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

describe("GitHub Copilot VS Code mode identity", () => {
	it("detects VS Code mode from explicit headers", () => {
		expect(isCopilotVscodeMode()).toBe(false);
		expect(isCopilotVscodeMode({ "Copilot-Mode": "vscode" })).toBe(true);
		expect(isCopilotVscodeMode({ "Copilot-Mode": "cli" })).toBe(false);
		expect(isCopilotVscodeMode({ "Copilot-Integration-Id": "vscode-chat" })).toBe(true);
		expect(isCopilotVscodeMode({ "Editor-Version": "vscode/1.136.0" })).toBe(true);
		expect(isCopilotVscodeMode({ "Copilot-Integration-Id": "copilot-developer-cli" })).toBe(false);
	});

	it("returns VS Code identity headers when in VS Code mode", () => {
		expect(getCopilotCapiIdentityHeaders({ "Copilot-Integration-Id": "vscode-chat" })).toEqual({
			...COPILOT_VSCODE_IDENTITY_HEADERS,
		});
		expect(getCopilotCapiIdentityHeaders({ "Copilot-Mode": "vscode" })).toEqual({
			...COPILOT_VSCODE_IDENTITY_HEADERS,
		});
		expect(getCopilotCapiIdentityHeaders()).toEqual({
			...COPILOT_CAPI_IDENTITY_HEADERS,
		});
		expect(getCopilotCapiIdentityHeaders({ "Copilot-Mode": "cli" })).toEqual({
			...COPILOT_CAPI_IDENTITY_HEADERS,
		});
	});

	it("merges headers preserving VS Code identity when enabled", () => {
		const merged = mergeCopilotApiHeaders({ "Copilot-Integration-Id": "vscode-chat", "Custom-Header": "foo" });
		expect(merged["Copilot-Integration-Id"]).toBe("vscode-chat");
		expect(merged["Editor-Version"]).toBe("vscode/1.136.0");
		expect(merged["Custom-Header"]).toBe("foo");
	});
});
