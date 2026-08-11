import type { ImageContent, TextContent } from "@pk-nerdsaver-ai/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/extensions";
import type { KeyId } from "@pk-nerdsaver-ai/pi-tui";
import { logger } from "@pk-nerdsaver-ai/pi-utils";

import { gatewayDaemonStatus, loadCaptureConfig, startGatewayDaemon, stopGatewayDaemon } from "./capture";
import { CaptureService } from "./context";
import { type CapabilityRegistry, createDefaultRegistry, routeContext, updateAvailability } from "./router";
import type { CaptureMode, CaptureRegion, ContextPacket } from "./types";

const MODES: CaptureMode[] = ["screen", "window", "region", "browser"];

const DEFAULT_REQUEST = "Describe what is on my screen.";

/** Default factory function loaded by the pi extension system. */
export default function desktopTagExtension(pi: ExtensionAPI): void {
	const captureService = new CaptureService();
	const registry = createDefaultRegistry();

	pi.setLabel("Desktop Tag");

	pi.registerCommand("tag", {
		description: "Capture desktop context and send it to the agent",
		async handler(args, ctx) {
			try {
				const { mode, request, region } = parseCommandArgs(args);
				await captureAndSend(pi, ctx, captureService, registry, mode, request, region);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error("desktop-tag command rejected", { error: message });
				if (ctx.hasUI) ctx.ui.notify(message, "error");
			}
		},
	});

	pi.registerCommand("telegram", {
		description: "Telegram capture gateway daemon: /telegram on|off|status",
		getArgumentCompletions(argumentPrefix) {
			const prefix = argumentPrefix.toLowerCase();
			const items = TELEGRAM_ACTIONS.filter(action => action.startsWith(prefix)).map(action => ({
				value: action,
				label: action,
			}));
			return items.length > 0 ? items : null;
		},
		async handler(args, ctx) {
			const notify = (message: string, type: "info" | "warning" | "error" = "info"): void => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
			};
			try {
				const action = parseTelegramCommandArgs(args);
				if (action === "status") {
					const status = gatewayDaemonStatus();
					notify(
						status.running ? `Telegram gateway: running (pid ${status.pid})` : "Telegram gateway: not running",
					);
					return;
				}
				if (action === "on") {
					const result = await startGatewayDaemon();
					if (result.started) {
						logger.info("telegram gateway started", { pid: result.pid, logFile: result.logFile });
						notify(`Telegram gateway started (pid ${result.pid})`);
						await warnIfTelegramUnconfigured(notify);
					} else if (result.alreadyRunning) {
						notify(`Telegram gateway already running (pid ${result.pid})`);
					} else {
						logger.error("telegram gateway failed to start", { reason: result.reason });
						notify(`Telegram gateway failed to start: ${result.reason}`, "error");
					}
					return;
				}
				const result = await stopGatewayDaemon();
				if (result.stopped) {
					notify(`Telegram gateway stopped (pid ${result.pid})`);
				} else if (!result.running) {
					notify("Telegram gateway is not running");
				} else {
					notify(`Telegram gateway did not stop: ${result.reason}`, "error");
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				logger.error("telegram command rejected", { error: message });
				notify(message, "error");
			}
		},
	});

	pi.registerShortcut("ctrl+alt+t" as KeyId, {
		description: "Capture the screen and tag the agent",
		async handler(ctx) {
			const request = ctx.hasUI ? await ctx.ui.input("What should pi do with this screen?") : "";
			await captureAndSend(pi, ctx, captureService, registry, "screen", request ?? "");
		},
	});
}

async function captureAndSend(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	captureService: CaptureService,
	registry: CapabilityRegistry,
	mode: CaptureMode,
	userRequest: string,
	region?: CaptureRegion,
): Promise<void> {
	try {
		if (ctx.hasUI) ctx.ui.setStatus("desktop-tag", "Capturing desktop context...");

		const packet = await captureService.capture({ mode, userRequest, region, includeClipboard: true });
		await updateAvailability(registry);
		const routing = routeContext(registry, packet);

		const content: (TextContent | ImageContent)[] = [
			{ type: "text", text: buildPromptText(packet, routing.message) },
		];

		if (packet.visual.screenshotPath) {
			const image = await loadImage(packet.visual.screenshotPath);
			content.push(image);
		}

		pi.sendUserMessage(content);
	} catch (error) {
		logger.error("desktop-tag extension failed", { error: error instanceof Error ? error.message : String(error) });
		if (ctx.hasUI) ctx.ui.notify("Failed to capture desktop context", "error");
	} finally {
		if (ctx.hasUI) ctx.ui.setStatus("desktop-tag", undefined);
	}
}

