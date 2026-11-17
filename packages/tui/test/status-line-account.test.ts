import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { visibleWidth } from "../src/index";
import { StatusLineComponent } from "../src/status-line/component";
import type { StatusAccountIdentity, StatusLineHost, StatusLineSession } from "../src/status-line/host";
import type { StatusLineSettings } from "../src/status-line/types";
import { initTheme } from "../src/theme";

const components: StatusLineComponent[] = [];
const NO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	orchestrationInput: 0,
	orchestrationOutput: 0,
	orchestrationCacheRead: 0,
	premiumRequests: 0,
	cost: 0,
};

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	for (const line of components.splice(0)) line.dispose();
});

type AccountStatusLineOptions = {
	identity?: StatusAccountIdentity;
	settings?: StatusLineSettings;
};

function accountStatusLine({ identity, settings = {} }: AccountStatusLineOptions = {}) {
	let activeIdentity = identity;
	const session: StatusLineSession = {
		state: { messages: [], model: getBundledModel("anthropic", "claude-sonnet-4-5") },
		messages: [],
		isStreaming: false,
		isAutoThinking: false,
		sessionManager: {
			getSessionName: () => undefined,
			getSessionId: () => "account-session",
			getUsageStatistics: () => NO_USAGE,
		},
		modelRegistry: { isUsingSubscription: () => true },
		getContextUsage: () => ({ tokens: 0, contextWindow: 200_000, percent: 0 }),
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		getAsyncJobSnapshot: () => null,
		getGoalModeState: () => undefined,
	};
	const host: StatusLineHost = {
		getSettings: () => settings,
		gitEnabled: () => false,
		codexResetFireworksEnabled: () => false,
		getSettingsRevision: () => 0,
		getSessionSettingsIdentity: () => undefined,
		getSessionSettingsRevision: () => 0,
		goalStatusInFooter: () => false,
		activeAccount: (current, provider) =>
			current === session && provider === "anthropic" ? activeIdentity : undefined,
		canFetchUsageReports: () => false,
		fetchUsageReports: async () => null,
		resolveActiveRepo: () => null,
		lookupPullRequest: async () => ({ stdout: "", exitCode: 1 }),
		calculateTokensPerSecond: () => null,
		limitMatchesActiveAccount: () => false,
		computeCompactionBoundaries: () => null,
	};
	const line = new StatusLineComponent(session, host);
	components.push(line);
	return {
		line,
		session,
		setIdentity(next: StatusAccountIdentity | undefined) {
			activeIdentity = next;
		},
	};
}

function accountText(line: StatusLineComponent): string | undefined {
	const children = line.describeComposerFacts().extras.c ?? [];
	for (const child of children) {
		if ("k" in child && child.k === "seg" && child.key === "account") {
			return child.p?.spans?.map(part => part.t).join("");
		}
	}
	return undefined;
}

const ACCOUNT_SETTINGS: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["model", "account"],
	rightSegments: [],
};

