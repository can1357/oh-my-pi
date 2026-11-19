import type { LspStartupServerInfo } from "./index";

export const LSP_STARTUP_EVENT_CHANNEL = "lsp:startup";

export type LspStartupEvent =
	| {
			type: "completed";
			servers: Array<LspStartupServerInfo & { status: "ready" | "error" }>;
	  }
	| {
			type: "failed";
			error: string;
	  };
