import { combine, type Derived } from "../config/registry";
import { ghidraHostSupported } from "../ghidra/platform";
import { cfgIdaInstall } from "../ida/install";
import type { DisasmBackendId } from "./backend";
import { cfgDisassembler } from "./settings";

/** Backend serving explicit read analysis and eval's dsm namespace; undefined leaves metadata-only reads. */
export const cfgDisasmBackend: Derived<DisasmBackendId | undefined> = combine(
	{ choice: cfgDisassembler, ida: cfgIdaInstall },
	({ choice, ida }) =>
		choice === "none"
			? undefined
			: choice === "ida"
				? ida
					? "ida"
					: undefined
				: choice === "ghidra"
					? ghidraHostSupported()
						? "ghidra"
						: undefined
					: ida
						? "ida"
						: ghidraHostSupported()
							? "ghidra"
							: undefined,
);
