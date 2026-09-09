import { describe, expect, it } from "bun:test";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import {
	COPILOT_CAPI_IDENTITY_HEADERS,
	COPILOT_CHAT_IDENTITY_HEADERS,
	getCopilotCapiIdentityHeaders,
	getGitHubCopilotBaseUrl,
	clearCopilotCliDisabled,
	isCopilotCliDisabled,
	markCopilotCliDisabled,
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

describe("GitHub Copilot wire identity selection", () => {
	it("defaults to the original Copilot CLI identity when CLI is not disabled", () => {
		expect(getCopilotCapiIdentityHeaders()).toEqual({
			...COPILOT_CAPI_IDENTITY_HEADERS,
		});
		expect(getCopilotCapiIdentityHeaders()["Copilot-Integration-Id"]).toBe("copilot-developer-cli");
		expect(getCopilotCapiIdentityHeaders()["User-Agent"]).toBe("copilot/1.0.82");
	});

	it("uses chat identity when cliDisabled is true", () => {
		const chatHeaders = getCopilotCapiIdentityHeaders({ cliDisabled: true });
		expect(chatHeaders).toEqual({
			...COPILOT_CHAT_IDENTITY_HEADERS,
		});
		expect(chatHeaders["User-Agent"]).toBe(USER_AGENT);
		expect(chatHeaders["Openai-Intent"]).toBe("conversation-edits");
		expect(chatHeaders["Copilot-Integration-Id"]).toBeUndefined();
	});

	it("merges custom headers while applying appropriate identity", () => {
		const cliMerged = mergeCopilotApiHeaders({ "X-Custom": "val" });
		expect(cliMerged["X-Custom"]).toBe("val");
		expect(cliMerged["Copilot-Integration-Id"]).toBe("copilot-developer-cli");

		const chatMerged = mergeCopilotApiHeaders(
			{ "X-Custom": "val", "Copilot-Integration-Id": "copilot-developer-cli" },
			{ cliDisabled: true },
		);
		expect(chatMerged["X-Custom"]).toBe("val");
		expect(chatMerged["Copilot-Integration-Id"]).toBeUndefined();
		expect(chatMerged["User-Agent"]).toBe(USER_AGENT);
	});

	it("preserves X-Initiator and X-Interaction-Type when merging headers", () => {
		const cliMerged = mergeCopilotApiHeaders({
			"X-Initiator": "agent",
			"X-Interaction-Type": "conversation-agent",
		});
		expect(cliMerged["X-Initiator"]).toBe("agent");
		expect(cliMerged["X-Interaction-Type"]).toBe("conversation-agent");
		expect(cliMerged["Copilot-Integration-Id"]).toBe("copilot-developer-cli");

		const chatMerged = mergeCopilotApiHeaders(
			{
				"X-Initiator": "user",
				"X-Interaction-Type": "conversation-user",
			},
			{ cliDisabled: true },
		);
		expect(chatMerged["X-Initiator"]).toBe("user");
		expect(chatMerged["X-Interaction-Type"]).toBe("conversation-user");
		expect(chatMerged["Copilot-Integration-Id"]).toBeUndefined();
		expect(chatMerged["User-Agent"]).toBe(USER_AGENT);
	});

	it("tracks cli-disabled status per token", () => {
		const token = "ghu_sample_tracking_token";
		expect(isCopilotCliDisabled(token)).toBe(false);
		markCopilotCliDisabled(token);
		expect(isCopilotCliDisabled(token)).toBe(true);
		expect(parseGitHubCopilotApiKey(token).cliDisabled).toBe(true);
		clearCopilotCliDisabled(token);
		expect(isCopilotCliDisabled(token)).toBe(false);
	});
});
