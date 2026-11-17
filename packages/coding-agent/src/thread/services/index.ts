/**
 * Every {@link ThreadService} bridged across subagent worker links, in install
 * order. Codecs and exported classes are matched in this order, so services
 * whose codecs others' payloads embed (session/ref identity) come first.
 */
import type { ThreadService } from "../services";
import { agentsThreadService } from "./agents";
import { asyncJobsThreadService } from "./async-jobs";
import { authService } from "./auth";
import { executorThreadService } from "./executor";
import { identityThreadService } from "./identity";
import { integrationsThreadService } from "./integrations";
import { loggerThreadService } from "./logging";
import { lspThreadService } from "./lsp";
import { memoryThreadService } from "./memory";
import { runtimeThreadService } from "./runtime";
import { runtimeIdentityThreadService } from "./runtime-identity";
import { settingsThreadService } from "./settings";
import { telemetryThreadService } from "./telemetry";

export const THREAD_SERVICES: readonly ThreadService[] = [
	identityThreadService,
	// Early, so a worker's `logger.flush()` waits for main from the first service boot on.
	loggerThreadService,
	runtimeIdentityThreadService,
	settingsThreadService,
	authService,
	agentsThreadService,
	lspThreadService,
	telemetryThreadService,
	memoryThreadService,
	integrationsThreadService,
	runtimeThreadService,
	asyncJobsThreadService,
	// Last: its entry points run subagents against every service above.
	executorThreadService,
];