describe("active account status segment", () => {
	it("shows the pinned email and organization beside the model by default", () => {
		const { line } = accountStatusLine({ identity: { email: "work@example.com", orgId: "org-team" } });
		const text = Bun.stripANSI(line.getTopBorder(240).content);
		expect(text).toContain("Sonnet");
		expect(text).toContain("work@example.com (org-team)");
		expect(accountText(line)).toBe("work@example.com (org-team)");
	});

	it("prefers the organization name and refreshes it when renamed", () => {
		const identity = { email: "work@example.com", orgId: "org-team", orgName: "Work Team" };
		const { line } = accountStatusLine({ identity, settings: ACCOUNT_SETTINGS });
		expect(Bun.stripANSI(line.getTopBorder(240).content)).toContain("work@example.com (Work Team)");
		expect(accountText(line)).toBe("work@example.com (Work Team)");
		identity.orgName = "Renamed Team";
		expect(Bun.stripANSI(line.getTopBorder(240).content)).toContain("work@example.com (Renamed Team)");
		expect(accountText(line)).toBe("work@example.com (Renamed Team)");
	});

	it("refreshes both cached surfaces when only the organization changes", () => {
		const identity = { email: "same@example.com", orgId: "org-personal" };
		const { line } = accountStatusLine({ identity, settings: ACCOUNT_SETTINGS });
		expect(Bun.stripANSI(line.getTopBorder(240).content)).toContain("same@example.com (org-personal)");
		expect(accountText(line)).toBe("same@example.com (org-personal)");

		identity.orgId = "org-team";
		expect(Bun.stripANSI(line.getTopBorder(240).content)).toContain("same@example.com (org-team)");
		expect(accountText(line)).toBe("same@example.com (org-team)");
	});

	it("tracks account rotation and clears the identity after logout", () => {
		const { line, setIdentity } = accountStatusLine({ settings: ACCOUNT_SETTINGS });
		expect(accountText(line)).toBeUndefined();
		line.getTopBorder(240);

		setIdentity({ email: "first@example.com" });
		expect(Bun.stripANSI(line.getTopBorder(240).content)).toContain("first@example.com");
		expect(accountText(line)).toBe("first@example.com");

		setIdentity({ email: "second@example.com" });
		expect(Bun.stripANSI(line.getTopBorder(240).content)).not.toContain("first@example.com");
		expect(accountText(line)).toBe("second@example.com");

		setIdentity(undefined);
		expect(Bun.stripANSI(line.getTopBorder(240).content)).not.toContain("second@example.com");
		expect(accountText(line)).toBeUndefined();
	});

	it("does not show another provider's logged-in account", () => {
		const { line, session } = accountStatusLine({
			identity: { email: "claude@example.com" },
			settings: ACCOUNT_SETTINGS,
		});
		expect(accountText(line)).toBe("claude@example.com");
		session.state.model = getBundledModel("openai", "gpt-4o");
		expect(Bun.stripANSI(line.getTopBorder(240).content)).not.toContain("claude@example.com");
		expect(accountText(line)).toBeUndefined();
	});

	it.each([
		[{ accountId: "account-123" }, "account-123"],
		[{ projectId: "project-123" }, "project-123"],
		[{ email: "person@example.com", accountId: "account-123" }, "person@example.com"],
	] satisfies [StatusAccountIdentity, string][])(
		"uses nonsecret identifiers when email is absent: %j",
		(identity, label) => {
			const { line } = accountStatusLine({ identity, settings: ACCOUNT_SETTINGS });
			expect(Bun.stripANSI(line.getTopBorder(240).content)).toContain(label);
			expect(accountText(line)).toBe(label);
		},
	);

	it("sanitizes identity fields without serializing credential-shaped extras", () => {
		const identity = {
			email: "\u001b[31mwork@example.com\u001b[0m\n",
			orgId: "org\tteam\r",
			accessToken: "SECRET_ACCESS_TOKEN",
			refreshToken: "SECRET_REFRESH_TOKEN",
		};
		const { line } = accountStatusLine({ identity, settings: ACCOUNT_SETTINGS });
		const label = accountText(line);
		expect(label).toContain("work@example.com");
		expect(label).toContain("org team");
		expect(label).not.toMatch(/[\u0000-\u001f\u007f]/);
		expect(JSON.stringify(line.describeComposerFacts())).not.toContain("SECRET_");
		expect(Bun.stripANSI(line.getTopBorder(240).content)).not.toContain("SECRET_");
	});

	it("keeps a long account within narrow terminal bounds", () => {
		const { line } = accountStatusLine({
			identity: { email: "long-account-address@example.com", orgId: "organization-team" },
			settings: ACCOUNT_SETTINGS,
		});
		for (const width of [20, 40, 80]) {
			expect(visibleWidth(line.getTopBorder(width).content)).toBeLessThanOrEqual(width);
		}
	});
});
