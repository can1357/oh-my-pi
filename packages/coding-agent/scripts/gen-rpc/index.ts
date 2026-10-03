/**
 * `bun run gen:rpc`: regenerates every artifact derived from the RPC wire schema.
 *
 * Outputs (all committed; `test/rpc-wire/generated.test.ts` fails when stale):
 * - `src/modes/rpc/wire/rpc-wire.schema.json`: the language-neutral bundle
 * - `src/modes/rpc/wire/rpc-wire.generated.ts`: TypeScript wire types
 * - `sdk/python/omp-rpc/src/omp_rpc/_wire.py`: Python types, parsers, and client methods
 * - `sdk/rust/omp-rpc/src/wire.rs`: Rust serde types, frame decoders, and `Command` impls
 * - `sdk/go/omp-rpc/wire.go`: Go types, frame decoders, and `Commands` methods
 */
import * as path from "node:path";
import { buildRpcWireBundle } from "../../src/modes/rpc/wire";
import { emitGo } from "./go";
import { buildWireModel } from "./model";
import { emitPython } from "./python";
import { emitRust } from "./rust";
import { emitTypeScript } from "./typescript";

const PACKAGE_DIR = path.resolve(import.meta.dir, "../..");
const WIRE_DIR = path.join(PACKAGE_DIR, "src/modes/rpc/wire");
const SDK_DIR = path.resolve(PACKAGE_DIR, "../../sdk");

/** Generated file path → contents. */
export function generateRpcArtifacts(): Map<string, string> {
	const bundle = buildRpcWireBundle();
	const model = buildWireModel(bundle);
	return new Map([
		[path.join(WIRE_DIR, "rpc-wire.schema.json"), `${JSON.stringify(bundle, null, "\t")}\n`],
		[path.join(WIRE_DIR, "rpc-wire.generated.ts"), emitTypeScript(model)],
		[path.join(SDK_DIR, "python/omp-rpc/src/omp_rpc/_wire.py"), emitPython(model)],
		[path.join(SDK_DIR, "rust/omp-rpc/src/wire.rs"), emitRust(model)],
		[path.join(SDK_DIR, "go/omp-rpc/wire.go"), emitGo(model)],
	]);
}

if (import.meta.main) {
	for (const [file, contents] of generateRpcArtifacts()) {
		await Bun.write(file, contents);
		console.log(`wrote ${path.relative(process.cwd(), file)}`);
	}
}
