#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@pk-nerdsaver-ai/pi-utils";

import {
	acquireGatewayLock,
	CaptureHttpRouter,
	CaptureOrchestrator,
	CaptureStore,
	createIdleExitSupervisor,
	createTelegramTransport,
	GATEWAY_PACKAGE_ROOT,
	isTerminalRunStatus,
	loadCaptureConfig,
	PiRunnerAdapter,
	parseIdleExitTimeoutMs,
	releaseGatewayPidLock,
	resolveGatewayDaemonPaths,
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

	let envIdleExit = Bun.env.CAPTURE_IDLE_EXIT_MS ?? Bun.env.GATEWAY_DEFAULT_IDLE_EXIT_MS;
	try {
		const dotEnvPath = path.join(GATEWAY_PACKAGE_ROOT, ".env");
		if (fs.existsSync(dotEnvPath)) {
			const content = fs.readFileSync(dotEnvPath, "utf8");
			for (const line of content.split(/\r?\n/)) {
				const trimmed = line.trim();
				if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;
				const [key, ...valParts] = trimmed.split("=");
				if (key.trim() === "CAPTURE_IDLE_EXIT_MS") {
					envIdleExit = valParts.join("=").trim();
					break;
				}
			}
		}
	} catch {
		// fall through
	}
	const idleExitTimeoutMs = parseIdleExitTimeoutMs(envIdleExit);

	const daemonPaths = resolveGatewayDaemonPaths();
	const lockResult = acquireGatewayLock(daemonPaths);
	if (!lockResult.acquired) {
		logger.error("ompk-tag already running", { pid: lockResult.pid, pidFile: daemonPaths.pidFile });
		console.error(
			`ompk-tag gateway already running (pid ${lockResult.pid}); stop it with /telegram off or kill ${lockResult.pid}`,
		);
		process.exit(1);
	}
	process.on("exit", () => releaseGatewayPidLock(daemonPaths));

	const captureConfig = loadCaptureConfig();
	const captureService = new CaptureService();

	let captureRouter: CaptureHttpRouter | undefined;
	let stopTelegramPoll: (() => void) | undefined;
	let retentionTimer: ReturnType<typeof setInterval> | undefined;
	let store: CaptureStore | undefined;

	const idleSupervisor = createIdleExitSupervisor({
		timeoutMs: idleExitTimeoutMs,
		hasActiveWork: () => {
			if (!store) return false;
			try {
				const dbPath = path.join(captureConfig.dataDir, "capture.db");
				if (fs.existsSync(dbPath)) {
					const db = new Database(dbPath, { readonly: true });
					try {
						const row = db
							.query<{ count: number }, []>(
								"SELECT COUNT(*) as count FROM capture_runs WHERE status NOT IN ('completed', 'failed', 'cancelled')",
							)
							.get();
						return (row?.count ?? 0) > 0;
					} finally {
						db.close();
					}
				}
			} catch {
				// Fallback if sqlite open/query fails
			}
			return store.listRuns(500).some(run => !isTerminalRunStatus(run.status));
		},
		onIdle: () => void shutdown("idle-timeout"),
	});
	if (captureConfig.enabled) {
		store = new CaptureStore({ dataDir: captureConfig.dataDir });
		const runner = new PiRunnerAdapter({ autoApprove: captureConfig.autoApprove });
		if (captureConfig.autoApprove) {
			logger.warn(
				"CAPTURE_AUTO_APPROVE is on: capture sessions run with UNRESTRICTED tools and no approval prompts. " +
					"Any user in an allowlisted Telegram chat can drive a fully autonomous agent on this host. " +
					"Keep TELEGRAM_ALLOWED_CHAT_IDS tightly scoped.",
			);
		}
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
				onActivity: () => idleSupervisor.noteActivity(),
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
		idleSupervisor.stop();
		stopTelegramPoll?.();
		await server.stop();
		store?.close();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));

	if (idleSupervisor.enabled) {
		idleSupervisor.start();
		logger.info("Idle exit armed", { idleExitTimeoutMs });
	}
}

main();
