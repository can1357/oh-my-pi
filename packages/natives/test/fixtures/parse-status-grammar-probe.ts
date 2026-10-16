import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { __ompSetGrammarDir, parseCodeStatus, summarizeCode, wasmGrammarFor } from "../../native";

const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-parse-status-"));
try {
	__ompSetGrammarDir(directory);
	const options = { code: "[core]\nname = pi\n", lang: "ini" };
	const grammar = wasmGrammarFor({ lang: options.lang });
	if (!grammar) throw new Error("INI must use a wasm grammar");
	const missing = parseCodeStatus(options);
	await Bun.write(path.join(directory, grammar.file), "invalid wasm module");
	let statusError: string | undefined;
	let summaryError: string | undefined;
	try {
		parseCodeStatus(options);
	} catch (error) {
		statusError = error instanceof Error ? error.message : String(error);
	}
	try {
		summarizeCode(options);
	} catch (error) {
		summaryError = error instanceof Error ? error.message : String(error);
	}
	if (!statusError || !summaryError) throw new Error("Corrupt grammar must surface an error");
	process.stdout.write(
		JSON.stringify({
			missing: { parsed: missing.parsed, language: missing.language ?? null },
			statusError,
			summaryError,
		}),
	);
} finally {
	await fs.rm(directory, { recursive: true, force: true });
}
