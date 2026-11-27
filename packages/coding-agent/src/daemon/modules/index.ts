/** Every in-daemon module, in `caps` order. `server.ts` registers these at startup. */
import { authDaemonLimitHandlers } from "../../session/auth-daemon-limits";
import { authDaemonManagementHandlers } from "../../session/auth-daemon-management";
import { authDaemonMcpHandlers } from "../../session/auth-daemon-mcp";
import { authDaemonReadHandlers } from "../../session/auth-daemon-reads";
import { authDaemonSessionHandlers } from "../../session/auth-daemon-sessions";
import type { DaemonModule } from "../module";
import { agentsModule } from "./agents";
import { createAuthModule } from "./auth";
import { blobModule } from "./blob";
import { disasmModule } from "./disasm";
import { inferModule } from "./infer";
import { lspModule } from "./lsp";
import { mcpModule } from "./mcp";
import { mutexModule } from "./mutex";
import { predictModule } from "./predict";
import { providerSlotsModule } from "./provider-slots";
import { settingsModule } from "./settings";
import { speechModule } from "./speech";
import { transcriptsModule } from "./transcripts";

export const DAEMON_MODULES: readonly DaemonModule[] = [
	lspModule,
	disasmModule,
	blobModule,
	inferModule,
	speechModule,
	predictModule,
	agentsModule,
	mutexModule,
	providerSlotsModule,
	mcpModule,
	transcriptsModule,
	settingsModule,
	createAuthModule(
		new Map([
			...authDaemonReadHandlers,
			...authDaemonSessionHandlers,
			...authDaemonLimitHandlers,
			...authDaemonManagementHandlers,
			...authDaemonMcpHandlers,
		]),
	),
];
