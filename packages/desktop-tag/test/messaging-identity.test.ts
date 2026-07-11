import { describe, expect, test } from "bun:test";
import { createTargetIdentity, targetFingerprint } from "../src/messaging/identity";

describe("messaging target identity", () => {
	test("keeps presentation changes outside the stable fingerprint", async () => {
		// Given
		const first = await createTargetIdentity({
			provider: "slack",
			accountScopeId: "T123",
			conversationId: "C456",
			kind: "channel",
			displayName: "old-name",
			canonicalUrl: "https://app.slack.com/client/T123/C456",
			tab: { tabId: "tab-1", epoch: "epoch-4" },
			capturedAt: 10,
		});
		const renamed = { ...first, displayName: "new-name" };

		// When
		const fingerprint = await targetFingerprint(renamed);

		// Then
		expect(fingerprint).toBe(first.identityFingerprint);
	});

	test("separates identically named conversations in different accounts", async () => {
		// Given
		const base = {
			provider: "discord" as const,
			conversationId: "111",
			kind: "channel" as const,
			displayName: "general",
			tab: { tabId: "tab-1", epoch: "epoch-1" },
			capturedAt: 10,
		};

		// When
		const first = await createTargetIdentity({ ...base, accountScopeId: "guild-a" });
		const second = await createTargetIdentity({ ...base, accountScopeId: "guild-b" });

		// Then
		expect(first.identityFingerprint).not.toBe(second.identityFingerprint);
	});
});
