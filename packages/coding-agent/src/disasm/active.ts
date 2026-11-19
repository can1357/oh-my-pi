import { cfgBinjaInstall } from "../binja/install";
import { combine, type Derived } from "../config/registry";
import { ghidraHostSupported } from "../ghidra/platform";
import { cfgIdaInstall } from "../ida/install";
import type { DisasmBackendId } from "./backend";
import { cfgDisassembler } from "./settings";

/** Order `auto` tries backends in; the first available one serves. */
const AUTO_ORDER: readonly DisasmBackendId[] = ["ida", "ghidra", "binja"];

/** Backend serving explicit read analysis and eval's dsm namespace; undefined leaves metadata-only reads. */
export const cfgDisasmBackend: Derived<DisasmBackendId | undefined> = combine(
	{ choice: cfgDisassembler, ida: cfgIdaInstall, binja: cfgBinjaInstall },
	({ choice, ida, binja }) => {
		if (choice === "none") return undefined;
		// Ghidra is provisioned on first analysis, so it is available wherever its platform is supported.
		const available: Record<DisasmBackendId, boolean> = {
			ida: ida !== undefined,
			ghidra: ghidraHostSupported(),
			binja: binja !== undefined,
		};
		// An explicit choice never falls back to another backend.
		return choice === "auto" ? AUTO_ORDER.find(id => available[id]) : available[choice] ? choice : undefined;
	},
);
