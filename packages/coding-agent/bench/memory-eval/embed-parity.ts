// Run: bun packages/coding-agent/bench/memory-eval/embed-parity.ts <parity-py.json>
// Compares Mnemopi's embeddings of the texts py/embed_parity.py embedded with fastembed; exits 1 if any cosine is
// non-finite or < 0.99.
import { embed } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { assertMnemopiEnvClean } from "./engines/mnemopi";

const MODEL = "BAAI/bge-small-en-v1.5";
const MIN_COSINE = 0.99;

interface ParityFile {
	model: string;
	texts: string[];
	vectors: number[][];
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
	if (a.length !== b.length) throw new Error(`vector dimensions differ: ${a.length} vs ${b.length}`);
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	return dot / Math.sqrt(normA * normB);
}

/** Throws unless every cosine is finite and at least MIN_COSINE. */
export function assertParity(cosines: readonly number[]): void {
	const bad = cosines.findIndex(c => !Number.isFinite(c));
	if (bad !== -1) throw new Error(`parity failed: text ${bad} has a non-finite cosine (${cosines[bad]})`);
	const min = Math.min(...cosines);
	if (min < MIN_COSINE) throw new Error(`parity failed: min cosine ${min} < ${MIN_COSINE}`);
}

async function main(file: string | undefined): Promise<void> {
	if (!file) throw new Error("usage: embed-parity.ts <parity-py.json>");
	// Otherwise embed() could reach an API instead of the local fastembed this probe validates.
	assertMnemopiEnvClean();
	const py: ParityFile = await Bun.file(file).json();
	if (py.model !== MODEL) throw new Error(`${file} was embedded with ${py.model}, expected ${MODEL}`);
	const vectors = await withMnemopiRuntimeOptions({ embeddings: { model: MODEL, disabled: false } }, () =>
		embed(py.texts),
	);
	if (!vectors || vectors.length !== py.texts.length) throw new Error("mnemopi returned no usable embeddings");
	const cosines = vectors.map((vector, i) => cosine(vector, py.vectors[i]));
	const mean = cosines.reduce((sum, c) => sum + c, 0) / cosines.length;
	console.log(`${cosines.length} texts: min cosine ${Math.min(...cosines).toFixed(6)}, mean cosine ${mean.toFixed(6)}`);
	assertParity(cosines);
}

if (import.meta.main) {
	try {
		await main(Bun.argv[2]);
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
