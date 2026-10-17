# @oh-my-pi/pi-mnemopi

Local SQLite memory engine for omp agents.

This package is the Bun/TypeScript port of the Mnemosyne memory engine. It provides:

- `Mnemopi`, a small facade for remember/recall/stats/sleep workflows.
- `BeamMemory`, the lower-level working/episodic memory engine.
- MCP tool definitions and a dispatcher for host integrations.
- Optional local ONNX embeddings through `fastembed` and optional OpenAI-compatible embedding/LLM endpoints.

The package does not bundle or download a local GGUF LLM. LLM paths are host-backend or OpenAI-compatible remote only; when no LLM is configured, deterministic heuristic paths are used.

## Basic use

```ts
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";

const memory = new Mnemopi({ dbPath: "./mnemopi.db", bank: "project" });
const id = memory.remember("The deployment target is stable-cluster.", {
	source: "notes",
	importance: 0.8,
	veracity: "true",
});

const results = memory.recall("deployment target", 5);
console.log(id, results[0]?.content);

memory.close();
```

Lexical recall matches whole tokens, declared synonyms, underscore-separated identifier parts, and other forms of a word of at least four characters: the word plus `s`, `es`, `d`, `ed`, `ing`, `er`, `ers`, `ment` or `ments`, a final `e` replaced by `ing`/`ion`/`ions`, or a final `y` replaced by `ies`/`ied`. `backup` matches `backups`, `facts` matches `fact` and `caching` matches `cache`, but `1Password` does not match `pass` or `word`, and `redis` does not match `redistribution`.

## Configuration

`Mnemopi` accepts LLM and embedding options directly. `MNEMOPI_*` environment variables remain fallbacks/defaults when the matching constructor option is omitted.

```ts
import { Mnemopi } from "@oh-my-pi/pi-mnemopi";
import type { Model } from "@oh-my-pi/pi-ai";

const ftsOnly = new Mnemopi({ noEmbeddings: true });

const remoteEmbeddings = new Mnemopi({
	embeddingModel: "text-embedding-3-small",
	embeddingApiUrl: "https://api.openai.com/v1",
	embeddingApiKey: process.env.OPENAI_API_KEY,
});

const remoteLlm = new Mnemopi({
	llm: {
		baseUrl: "https://api.openai.com/v1",
		apiKey: process.env.OPENAI_API_KEY,
		model: "gpt-4.1-mini",
	},
	// Equivalent aliases: llmBaseUrl, llmApiKey, llmModel.
});

declare const smolModel: Model;
const piAiLlm = new Mnemopi({ llm: smolModel });
const dynamicLlm = new Mnemopi({
	llm: async (prompt, opts) => {
		const token = await getFreshOauthToken();
		return await completeWithPiAi(prompt, {
			token,
			maxTokens: opts?.maxTokens,
			temperature: opts?.temperature,
		});
	},
});
```

### Banks and host scoping

`Mnemopi` itself exposes banks directly through constructor options such as `bank`; it does not hard-code coding-agent project scoping.

The omp coding-agent wrapper adds `mnemopi.scoping` on top of those constructor options:

- `global`: one shared bank
- `per-project`: isolated project memory
- `per-project-tagged`: project-local writes plus global recall visibility

In `per-project-tagged`, the wrapper is responsible for combining project-local retention with global recall visibility. The package still just exposes banks plus constructor-level LLM and embedding options.

Common environment fallbacks:

- `MNEMOPI_DATA_DIR` / `MNEMOPI_DB_PATH`: default storage location.
- `MNEMOPI_DB_PAGE_SIZE`: optional SQLite page size for new file-backed databases; use a valid power of two from 512 to 65536 or `os` to request the detected system page size. Unset preserves SQLite's default.
- `MNEMOPI_NO_EMBEDDINGS=1`: force FTS-only recall.
- `MNEMOPI_EMBEDDING_MODEL`: defaults to `BAAI/bge-small-en-v1.5`.
- `MNEMOPI_EMBEDDING_API_URL` and `MNEMOPI_EMBEDDING_API_KEY`: OpenAI-compatible embedding endpoint.
- `MNEMOPI_LLM_ENABLED=1`, `MNEMOPI_LLM_BASE_URL`, `MNEMOPI_LLM_API_KEY`, `MNEMOPI_LLM_MODEL`: OpenAI-compatible LLM endpoint.

Local embeddings use the `fastembed` npm package. Its default `BGESmallENV15` model is 384-dimensional and uses the package's CLS pooling plus vector normalization path. Local GGUF LLMs are not available in this package.

### Sharing one embedding model across processes

Each process that embeds locally loads its own fastembed/ONNX runtime. To load it once per machine, run the server and point every client at it:

```sh
mnemopi embed-serve --model BAAI/bge-base-en-v1.5 --port 11439
MNEMOPI_EMBEDDING_API_URL=http://127.0.0.1:11439/v1 mnemopi recall "production deploy target"
```

Serve the same model the store already uses (`MNEMOPI_EMBEDDING_MODEL`, default `BAAI/bge-small-en-v1.5`). A request for another model gets a 400, and clients keep writing that model name, so existing embeddings stay valid. The server binds `127.0.0.1` and has no auth. If it is down, API-mode clients get no vectors and recall falls back to keyword-only.

To keep other local users and processes off it, listen on a unix socket instead. The socket is created `0600`, and clients address it as `unix:<path>`:

```sh
mnemopi embed-serve --model BAAI/bge-base-en-v1.5 --socket ~/.mnemopi/embed.sock
MNEMOPI_EMBEDDING_API_URL=unix:$HOME/.mnemopi/embed.sock mnemopi recall "production deploy target"
```

`--socket` cannot be combined with `--host` or `--port`. A leftover socket file from a crashed server is replaced on start; a socket that still answers is never overwritten.

## Commands

```sh
mnemopi remember "Use stable-cluster for production deploys"
mnemopi recall "production deploy target"
mnemopi stats
mnemopi sleep
```

## Tests

```sh
bun --cwd packages/mnemopi test
bun --cwd packages/mnemopi run check
```
