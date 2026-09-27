import { beforeAll, describe, expect, it } from "bun:test";
import { TELEGRAM_PROMPT_MESSAGE_TYPE, type CustomMessage } from "@oh-my-pi/pi-tui/chat/messages";
import { RemotePromptMessageComponent } from "@oh-my-pi/pi-tui/chat/remote-prompt-message";
import { initTheme } from "@oh-my-pi/pi-tui/theme";

function promptMessage(
	customType: string,
	details: { from: string },
	content = "deploy the release",
): CustomMessage<{ from: string }> {
	return {
		role: "custom",
		customType,
		content,
		display: true,
		details,
		attribution: "user",
		timestamp: 1,
	};
}

describe("RemotePromptMessageComponent", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("attributes a telegram prompt to its sender over the bridged channel", () => {
		const rendered = new RemotePromptMessageComponent(
			promptMessage(TELEGRAM_PROMPT_MESSAGE_TYPE, { from: "Alice" }),
			{ fallbackFrom: "telegram", via: "via Telegram" },
		)
			.render(120)
			.join("\n");

		expect(rendered).toContain("Alice");
		expect(rendered).toContain("via Telegram");
		expect(rendered).toContain("deploy the release");
	});

	it("renders a collab prompt without a channel attribution", () => {
		const rendered = new RemotePromptMessageComponent(promptMessage("collab-prompt", { from: "guest" }))
			.render(120)
			.join("\n");

		expect(rendered).toContain("guest");
		expect(rendered).not.toContain("via Telegram");
	});

	it("falls back to the channel name when the sender has no display name", () => {
		const rendered = new RemotePromptMessageComponent(promptMessage(TELEGRAM_PROMPT_MESSAGE_TYPE, { from: "  " }), {
			fallbackFrom: "telegram",
			via: "via Telegram",
		})
			.render(120)
			.join("\n");

		expect(rendered).toContain("telegram");
	});

	it("strips terminal control sequences and newlines from the sender name", () => {
		// A Telegram profile name is remote input: it must not retitle the terminal or add rows.
		const rendered = new RemotePromptMessageComponent(
			promptMessage(TELEGRAM_PROMPT_MESSAGE_TYPE, { from: "Eve\x1b]0;pwned\x07\nroot" }),
			{ fallbackFrom: "telegram", via: "via Telegram" },
		)
			.render(120)
			.join("\n");

		expect(rendered).not.toContain("\x07");
		expect(rendered).not.toContain("pwned");
		expect(rendered).toContain("Eve root");
	});
});
