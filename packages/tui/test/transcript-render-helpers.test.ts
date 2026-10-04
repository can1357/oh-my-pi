import { beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { Usage } from "@oh-my-pi/pi-ai";
import { assistantUsageIsBilled, buildIrcMessageCard } from "@oh-my-pi/pi-tui/chat/transcript-render-helpers";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import type { CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

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
});

describe("incoming peer card sender display", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("shows sanitized title and shortened workspace in both ANSI and native transcript cards", () => {
		const message: CustomMessage<{ from: string; message: string; senderDisplay: IrcMessage["senderDisplay"] }> = {
			role: "custom",
			customType: "irc:incoming",
			content: "model envelope is not the display body",
			display: true,
			timestamp: 1,
			details: {
				from: "work-1234abcd",
				message: "hello",
				senderDisplay: {
					title: "Plan\u001b]52;c;cGF5bG9hZA==\u0007\nreview",
					cwd: `${os.homedir()}/workspace\u001b[31m\nnext`,
				},
			},
		};
		const card = buildIrcMessageCard(message, () => false);
		const line = '"Plan review" · ~/workspace next';
		const output = Bun.stripANSI(card.render(120).join("\n"));
		expect(output).toContain("IRC ⟵ work-1234abcd");
		expect(output).toContain(line);
		expect(output).toContain("hello");
		expect(output).not.toContain("model envelope");
		expect(card.render(120).join("\n")).not.toContain("\u001b]52");
		const described = card.describe!({
			cols: 120,
			reduceMotion: false,
			dark: true,
			supports: () => true,
			feature: () => false,
		});
		expect(described?.c).toContainEqual({
			k: "text",
			p: { truncate: "end", spans: [{ t: line, s: "muted" }] },
			c: undefined,
			key: undefined,
		});
		expect(JSON.stringify(described)).not.toContain("52;c;");
		for (const row of card.render(40)) expect(Bun.stringWidth(row)).toBeLessThanOrEqual(40);
	});

	it("renders cwd without a title and keeps local cards free of peer metadata", () => {
		const message: CustomMessage<{ from: string; message: string; senderDisplay?: IrcMessage["senderDisplay"] }> = {
			role: "custom",
			customType: "irc:incoming",
			content: "",
			display: true,
			timestamp: 1,
			details: { from: "Worker", message: "hello", senderDisplay: { title: null, cwd: "/tmp/work" } },
		};
		const withDisplay = buildIrcMessageCard(message, () => false);
		expect(Bun.stripANSI(withDisplay.render(120).join("\n"))).toContain("/tmp/work");
		const withoutDisplay = buildIrcMessageCard(
			{ ...message, details: { from: "Worker", message: "hello" } },
			() => false,
		);
		expect(Bun.stripANSI(withoutDisplay.render(120).join("\n"))).not.toContain("/tmp/work");
		expect(
			JSON.stringify(
				withoutDisplay.describe!({
					cols: 120,
					reduceMotion: false,
					dark: true,
					supports: () => true,
					feature: () => false,
				}),
			),
		).not.toContain("/tmp/work");
	});
});
