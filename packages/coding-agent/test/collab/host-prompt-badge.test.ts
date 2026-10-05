// Issue #14082: a host-typed prompt carried no author at all, so a guest
// reading the transcript saw named guest turns interleaved with anonymous
// ones. `collabHostBadge` supplies the counterpart to the guest badge that
// `collab-prompt` entries already carry, and `UserMessageComponent` draws it.
import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { collabHostBadge } from "@oh-my-pi/pi-coding-agent/collab/display-name";
import { cfgCollabDisplayName } from "@oh-my-pi/pi-coding-agent/collab/settings";
import type { CollabGuestLink } from "@oh-my-pi/pi-coding-agent/collab/guest";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { UserMessageComponent } from "@oh-my-pi/pi-tui/chat/user-message";
import type { Participant } from "@oh-my-pi/pi-wire";

const HOST_NAME = "Bauke";

function makeContext(options: { displayName?: string; hosting?: boolean; participants?: Participant[] } = {}) {
	const settings = Settings.isolated();
	if (options.displayName !== undefined) cfgCollabDisplayName.set(settings, options.displayName);
	return {
		settings,
		collabController: { host: options.hosting === true ? {} : undefined },
		collabGuest:
			options.participants === undefined
				? undefined
				: ({ state: { participants: options.participants } } as unknown as CollabGuestLink),
	} as unknown as InteractiveModeContext;
}

function renderUser(text: string, authorBadge?: string): string {
	return Bun.stripANSI(new UserMessageComponent(text, { authorBadge }).render(80).join("\n"));
}

describe("collab host prompt badge", () => {
	it("names the host's own prompts while a room is active", () => {
		expect(collabHostBadge(makeContext({ displayName: HOST_NAME, hosting: true }))).toBe(`${HOST_NAME} · host`);
	});

	it("stays absent in a solo session, leaving prompts exactly as they render today", () => {
		expect(collabHostBadge(makeContext({ displayName: HOST_NAME }))).toBeUndefined();
	});

	it("resolves the same badge for a guest, from the replicated participant list", () => {
		const ctx = makeContext({
			participants: [
				{ name: HOST_NAME, role: "host" },
				{ name: "Guest", role: "guest" },
			],
		});
		expect(collabHostBadge(ctx)).toBe(`${HOST_NAME} · host`);
	});

	it("gives a guest that has not been welcomed yet no badge rather than a wrong one", () => {
		const ctx = {
			settings: Settings.isolated(),
			collabController: { host: undefined },
			collabGuest: { state: null },
		} as unknown as InteractiveModeContext;
		expect(collabHostBadge(ctx)).toBeUndefined();
	});
});

describe("user message author badge", () => {
	it("draws the host badge on the prompt bubble", () => {
		const rendered = renderUser("ship it", `${HOST_NAME} · host`);
		expect(rendered).toContain(`«${HOST_NAME} · host» ›`);
		expect(rendered).toContain("ship it");
	});

	it("draws no badge when the caller passes none", () => {
		expect(renderUser("ship it")).not.toContain("«");
	});

	it("keeps the badge alongside the live-steering marker and the reaction", () => {
		const component = new UserMessageComponent("ship it", {
			authorBadge: `${HOST_NAME} · host`,
			liveSteered: true,
		});
		component.setReaction("👍");
		const rendered = Bun.stripANSI(component.render(80).join("\n"));
		expect(rendered).toContain(`«${HOST_NAME} · host» ›`);
		expect(rendered).toContain("*");
		expect(rendered).toContain("👍");
	});
});
