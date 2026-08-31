import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { AssistantMessage, Usage } from "@oh-my-pi/pi-ai";
import type { DaemonSnapshot } from "../../../src/launch/protocol";
import { initTheme } from "../../../src/modes/theme/theme";
import { assistantUsageIsBilled, buildLaunchCompletionBlock } from "../../../src/modes/utils/transcript-render-helpers";
import type { CustomMessage } from "../../../src/session/messages";
import { TRUNCATE_LENGTHS } from "../../../src/tools/render-utils";

function usage(overrides: Partial<Usage> = {}): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		...overrides,
	};
}

function launchCompletionMessage(name: string): CustomMessage<{ daemons: DaemonSnapshot[] }> {
	return {
		role: "custom",
		customType: "launch-completion",
		content: "persisted model-facing launch completion",
		display: true,
		details: {
			daemons: [
				{
					name,
					id: "daemon-1",
					state: "exited",
					createdAt: 1,
					startedAt: 2,
					exitCode: 0,
					restartCount: 0,
					outputBytes: 0,
					persist: false,
					detached: false,
				},
			],
		},
		timestamp: 3,
	};
}

beforeAll(async () => {
	await initTheme(false);
});

describe("assistantUsageIsBilled", () => {
	it("suppresses the token badge only for turns that consumed nothing", () => {
		expect(assistantUsageIsBilled(usage())).toBe(false);
	});

	it("preserves cost transparency for empty replies whose prompt still cost input tokens", () => {
		expect(assistantUsageIsBilled(usage({ input: 321 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ output: 0, cacheRead: 512 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ cacheWrite: 128 }))).toBe(true);
		expect(assistantUsageIsBilled(usage({ premiumRequests: 1 }))).toBe(true);
	});

	// Documents the live/resume parity contract for #4532: both paths ask
	// `assistantUsageIsBilled` about `message.usage`, so an empty automated
	// reply that still cost input tokens renders identically on both surfaces.
	it("matches whether the assistant carrier renders visible content", () => {
		const emptyBilledMessage: Pick<AssistantMessage, "usage"> = { usage: usage({ input: 321 }) };
		const emptyFreeMessage: Pick<AssistantMessage, "usage"> = { usage: usage() };
		expect(assistantUsageIsBilled(emptyBilledMessage.usage)).toBe(true);
		expect(assistantUsageIsBilled(emptyFreeMessage.usage)).toBe(false);
	});
});

describe("buildLaunchCompletionBlock", () => {
	it("sanitizes and bounds daemon names without changing persisted details", () => {
		const rawName = `worker\talpha\r\n${os.homedir()}/secret/${"x".repeat(160)}`;
		const message = launchCompletionMessage(rawName);
		const persistedDetails = structuredClone(message.details);

		const rendered = Bun.stripANSI(buildLaunchCompletionBlock(message).render(240).join("\n"));
		const processLines = rendered.split("\n").filter(line => line.includes("Supervised process"));
		const processLine = processLines[0] ?? "";
		const displayedName = processLine.match(/completed (.+) \(exit 0\)/)?.[1] ?? "";

		expect(processLines).toHaveLength(1);
		expect(processLine).toMatch(/worker +alpha ~\/secret\//);
		expect(rendered).not.toContain("\t");
		expect(rendered).not.toContain("\r");
		expect(rendered).not.toContain(os.homedir());
		expect(displayedName).toContain("…");
		expect(Bun.stringWidth(displayedName)).toBeLessThanOrEqual(TRUNCATE_LENGTHS.TITLE);
		expect(message.details).toEqual(persistedDetails);
		expect(message.details?.daemons[0]?.name).toBe(rawName);
	});

	it("uses a safe fallback when sanitization leaves no daemon name", () => {
		const message = launchCompletionMessage("\u001b[31m\r\n\t\u001b[0m");
		const rendered = Bun.stripANSI(buildLaunchCompletionBlock(message).render(120).join("\n"));

		expect(rendered).toContain("Supervised process completed unnamed (exit 0)");
	});
});
