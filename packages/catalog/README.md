# @pk-nerdsaver-ai/pi-catalog

Model catalog for [oh-my-pi](https://github.com/can1357/oh-my-pi): bundled model database, provider discovery, model identity, classification, and equivalence.

## What's inside

| Module | Purpose |
| --- | --- |
| `models.json` + `models` | Bundled model database (pricing, context windows, modalities, thinking support) |
| `provider-models` | Provider catalog descriptors (`CATALOG_PROVIDERS`), per-provider model resolution rules |
| `discovery` | Runtime model discovery for OpenAI-compatible endpoints, Gemini, Codex, Cursor, Antigravity, Ollama |
| `identity` | Model id parsing and classification (family/version), reference resolution, equivalence, selection priority |
| `model-thinking` | Thinking/reasoning metadata and generated per-model policies |
| `model-manager` / `model-cache` | Runtime model registry with discovery refresh and on-disk caching |
| `variant-collapse` | Collapsing provider-specific variants of the same underlying model |
| `compat` | Request/response compatibility fixups for OpenAI- and Anthropic-shaped APIs |
| `wire` | Wire-level helpers: Codex, Gemini headers, GitHub Copilot |
| `effort` | Reasoning-effort level definitions |

Import from subpaths (`@pk-nerdsaver-ai/pi-catalog/<module>`) or the root barrel.

## models.json is generated

Never edit `src/models.json` by hand — it is produced from upstream sources (models.dev, provider catalog discovery, OpenCode docs) by `scripts/generate-models.ts` and the resolvers in `src/provider-models/`. Regenerate with:

```sh
bun run gen:models
```

To change an entry, fix the source: resolver overrides in `provider-models/openai-compat.ts`, provider entries in `provider-models/descriptors.ts`, generator fixups in `scripts/generate-models.ts`, or thinking policies in `model-thinking.ts`.

## Install

```sh
bun add @pk-nerdsaver-ai/pi-catalog
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
