import { loadLegacyPiModule } from "../../src/extensibility/plugins/legacy-pi-compat";

// Loads one extension entry the way a fresh omp process does at startup.
const entry = process.argv[2];
if (!entry) throw new Error("Usage: legacy-pi-transpiler-cache-probe.ts <extension entry>");
const extension = await loadLegacyPiModule(entry);
if (typeof extension !== "object" || extension === null || !("loaded" in extension)) {
	throw new Error("The extension entry must export `loaded`");
}
process.stdout.write(`${String(extension.loaded)}\n`);