function buildPromptText(packet: ContextPacket, routingMessage: string): string {
	const lines = [
		`[desktop-tag] ${routingMessage}`,
		`Capture mode: ${packet.captureMode}`,
		`User request: ${packet.userRequest}`,
	];
	if (packet.foregroundApp.processName) {
		lines.push(
			`Foreground app: ${packet.foregroundApp.processName} — ${packet.foregroundApp.windowTitle ?? "unknown window"}`,
		);
	}
	if (packet.browser.url) {
		lines.push(`Browser tab: ${packet.browser.title ?? ""} (${packet.browser.url})`);
	}
	if (packet.selection.clipboardText) {
		lines.push(`Selection/clipboard: ${packet.selection.clipboardText}`);
	}
	return lines.join("\n");
}

async function loadImage(path: string): Promise<ImageContent> {
	const bytes = await Bun.file(path).bytes();
	return { type: "image", data: bytes.toBase64(), mimeType: "image/png", detail: "high" };
}

export interface ParsedTagCommand {
	mode: CaptureMode;
	request: string;
	region?: CaptureRegion;
}

const REGION_USAGE = "Usage: /tag region <x> <y> <width> <height> [request]";

export function parseCommandArgs(args: string): ParsedTagCommand {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	const firstMode = tokens[0] as CaptureMode | undefined;
	if (firstMode === "region") {
		if (tokens.length < 5) throw new TypeError(REGION_USAGE);
		const [x, y, width, height] = tokens.slice(1, 5).map(Number);
		if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) {
			throw new TypeError(`${REGION_USAGE}. Coordinates must be finite numbers.`);
		}
		if (width <= 0 || height <= 0) {
			throw new TypeError(`${REGION_USAGE}. Width and height must be positive.`);
		}
		return {
			mode: "region",
			region: { x, y, width, height },
			request: tokens.slice(5).join(" ") || DEFAULT_REQUEST,
		};
	}
	if (firstMode && MODES.includes(firstMode)) {
		return { mode: firstMode, request: tokens.slice(1).join(" ") || DEFAULT_REQUEST };
	}
	return { mode: "screen", request: args.trim() || DEFAULT_REQUEST };
}

const TELEGRAM_ACTIONS = ["on", "off", "status"] as const;

export type TelegramCommandAction = (typeof TELEGRAM_ACTIONS)[number];

const TELEGRAM_USAGE = "Usage: /telegram <on|off|status>";

export function parseTelegramCommandArgs(args: string): TelegramCommandAction {
	const token = args.trim().split(/\s+/).filter(Boolean)[0]?.toLowerCase();
	if (token === undefined || token === "status") return "status";
	if (token === "on" || token === "start") return "on";
	if (token === "off" || token === "stop") return "off";
	throw new TypeError(TELEGRAM_USAGE);
}

/**
 * Best-effort hint only: the gateway loads its own env (including the package
 * `.env` via its spawn cwd), so a missing config here must not block startup.
 */
export async function warnIfTelegramUnconfigured(
	notify: (message: string, type: "info" | "warning" | "error") => void,
): Promise<void> {
	try {
		const config = loadCaptureConfig();
		if (config.enabled && config.telegram.enabled && config.telegram.botToken) return;
	} catch {
		// fall through to the generic hint
	}
	notify(
		"No Telegram capture config visible (TELEGRAM_CAPTURE_ENABLED, TELEGRAM_BOT_TOKEN). The gateway is running, but the bridge stays inactive until you set env vars or packages/desktop-tag/.env — see docs/capture-to-agent.md.",
		"warning",
	);
}
