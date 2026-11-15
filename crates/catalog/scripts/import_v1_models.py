#!/usr/bin/env python3
"""Regenerates `fixtures/llm-oracle/catalog/models.json.zst` from pi's `models.json`.

The v1 (TypeScript) tree publishes its generated model roster as
`packages/catalog/src/models.json`: a provider -> model-id -> row map in
camelCase, produced by `packages/catalog/scripts/generate-models.ts` (network
discovery plus the KDL rules). This script is the only sanctioned way to move
that roster into omp's oracle fixture; it applies the fixed set of mechanical
rewrites the Rust `SourceModelRecord` schema needs, and refuses input it does
not understand instead of guessing:

* compat keys are snake_cased (`supportsStore` -> `supports_store`);
* `whenThinking` keeps only the five keys `WhenThinkingPolicy` models;
* `identity.effort` follows `EffortTier`'s spelling (`xhigh` -> `x_high`);
* `thinking.effortBudgets` keeps only efforts the row advertises;
* `compat.thinkingKeep` is the typed boolean (`"all"` -> `true`);
* rows of providers whose `providers.toml` entry pins a `codec` carry no
  per-row `api` (the codec owns the wire);
* specialist rows (`kind`: image, embedding, video, rerank, stt, tts, tiny,
  search, judge) are not chat routes. omp models those through provider
  facets and its media catalogs, so they never enter the chat roster;
* v1-only metadata with no omp counterpart is dropped explicitly, listed in
  `DROPPED_MODEL_KEYS` / `DROPPED_COMPAT_KEYS` with the reason.

An unmodelled `kind`, api, or provider aborts the run here, and the Rust
schema (`SourceModelRecord` and friends, all `deny_unknown_fields`) rejects any
other key the next step meets: extend the tables here, and the Rust schema when
the field is real, rather than loosening either.

The input is either the older provider -> model -> row map or pi's compact
catalog (`{"version": 1, "keys", "nodes", ...}`, pi v18.20 onward), which
`decode_compact` expands first. `--only provider,provider` imports just those
providers and keeps every other provider's rows from the existing fixture, so a
catalog addition does not churn the whole roster.

Usage (from the repository root):

    git show origin/main:packages/catalog/src/models.json > /tmp/v1-models.json
    just catalog-import-v1 /tmp/v1-models.json
    just catalog-import-v1 /tmp/v1-models.json sambanova,helmcode   # scoped

which runs this script and then `just catalog-snapshot` (source lock and
`catalog.postcard`). The pi tree needs no network here: `models.json` is the
checked-in output of pi's own generator, which is what carries the network
discovery.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CATALOG = ROOT / "fixtures/llm-oracle/catalog"
DEFAULT_OUT = CATALOG / "models.json.zst"
PROVIDERS = CATALOG / "providers.toml"

# Providers of pi's roster that are not chat routes at all. Their rows would be
# rejected by the `kind` rule anyway; naming them keeps a new pseudo-provider
# from slipping into the fixture unnoticed.
PSEUDO_PROVIDERS = {
	"local": "on-device tiny/tts models: omp-ai's local model catalogs own these",
	"web": "search engines: omp declares them as `web_search` provider facets",
}

# `kind` values pi assigns to non-chat rows. Every one is a specialist
# operation omp routes through provider facets rather than the chat roster.
SPECIALIST_KINDS = {
	"image", "embedding", "video", "rerank", "stt", "tts", "tiny", "search", "judge",
}

# Row-level keys pi added that omp's schema does not model. Dropped, not
# aliased: each either contradicts a locked omp decision or has no consumer.
DROPPED_MODEL_KEYS = {
	"webSearch": "vendor server-side tools are a locked non-goal",
	"promptCache": "no omp consumer; cache policy rides compat axes",
	"cursorMaxModeRoutes": "cursor route table has no omp consumer",
	"editPromptVariant": "prompt variants are scribe slots, not catalog data",
	"supportsAssistantPrefill": "no omp consumer",
	"requiresToolResultImageHoisting": "no omp consumer",
	"accountAccess": "per-account codex program routing has no omp consumer",
	"maxContextWindow": "codex extended-context tiers have no omp consumer",
}

# Compat keys pi derives from the host or added for TypeScript-only behavior.
DROPPED_COMPAT_KEYS = {
	"isOpenRouterHost": "derived from the endpoint host",
	"isVercelGatewayHost": "derived from the endpoint host",
	"disableReasoningWithTools": "no omp consumer",
	"supportsConfigurationUpdate": "no omp consumer",
	"supportsSteering": "no omp consumer",
	"streamRevision": "no omp consumer",
	"supportsServerCompaction": "no omp consumer",
	"firstPartyProvider": "derived from the provider id",
}

# `whenThinking.extraBody` keys outside `ReasoningBodyOverride` (thinking,
# enable_thinking, venice_parameters), which the Rust schema rejects.
DROPPED_EXTRA_BODY_KEYS = {
	"reasoning": "Modular's `reasoning.enabled = true` for single-rung models; the typed "
	"`ReasoningBodyOverride` has no `reasoning` field and no omp codec consumes one",
}

# `cost` keys pi added that omp's pricing schedule does not model.
DROPPED_COST_KEYS = {
	"timeBased": "DeepSeek peak/off-peak windows and dated rate schedules need a time-aware "
	"pricing dimension omp's `Pricing` does not have; rows keep their list price",
}

WHEN_THINKING_KEYS = (
	"extraBody",
	"thinkingFormat",
	"requiresReasoningContentForToolCalls",
	"allowsSyntheticReasoningContentForToolCalls",
	"reasoningContentField",
)

# Wire spellings `SourceTransport` accepts.
CHAT_APIS = {
	"anthropic-messages",
	"bedrock-converse-stream",
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"openai-codex-responses",
	"google-generative-ai",
	"google-vertex",
	"google-gemini-cli",
	"ollama-chat",
	"cursor-agent",
	"devin-agent",
	"gitlab-duo-agent",
	"openrouter",
}

EFFORT_SPELLING = {"xhigh": "x_high"}


class ImportError_(Exception):
	"""Input the importer refuses to guess about."""


_UNDEFINED = object()


def decode_compact(data: dict) -> dict:
	"""Expands pi's compact `models.json` (`{"version": 1, "keys", "nodes", ...}`)
	into the provider -> model-id -> row map the rest of this script reads.

	Mirrors `packages/catalog/src/model-catalog-format.ts` (`openModelCatalog`,
	`getCatalogProvider`): nodes are interned objects/arrays, a one-element
	array is a node reference (`[-1]` is an explicitly undefined value), boolean
	properties are bit-packed per shape, per-provider constants are folded out
	of the rows, and each row's `compat` is a per-api base plus a delta."""
	if data.get("version") != 1:
		raise ImportError_(f"unsupported compact catalog version {data.get('version')!r}")
	keys = data["keys"]
	shapes = data["booleanShapes"]
	nodes = data["nodes"]
	cache: dict[int, object] = {}

	def decode(value):
		if not isinstance(value, list):
			return value
		node_id = value[0]
		if node_id == -1:
			return _UNDEFINED
		if node_id in cache:
			return cache[node_id]
		node = nodes[node_id]
		if node[0] == 1:
			result = [None if (item := decode(entry)) is _UNDEFINED else item for entry in node[1]]
		else:
			result = {}
			fill(result, node)
		cache[node_id] = result
		return result

	def fill(target: dict, node: list) -> None:
		props = node[1]
		for index in range(0, len(props), 2):
			item = decode(props[index + 1])
			if item is not _UNDEFINED:
				target[keys[props[index]]] = item
		shape = shapes[node[2]]
		for index, key_id in enumerate(shape):
			target[keys[key_id]] = ((node[3][index >> 5] >> (index % 32)) & 1) != 0

	bases = {api: decode(encoded) for api, encoded in data["compat"]}
	out: dict = {}
	for provider, encoded_constants, rows in data["providers"]:
		constants = decode(encoded_constants)
		models: dict = {}
		for row in rows:
			model_id, encoded, delta = row[0], row[1], (row[2] if len(row) > 2 else None)
			if not isinstance(encoded, list) or encoded[0] < 0 or nodes[encoded[0]][0] != 0:
				raise ImportError_(f"{provider}/{model_id}: invalid compact model row")
			row_node = nodes[encoded[0]]
			model = {"id": model_id, **constants}
			fill(model, row_node)
			if delta is not None:
				compat = dict(bases[model["api"]])
				for key_id in delta[0]:
					compat.pop(keys[key_id], None)
				for key, item in decode(delta[1]).items():
					compat[key] = item
				model["compat"] = compat
			models[model_id] = model
		out[provider] = models
	return out


