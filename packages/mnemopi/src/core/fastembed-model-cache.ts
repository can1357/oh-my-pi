import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Hugging Face repo and weight files fastembed downloads for each built-in
 * model. Mirrors fastembed's private `MODEL_SOURCES` table; fastembed
 * exposes no API for its cache layout.
 */
const FASTEMBED_MODEL_SOURCES: Record<string, { repo: string; files: readonly string[] }> = {
	"fast-all-MiniLM-L6-v2": { repo: "Qdrant/all-MiniLM-L6-v2-onnx", files: ["model.onnx"] },
	"fast-bge-base-en": { repo: "Qdrant/fast-bge-base-en", files: ["model_optimized.onnx"] },
	"fast-bge-base-en-v1.5": { repo: "Qdrant/bge-base-en-v1.5-onnx-Q", files: ["model_optimized.onnx"] },
	"fast-bge-small-en": { repo: "Qdrant/bge-small-en", files: ["model_optimized.onnx"] },
	"fast-bge-small-en-v1.5": { repo: "Qdrant/bge-small-en-v1.5-onnx-Q", files: ["model_optimized.onnx"] },
	"fast-bge-small-zh-v1.5": { repo: "Qdrant/bge-small-zh-v1.5", files: ["model_optimized.onnx"] },
	"fast-multilingual-e5-large": {
		repo: "Qdrant/multilingual-e5-large-onnx",
		files: ["model.onnx", "model.onnx_data"],
	},
};

const FASTEMBED_TOKENIZER_FILES = [
	"tokenizer.json",
	"tokenizer_config.json",
	"config.json",
	"special_tokens_map.json",
] as const;

/**
 * Whether `FlagEmbedding.init` can load `model` from `cacheDir` without a
 * download. fastembed caches each file under `<cacheDir>/<repo with / → _>/`
 * and fetches only the files that are missing, so a model is cached exactly
 * when every file is present. Unknown models report false. The agent's embed
 * client uses this to decide whether an init shows download activity.
 */
export async function isFastembedModelCached(model: string, cacheDir: string): Promise<boolean> {
	const source = FASTEMBED_MODEL_SOURCES[model];
	if (source === undefined) return false;
	const modelDir = path.join(cacheDir, source.repo.replace("/", "_"));
	const present = await Promise.all(
		[...source.files, ...FASTEMBED_TOKENIZER_FILES].map(file =>
			fs.access(path.join(modelDir, file)).then(
				() => true,
				() => false,
			),
		),
	);
	return present.every(Boolean);
}
