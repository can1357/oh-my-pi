#!/usr/bin/env bun
import { logger } from "@pk-nerdsaver-ai/pi-utils";

import {
	CaptureHttpRouter,
	CaptureOrchestrator,
	CaptureStore,
	createTelegramTransport,
	loadCaptureConfig,
	PiRunnerAdapter,
	TelegramBridge,
} from "./capture";
import { CaptureService } from "./context";
import { TagGatewayServer } from "./gateway";

const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

function main(): void {
	const args = process.argv.slice(2);
	const portArg = args.find(a => a.startsWith("--port="))?.split("=")[1];
	const hostArg = args.find(a => a.startsWith("--host="))?.split("=")[1];
	const port = portArg ? Number.parseInt(portArg, 10) : Number(Bun.env.OMP_DESKTOP_TAG_PORT ?? 18087);
	const hostname = hostArg ?? (Bun.env.OMP_DESKTOP_TAG_HOST || "127.0.0.1");

	const captureConfig = loadCaptureConfig();
	const captureService = new CaptureService();

	let captureRouter: CaptureHttpRouter | undefined;
	let stopTelegramPoll: (() => void) | undefined;
	let retentionTimer: ReturnType<typeof setInterval> | undefined;
	let store: CaptureStore | undefined;

	if (captureConfig.enabled) {
		store = new CaptureStore({ dataDir: captureConfig.dataDir });
		const runner = new PiRunnerAdapter({ autoApprove: captureConfig.autoApprove });
		const orchestrator = new CaptureOrchestrator({
			store,
			runner,
			captureService,
			maxScreenshotBytes: captureConfig.maxUploadBytes,
			defaultRunnerId: captureConfig.defaultRunnerId,
			defaultAgentRole: captureConfig.defaultAgentRole,
		});

		let telegram: TelegramBridge | undefined;
		if (captureConfig.telegram.enabled && captureConfig.telegram.botToken) {
			if (captureConfig.telegram.allowedChatIds.size === 0) {
				logger.warn("TELEGRAM_ALLOWED_CHAT_IDS is empty: all inbound Telegram messages will be rejected");
			}
			telegram = new TelegramBridge({
				config: captureConfig.telegram,
				store,
				transport: createTelegramTransport(captureConfig.telegram.botToken),
			});
			telegram.bindOrchestrator(orchestrator);
			orchestrator.registerCollaborationAdapter(telegram);
			if (captureConfig.telegram.longPollEnabled) {
				stopTelegramPoll = telegram.startLongPoll();
				logger.info("Telegram capture bridge polling for updates");
			}
		}

		captureRouter = new CaptureHttpRouter({
			orchestrator,
			telegram,
			gatewayToken: captureConfig.gatewayToken,
			maxBodyBytes: Math.floor(captureConfig.maxUploadBytes * 1.5) + 64 * 1024,
		});

		void orchestrator.runRetentionSweep(captureConfig.assetRetentionDays);
		retentionTimer = setInterval(
			() => void orchestrator.runRetentionSweep(captureConfig.assetRetentionDays),
			RETENTION_SWEEP_INTERVAL_MS,
		);
	}

	const server = new TagGatewayServer({ port, hostname, captureService, captureRouter });
	server.start();

	logger.info("ompk-tag running", { url: server.url, captureEnabled: captureConfig.enabled });
	console.log(`ompk-tag listening at ${server.url}`);
	if (captureConfig.enabled) {
		console.log(`capture API at ${server.url}/api/capture/tasks (shortcut hint: ${captureConfig.globalShortcut})`);
	}

	let stopping = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		logger.info("Shutting down ompk-tag", { signal });
		if (retentionTimer) clearInterval(retentionTimer);
		stopTelegramPoll?.();
		await server.stop();
		store?.close();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
