/** Every in-daemon module, in `caps` order. `server.ts` registers these at startup. */
import type { DaemonModule } from "../module";
import { agentsModule } from "./agents";
import { blobModule } from "./blob";
import { disasmModule } from "./disasm";
import { inferModule } from "./infer";
import { lspModule } from "./lsp";
import { mcpModule } from "./mcp";
import { mutexModule } from "./mutex";
import { predictModule } from "./predict";
import { providerSlotsModule } from "./provider-slots";
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
];
