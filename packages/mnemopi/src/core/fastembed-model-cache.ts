import * as path from "node:path";

const FASTEMBED_MODEL_SIDECARS = [
	"config.json",
	"tokenizer.json",
	"tokenizer_config.json",
	"special_tokens_map.json",
] as const;

const FASTEMBED_HF_REPOS: Record<string, string> = {
	"fast-all-MiniLM-L6-v2": "sentence-transformers/all-MiniLM-L6-v2",
	"fast-bge-base-en": "BAAI/bge-base-en",
	"fast-bge-base-en-v1.5": "BAAI/bge-base-en-v1.5",
	"fast-bge-small-en": "BAAI/bge-small-en",
	"fast-bge-small-en-v1.5": "BAAI/bge-small-en-v1.5",
	"fast-bge-small-zh-v1.5": "BAAI/bge-small-zh-v1.5",
	"fast-multilingual-e5-large": "intfloat/multilingual-e5-large",
};

/** Download missing config/tokenizer sidecars into a fastembed model cache directory. */
export async function ensureFastembedModelSidecars(model: string, cacheDir = "local_cache"): Promise<boolean> {
	const repo = FASTEMBED_HF_REPOS[model];
	if (repo === undefined) return false;

	const modelDir = path.join(cacheDir, model);
	for (const fileName of FASTEMBED_MODEL_SIDECARS) {
		const target = path.join(modelDir, fileName);
		if (await Bun.file(target).exists()) continue;

		const response = await fetch(`https://huggingface.co/${repo}/resolve/main/${fileName}`);
		if (!response.ok) {
			throw new Error(
				`Failed to download ${model} ${fileName} from ${repo}: ${response.status} ${response.statusText}`,
			);
		}
		await Bun.write(target, await response.arrayBuffer());
	}
	return true;
}
