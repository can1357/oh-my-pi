/** Every in-daemon module, in `caps` order. `server.ts` registers these at startup. */
import type { DaemonModule } from "../module";
import { blobModule } from "./blob";
import { disasmModule } from "./disasm";
import { inferModule } from "./infer";
import { lspModule } from "./lsp";
import { predictModule } from "./predict";
import { speechModule } from "./speech";

export const DAEMON_MODULES: readonly DaemonModule[] = [
	lspModule,
	disasmModule,
	blobModule,
	inferModule,
	speechModule,
	predictModule,
];