def snake(key: str) -> str:
	key = key.replace("OpenAI", "Openai")
	return re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), key)


def when_thinking(value: dict) -> dict:
	"""pi bakes the whole resolved compat object into `whenThinking`; only the
	five keys `WhenThinkingPolicy` models are real overrides."""
	out = {key: item for key, item in value.items() if key in WHEN_THINKING_KEYS}
	body = out.get("extraBody")
	if isinstance(body, dict):
		body = {key: item for key, item in body.items() if key not in DROPPED_EXTRA_BODY_KEYS}
		if body:
			out["extraBody"] = body
		else:
			del out["extraBody"]
	return out


def convert_compat(compat: dict) -> dict:
	out = {}
	for key, value in compat.items():
		if key in DROPPED_COMPAT_KEYS:
			continue
		if key == "whenThinking":
			value = when_thinking(value)
		elif key == "thinkingKeep":
			if value not in (True, False, "all"):
				raise ImportError_(f"unmodelled thinkingKeep {value!r}")
			value = value is not False
		out[snake(key)] = value
	return out


def convert_thinking(thinking: dict) -> dict:
	out = dict(thinking)
	budgets = out.get("effortBudgets")
	if budgets is not None:
		efforts = set(out.get("efforts", ()))
		out["effortBudgets"] = {k: v for k, v in budgets.items() if k in efforts}
	return out


