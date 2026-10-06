import { afterEach, describe, expect, it, vi } from "bun:test";
import { type RawSettings, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InboundGate } from "../../src/messaging/inbound";
import type { SenderInfo } from "../../src/messaging/protocol";
import type { MessagingHost, RemoteDelivery } from "../../src/messaging/service";
import { AgentStorage } from "../../src/session/agent-storage";
import {
	decideInbound,
	dialogExpiryMs,
	inboundWarning,
	permissionClassFromApproval,
	resolveInbound,
	type InboundDecision,
	type InboundValue,
	type PermissionClass,
	type ResolvedInbound,
} from "@oh-my-pi/pi-coding-agent/messaging/policy";
import {
	cfgMessagingDialogExpiry,
	cfgMessagingInbound,
	cfgMessagingRateLimit,
	cfgMessagingRateWindowSeconds,
	cfgMessagingRelayMaxHops,
	cfgMessagingRelayMaxRevisits,
	cfgMessagingRepeatWindowSeconds,
} from "@oh-my-pi/pi-coding-agent/messaging/settings";
import type { ApprovalMode } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

// Exercise raw layers, not typed reads that mask malformed enum values.
function settingsWithLayers(runtime: unknown, overlay: unknown, global: unknown, project: unknown): Settings {
	const settings = Settings.isolated();
	vi.spyOn(settings, "getLayerRaw").mockImplementation(layer => ({
		messaging: { crossSessionInbound: layer === "runtime" ? runtime : overlay },
	}));
	vi.spyOn(settings, "getGlobalSettings").mockReturnValue({ messaging: { crossSessionInbound: global } });
	vi.spyOn(settings, "getProjectSettings").mockReturnValue({ messaging: { crossSessionInbound: project } });
	return settings;
}

afterEach(() => vi.restoreAllMocks());

