import { describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type DaemonConnectionSnapshot,
	formatDaemonServerStatus,
	formatDaemonWelcomeStatus,
} from "@oh-my-pi/pi-coding-agent/daemon/status";
import { WelcomeComponent } from "@oh-my-pi/pi-coding-agent/modes/components/welcome";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("daemon status presentation", () => {
	it("feeds the same snapshot into welcome rendering", async () => {
		await Settings.init({ inMemory: true });
		await initTheme(false);
		const welcome = new WelcomeComponent("1.0.0", "model", "provider");
		welcome.setServerStatus({
			state: "connected",
			shard: { profile: null },
			daemonId: "2947c11e-ea0e-4b5f-86aa-2d9852e94448",
			sessionId: "019f6362-7273-7ec0-afba-4c729add7c12",
			serverVersion: "0.51.0",
			protocolVersion: 1,
			sessionCount: 3,
		});
		const rendered = welcome
			.render(160)
			.map(line => Bun.stripANSI(line))
			.join("\n");
		expect(rendered).toContain("daemon 2947c11e");
		expect(rendered).toContain(" 019f6362 · none");
	});

	it("renders connected welcome rows from one snapshot", () => {
		const snapshot: DaemonConnectionSnapshot = {
			state: "connected",
			shard: { profile: null },
			daemonId: "2947c11e-ea0e-4b5f-86aa-2d9852e94448",
			sessionId: "019f6362-7273-7ec0-afba-4c729add7c12",
			serverVersion: "0.51.0",
			protocolVersion: 1,
			sessionCount: 3,
		};
		expect(formatDaemonWelcomeStatus(snapshot, 80)).toEqual(["● daemon 2947c11e · v0.51.0", "   019f6362 · none"]);
	});

	it("derives the scope label from the active profile", () => {
		const snapshot: DaemonConnectionSnapshot = {
			state: "connected",
			shard: { profile: "omega" },
			daemonId: "daemon-id",
			sessionId: "session-id",
			serverVersion: "0.51.0",
			protocolVersion: 1,
			sessionCount: 1,
		};
		expect(formatDaemonWelcomeStatus(snapshot, 80)[1]).toBe("   session- · omega");
	});

	it("keeps all lifecycle states fixed-height and sanitized", () => {
		const snapshot: DaemonConnectionSnapshot = {
			state: "incompatible",
			shard: { profile: "bad\nprofile" },
			clientVersion: "0.51.0\x1b[31m",
			serverVersion: "0.50.2",
		};
		const lines = formatDaemonWelcomeStatus(snapshot, 40);
		expect(lines).toHaveLength(2);
		expect(lines.join("\n")).not.toContain("\x1b[31m");
		expect(lines.join("\n")).not.toContain("\nprofile");
	});

	it("formats diagnostics without probing transport", () => {
		const snapshot: DaemonConnectionSnapshot = {
			state: "connected",
			shard: { profile: null },
			daemonId: "2947c11e-ea0e-4b5f-86aa-2d9852e94448",
			sessionId: "019f6362-7273-7ec0-afba-4c729add7c12",
			serverVersion: "1.2.3",
			protocolVersion: 1,
			sessionCount: 4,
			attachmentCount: 2,
			protectedJobCount: 1,
			uptimeMs: 61_000,
		};
		expect(formatDaemonServerStatus(snapshot)).toContain("server connected");
		expect(formatDaemonServerStatus(snapshot)).toContain("daemon id: 2947c11e-ea0e-4b5f-86aa-2d9852e94448");
		expect(formatDaemonServerStatus(snapshot)).toContain("session id: 019f6362-7273-7ec0-afba-4c729add7c12");
		expect(formatDaemonServerStatus(snapshot)).toContain("profile: none");
		expect(formatDaemonServerStatus(snapshot)).toContain("sessions: 4");
		expect(formatDaemonServerStatus(snapshot)).toContain("attachments: 2");
	});
});