def convert_identity(identity: dict) -> dict:
	out = dict(identity)
	effort = out.get("effort")
	if effort is not None:
		out["effort"] = EFFORT_SPELLING.get(effort, effort)
	return out


def convert_row(row: dict, codec_provider: bool) -> dict:
	out = {}
	for key, value in row.items():
		if key in DROPPED_MODEL_KEYS:
			continue
		if key == "api" and codec_provider:
			continue
		if key in ("compat", "compatConfig"):
			value = convert_compat(value)
		elif key == "cost":
			value = {k: v for k, v in value.items() if k not in DROPPED_COST_KEYS}
		elif key == "thinking":
			value = convert_thinking(value)
		elif key == "identity":
			value = convert_identity(value)
		out[key] = value
	return out


def convert(v1: dict, codec_providers: set[str], known_providers: set[str]) -> tuple[dict, dict]:
	out: dict = {}
	report = {"specialist": {}, "pseudo": {}, "unknown_provider": [], "kept": 0}
	for provider, models in v1.items():
		if provider in PSEUDO_PROVIDERS:
			report["pseudo"][provider] = len(models)
			continue
		rows = {}
		for model_id, row in models.items():
			kind = row.get("kind")
			if kind is not None:
				if kind not in SPECIALIST_KINDS:
					raise ImportError_(f"{provider}/{model_id}: unmodelled kind {kind!r}")
				report["specialist"].setdefault(provider, 0)
				report["specialist"][provider] += 1
				continue
			api = row.get("api")
			if api not in CHAT_APIS:
				raise ImportError_(f"{provider}/{model_id}: unmodelled api {api!r}")
			rows[model_id] = convert_row(row, provider in codec_providers)
		if rows and provider not in known_providers:
			report["unknown_provider"].append(provider)
			continue
		if rows:
			out[provider] = rows
			report["kept"] += len(rows)
	return out, report


def main() -> int:
	parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
	parser.add_argument("--v1", required=True, type=Path, help="pi packages/catalog/src/models.json")
	parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="fixture to write (.zst) or a .json path")
	parser.add_argument(
		"--only",
		type=lambda text: {name for name in text.split(",") if name},
		help="comma-separated provider ids: import just these and keep every other provider's rows "
		"from the existing --out fixture (a scoped roster refresh)",
	)
	args = parser.parse_args()

	registry = tomllib.loads(PROVIDERS.read_text())["providers"]
	codec_providers = {
		name for name, entry in registry.items() if "codec" in entry and entry.get("transport") != "embedded"
	}
	v1 = json.loads(args.v1.read_text())
	try:
		if isinstance(v1.get("providers"), list):
			v1 = decode_compact(v1)
		if args.only is not None:
			absent = args.only - set(v1)
			if absent:
				raise ImportError_("--only names providers absent from the input: " + ", ".join(sorted(absent)))
			v1 = {name: models for name, models in v1.items() if name in args.only}
		out, report = convert(v1, codec_providers, set(registry))
	except ImportError_ as error:
		print(f"import_v1_models: {error}", file=sys.stderr)
		return 1
	if report["unknown_provider"]:
		print(
			"import_v1_models: providers missing from providers.toml: "
			+ ", ".join(sorted(report["unknown_provider"])),
			file=sys.stderr,
		)
		return 1
	if args.only is not None:
		raw = args.out.read_bytes()
		if args.out.suffix == ".zst":
			raw = subprocess.run(["zstd", "-q", "-d", "-c"], input=raw, capture_output=True, check=True).stdout
		kept = {name: models for name, models in json.loads(raw).items() if name not in args.only}
		out = dict(sorted({**kept, **out}.items()))
	blob = json.dumps(out, separators=(",", ":"), ensure_ascii=False).encode()
	if args.out.suffix == ".zst":
		compressed = subprocess.run(
			["zstd", "-q", "-19", "-c"], input=blob, capture_output=True, check=True
		).stdout
		args.out.write_bytes(compressed)
	else:
		args.out.write_bytes(blob)
	print(
		f"wrote {args.out}: {len(out)} providers, {sum(map(len, out.values()))} models "
		f"({report['kept']} imported); "
		f"specialist rows skipped {sum(report['specialist'].values())} "
		f"({report['specialist']}); pseudo providers skipped {report['pseudo']}"
	)
	return 0


if __name__ == "__main__":
	sys.exit(main())