describe("cross-session inbound policy", () => {
	it("project configuration only tightens trusted policy, and invalid values hold unless any layer refuses", () => {
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const values = [undefined, "accept", "hold", "refuse", "invalid"] as const;
		const expected: (InboundValue | null)[][] = [
			[null, null, "hold", "refuse", "hold"],
			["accept", "accept", "hold", "refuse", "hold"],
			["hold", "hold", "hold", "refuse", "hold"],
			["refuse", "refuse", "refuse", "refuse", "refuse"],
			["hold", "hold", "hold", "refuse", "hold"],
		];
		for (let trustedIndex = 0; trustedIndex < values.length; trustedIndex++) {
			for (let projectIndex = 0; projectIndex < values.length; projectIndex++) {
				const trusted = values[trustedIndex];
				const project = values[projectIndex];
				const settings = settingsWithLayers(undefined, undefined, trusted, project);
				expect(resolveInbound(settings)).toEqual({
					value: expected[trustedIndex][projectIndex],
					invalid: trusted === "invalid" || project === "invalid",
				});
			}
		}
		expect(warning).toHaveBeenCalledTimes(1);
		expect(warning).toHaveBeenCalledWith(
			'"messaging.crossSessionInbound" must be one of "accept", "hold", "refuse"; received "invalid". This value was ignored; while it is present, cross-session messages are held for your approval instead of being delivered. Set it to one of the values above.',
		);
	});

	it("runtime then CLI overlay then global wins, treating default as unset instead of masking lower trusted rules", () => {
		const cases: { layers: [unknown, unknown, unknown, unknown]; expected: ResolvedInbound }[] = [
			{ layers: ["accept", "hold", "refuse", undefined], expected: { value: "accept", invalid: false } },
			{ layers: ["default", "accept", "refuse", undefined], expected: { value: "accept", invalid: false } },
			{ layers: [undefined, "default", "hold", "accept"], expected: { value: "hold", invalid: false } },
			{ layers: ["default", "default", "default", "accept"], expected: { value: null, invalid: false } },
			{ layers: ["default", "default", "default", "default"], expected: { value: null, invalid: false } },
			{ layers: ["accept", "invalid", "hold", undefined], expected: { value: "hold", invalid: true } },
			{ layers: ["accept", "invalid", "refuse", undefined], expected: { value: "refuse", invalid: true } },
			{ layers: ["invalid", "refuse", "accept", undefined], expected: { value: "refuse", invalid: true } },
			{ layers: ["accept", "refuse", "invalid", undefined], expected: { value: "refuse", invalid: true } },
			{ layers: ["accept", "hold", "refuse", "invalid"], expected: { value: "refuse", invalid: true } },
		];
		for (const { layers, expected } of cases) {
			expect(resolveInbound(settingsWithLayers(...layers))).toEqual(expected);
		}
	});

	it("exposes the current invalid-value warning without making a typed fallback look safe", () => {
		for (const value of [null, false, 42, "", "ALLOW"]) {
			const settings = settingsWithLayers(undefined, undefined, "accept", value);
			expect(resolveInbound(settings)).toEqual({ value: "hold", invalid: true });
			expect(inboundWarning(settings)).toBe(
				`"messaging.crossSessionInbound" must be one of "accept", "hold", "refuse"; received "${String(value)}". This value was ignored; while it is present, cross-session messages are held for your approval instead of being delivered. Set it to one of the values above.`,
			);
		}
		expect(inboundWarning(settingsWithLayers(undefined, undefined, "accept", "default"))).toBeUndefined();
	});

	it("uses the complete CC permission-class matrix and never lets own-child bypass explicit policy", () => {
		const receivers: PermissionClass[] = ["bypass", "prompting"];
		const senders: (PermissionClass | "unknown")[] = ["bypass", "prompting", "unknown"];
		const defaults: InboundDecision[][] = [
			["accept", "hold-default", "hold-default"],
			["hold-default", "accept", "accept"],
		];
		const policies: { inbound: ResolvedInbound; expected?: InboundDecision }[] = [
			{ inbound: { value: null, invalid: false } },
			{ inbound: { value: "accept", invalid: false }, expected: "accept" },
			{ inbound: { value: "hold", invalid: false }, expected: "hold-explicit" },
			{ inbound: { value: "refuse", invalid: false }, expected: "refuse" },
			{ inbound: { value: null, invalid: true }, expected: "hold-explicit" },
			{ inbound: { value: "accept", invalid: true }, expected: "hold-explicit" },
			{ inbound: { value: "hold", invalid: true }, expected: "hold-explicit" },
			{ inbound: { value: "refuse", invalid: true }, expected: "refuse" },
		];
		for (const { inbound, expected } of policies) {
			for (const [receiverIndex, receiver] of receivers.entries()) {
				for (const [senderIndex, sender] of senders.entries()) {
					for (const ownChild of [false, true]) {
						expect(decideInbound({ inbound, receiver, sender, ownChild })).toBe(
							expected ?? (ownChild ? "accept" : defaults[receiverIndex][senderIndex]),
						);
					}
				}
			}
		}
	});

	it("maps each approval expiry to its deadline and never to no deadline", () => {
		const cases = [
			["60s", 60_000],
			["5m", 300_000],
			["10m", 600_000],
			["never", null],
		] as const;
		for (const [value, expected] of cases) {
			const settings = Settings.isolated();
			cfgMessagingDialogExpiry.override(settings, value);
			expect(dialogExpiryMs(settings)).toBe(expected);
		}
	});

	it("classifies ACP implicit auto-approval as prompting even in yolo mode", () => {
		const modes: ApprovalMode[] = ["yolo", "write", "always-ask"];
		for (const mode of modes) {
			for (const explicit of [undefined, false, true]) {
				expect(permissionClassFromApproval(mode, explicit)).toBe(
					mode === "yolo" && explicit !== false ? "bypass" : "prompting",
				);
			}
		}
	});

	it("rejects zero, negative, fractional, nonfinite, and nonnumeric rate and relay limits", () => {
		const settings = Settings.isolated();
		for (const setting of [
			cfgMessagingRateLimit,
			cfgMessagingRateWindowSeconds,
			cfgMessagingRepeatWindowSeconds,
			cfgMessagingRelayMaxHops,
			cfgMessagingRelayMaxRevisits,
		]) {
			for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
				expect(() => setting.override(settings, value)).toThrow("Messaging limits must be positive integers");
			}
			expect(() => setting.parse("one")).toThrow();
			setting.override(settings, 1);
		}
	});

	it("reads hidden raw overlay values and inherited runtime layers without exposing mutable configuration", async () => {
		const dir = TempDir.createSync("@messaging-policy-");
		try {
			const overlayPath = dir.join("overlay.yml");
			await Bun.write(overlayPath, "messaging:\n  crossSessionInbound: invalid\n");
			const settings = await Settings.loadReadOnly({
				cwd: dir.join("project"),
				agentDir: dir.join("agent"),
				configFiles: [overlayPath],
				overrides: { "messaging.crossSessionInbound": "accept" },
			});
			expect(cfgMessagingInbound.get(settings)).toBe("accept");
			expect(resolveInbound(settings)).toEqual({ value: "hold", invalid: true });
			const child = settings.overlay();
			expect(resolveInbound(child)).toEqual({ value: "hold", invalid: true });
			const raw: RawSettings = child.getLayerRaw("runtime");
			(raw.messaging as Record<string, unknown>).crossSessionInbound = "refuse";
			expect(resolveInbound(child)).toEqual({ value: "hold", invalid: true });
			cfgMessagingInbound.override(child, "refuse");
			expect(resolveInbound(child)).toEqual({ value: "refuse", invalid: true });
			expect(cfgMessagingInbound.get(settings)).toBe("accept");
		} finally {
			await dir.remove();
		}
	});

	it.each([false, true])("drains masked project hold edits through raw layers (overlay=%s)", async overlay => {
		const dir = TempDir.createSync("@messaging-layer-reload-");
		const projectFile = dir.join("project", ".omp", "config.yml");
		await Bun.write(projectFile, "messaging:\n  crossSessionInbound: hold\n");
		const parent = await Settings.loadIsolated({
			cwd: dir.join("project"),
			agentDir: dir.join("agent"),
			overrides: { "messaging.crossSessionInbound": "accept" },
		});
		const settings = overlay ? parent.overlay({ "messaging.crossSessionInbound": "accept" }) : parent;
		const deliveries: RemoteDelivery[] = [];
		const from: SenderInfo = {
			sessionId: "sender",
			shortId: "aaaaaaaa",
			entryId: "sender-entry",
			name: "sender",
			cwd: dir.path(),
			class: "bypass",
		};
		const host: MessagingHost = {
			sessionId: () => "receiver",
			cwd: () => dir.path(),
			directPrint: false,
			sessionName: () => "receiver",
			titleSource: () => "user",
			isBusy: () => false,
			isReceivingSuspended: () => false,
			isSessionTransitioning: () => false,
			permissionClass: () => "bypass",
			onPolicyInputsChange: cb => settings.onLayersChange(cb),
			deliverRemote: async batch => {
				deliveries.push(...batch);
				return true;
			},
			pendingRemoteCount: () => deliveries.length,
			showNotice: () => {},
			deliverNotice: async () => true,
			askApproval: undefined,
			currentRelayChain: () => [],
			lastFinished: () => undefined,
		};
		const gate = new InboundGate(
			host,
			settings,
			() => "bbbbbbbb",
			async () => {},
		);
		const unlisten = host.onPolicyInputsChange(() => gate.reapplyPolicy());
		const effective = vi.fn();
		const stopEffective = cfgMessagingInbound.listen(settings, effective);
		try {
			expect(cfgMessagingInbound.get(settings)).toBe("accept");
			expect(gate.receive({ type: "message", id: "held", from, body: "held body" }, from, false)).toEqual({
				ok: true,
				outcome: "held",
			});
			await Bun.write(projectFile, "messaging:\n  crossSessionInbound: accept\n");
			await parent.reloadFromDisk();
			expect(cfgMessagingInbound.get(settings)).toBe("accept");
			expect(effective).not.toHaveBeenCalled();
			expect(deliveries.map(item => item.body)).toEqual(["held body"]);
			await parent.reloadFromDisk();
			expect(deliveries).toHaveLength(1);
			await Bun.write(projectFile, "messaging:\n  crossSessionInbound: hold\n");
			await parent.reloadFromDisk();
			expect(gate.receive({ type: "message", id: "tightened", from, body: "new held body" }, from, false)).toEqual({
				ok: true,
				outcome: "held",
			});
			expect(deliveries).toHaveLength(1);
		} finally {
			unlisten();
			stopEffective();
			gate.close();
			parent.cancelPendingSaves();
			AgentStorage.close();
			await dir.remove();
		}
	});

	it("snapshot-dispatches raw-layer listeners and isolates their errors", () => {
		const settings = Settings.isolated();
		const warning = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const events: string[] = [];
		let stopSecond = () => {};
		settings.onLayersChange(() => {
			events.push("first");
			stopSecond();
			throw new Error("listener failed");
		});
		stopSecond = settings.onLayersChange(() => {
			events.push("second");
		});
		cfgMessagingInbound.override(settings, "hold");
		expect(events).toEqual(["first", "second"]);
		expect(warning).toHaveBeenCalled();
		cfgMessagingInbound.override(settings, "accept");
		expect(events).toEqual(["first", "second", "first"]);
	});
});
