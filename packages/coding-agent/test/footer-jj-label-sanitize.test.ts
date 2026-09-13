/**
 * The footer renders the jj label verbatim inside the working-directory
 * segment, so repository-controlled control characters must be sanitized
 * at the cache boundary, mirroring the status-line jj label path.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { FooterComponent } from "@oh-my-pi/pi-coding-agent/modes/components/footer";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { VcsRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getProjectDir, setProjectDir } from "@oh-my-pi/pi-utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

afterEach(() => {
	vi.restoreAllMocks();
});

function makeSession() {
	return {
		state: { messages: [], model: undefined },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getContextUsage: () => undefined,
		getAsyncJobSnapshot: () => ({ running: [] }),
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "footer-sanitize test",
			getEntries: () => [],
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				premiumRequests: 0,
				cost: 0,
			}),
		},
	} as unknown as ConstructorParameters<typeof FooterComponent>[0];
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("FooterComponent jj label sanitization", () => {
	it("sanitizes control characters from the jj label", async () => {
		const root = "/repo/footer-sanitize";
		const jj = {
			kind: () => "jj",
			asGit: () => null,
			asJj: () => ({}) as never,
			root: () => root,
			watchTarget: () => `${root}/.jj/repo/op_heads/heads`,
			label: async () => `footer-${String.fromCharCode(7)}bookmark`,
		} as unknown as VcsRepo;
		vi.spyOn(vcs, "repoForDisplay").mockReturnValue(jj);
		vi.spyOn(vcs, "watch").mockImplementation((() => () => {}) as unknown as typeof vcs.watch);

		const component = new FooterComponent(makeSession());
		component.watchBranch(() => {});
		try {
			component.render(80);
			await flush();
			const content = component.render(80).join("\n");
			expect(content).toContain("(footer-");
			expect(content).toContain("bookmark)");
			expect(content).not.toContain(String.fromCharCode(7));
		} finally {
			component.dispose();
		}
	});
});
