import * as fs from "node:fs/promises";
import { loadLegacyPiModule } from "../../src/extensibility/plugins/legacy-pi-compat";

const [entryPath, helperPath, editedHelper] = process.argv.slice(2);
if (!entryPath || !helperPath) {
	throw new Error("usage: legacy-pi-extension-lazy-cjs-edit-probe <entry> <helper> [edited helper source]");
}

const mod = (await loadLegacyPiModule(entryPath)) as { loadValue(): Promise<string> };
if (editedHelper !== undefined) await fs.writeFile(helperPath, editedHelper, "utf8");
process.stdout.write(`${await mod.loadValue()}\n`);
