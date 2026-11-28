import { cfgBinjaInstall } from "../binja/install";
import { Derived } from "../config/registry";
import type { Settings } from "../config/settings";
import { ghidraHostSupported } from "../ghidra/platform";
import { cfgIdaInstall } from "../ida/install";
import type { DisasmBackendId } from "./backend";
import { cfgDisassembler } from "./settings";

type BackendInputs = readonly [choice: DisasmBackendId | "auto" | "none", install: string | undefined];

class ActiveBackend extends Derived<DisasmBackendId | undefined> {
	readonly sources = [cfgDisassembler, ...cfgIdaInstall.sources, ...cfgBinjaInstall.sources];

	inputs(settings: Settings): BackendInputs {
		const choice = cfgDisassembler.get(settings);
		// Install discovery probes the filesystem. Auto tries IDA, then provisionable Ghidra;
		// Binary Ninja is strictly opt-in because its licence may not allow headless use.
		if (choice === "auto" || choice === "ida") return [choice, cfgIdaInstall.get(settings)];
		if (choice === "binja") return [choice, cfgBinjaInstall.get(settings)];
		return [choice, undefined];
	}

	compute([choice, install]: BackendInputs): DisasmBackendId | undefined {
		if (choice === "none") return undefined;
		if (choice === "binja" || choice === "ida") return install !== undefined ? choice : undefined;
		if (choice === "auto" && install !== undefined) return "ida";
		return ghidraHostSupported() ? "ghidra" : undefined;
	}
}

/** Backend serving explicit read analysis and eval's dsm namespace; undefined leaves metadata-only reads. */
export const cfgDisasmBackend: Derived<DisasmBackendId | undefined> = new ActiveBackend();
