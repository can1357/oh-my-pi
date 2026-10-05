import { logger } from "@oh-my-pi/pi-utils";
import type { RawSettings, Settings } from "../config/settings";
import type { ApprovalMode } from "../tools/approval";
import { cfgMessagingDialogExpiry } from "./settings";

export type PermissionClass = "bypass" | "prompting";
export type InboundValue = "accept" | "hold" | "refuse";
export interface ResolvedInbound {
	value: InboundValue | null;
	invalid: boolean;
}
export type InboundDecision = "accept" | "hold-default" | "hold-explicit" | "refuse";

const STRICTNESS: Record<InboundValue, number> = { accept: 0, hold: 1, refuse: 2 };
let warned = false;

function rawInbound(layer: RawSettings): unknown {
	const messaging = layer.messaging;
	return messaging && typeof messaging === "object" && !Array.isArray(messaging)
		? (messaging as Record<string, unknown>).crossSessionInbound
		: undefined;
}

function inboundLayers(settings: Settings): unknown[] {
	return [
		rawInbound(settings.getLayerRaw("runtime")),
		rawInbound(settings.getLayerRaw("overlay")),
		rawInbound(settings.getGlobalSettings()),
		rawInbound(settings.getProjectSettings()),
	];
}

function isInbound(value: unknown): value is InboundValue {
	return value === "accept" || value === "hold" || value === "refuse";
}

function isInvalid(value: unknown): boolean {
	return value !== undefined && value !== "default" && !isInbound(value);
}

function warningFor(value: unknown): string {
	return `"messaging.crossSessionInbound" must be one of "accept", "hold", "refuse"; received "${String(value)}". This value was ignored; while it is present, cross-session messages are held for your approval instead of being delivered. Set it to one of the values above.`;
}

export function inboundWarning(settings: Settings): string | undefined {
	const layers = inboundLayers(settings);
	const invalidIndex = layers.findIndex(isInvalid);
	return invalidIndex === -1 ? undefined : warningFor(layers[invalidIndex]);
}

export function resolveInbound(settings: Settings): ResolvedInbound {
	const layers = inboundLayers(settings);
	const invalidIndex = layers.findIndex(isInvalid);
	if (invalidIndex !== -1) {
		if (!warned) {
			warned = true;
			logger.warn(warningFor(layers[invalidIndex]));
		}
		return { value: layers.includes("refuse") ? "refuse" : "hold", invalid: true };
	}
	let value: InboundValue | null = null;
	for (let i = 0; i < 3; i++) {
		const trusted = layers[i];
		if (isInbound(trusted)) {
			value = trusted;
			break;
		}
	}
	const project = layers[3];
	if (isInbound(project) && (value === null ? project !== "accept" : STRICTNESS[project] > STRICTNESS[value])) {
		value = project;
	}
	return { value, invalid: false };
}

export function decideInbound(input: {
	inbound: ResolvedInbound;
	receiver: PermissionClass;
	sender: PermissionClass | "unknown";
	ownChild: boolean;
}): InboundDecision {
	if (input.inbound.value === "refuse") return "refuse";
	if (input.inbound.invalid || input.inbound.value === "hold") return "hold-explicit";
	if (input.inbound.value === "accept" || input.ownChild) return "accept";
	return (input.receiver === "bypass") === (input.sender === "bypass") ? "accept" : "hold-default";
}

export function dialogExpiryMs(settings: Settings): number | null {
	switch (cfgMessagingDialogExpiry.get(settings)) {
		case "60s":
			return 60_000;
		case "5m":
			return 300_000;
		case "10m":
			return 600_000;
		case "never":
			return null;
	}
}

export function permissionClassFromApproval(
	mode: ApprovalMode,
	explicitAutoApproveForAcp: boolean | undefined,
): PermissionClass {
	return mode === "yolo" && explicitAutoApproveForAcp !== false ? "bypass" : "prompting";
}
