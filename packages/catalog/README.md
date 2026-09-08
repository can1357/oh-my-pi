# @oh-my-pi/pi-catalog

Model catalog for [oh-my-pi](https://github.com/can1357/oh-my-pi): bundled model database, provider discovery, model identity, classification, and equivalence.

## What's inside

| Module                          | Purpose                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `models.json` + `models`        | Bundled model database (pricing, context windows, modalities, thinking support)                             |
| `provider-models`               | Provider catalog descriptors (`CATALOG_PROVIDERS`), per-provider model resolution rules                     |
| `discovery`                     | Runtime model discovery for OpenAI-compatible endpoints, Gemini, Codex, Cursor, Antigravity, Ollama         |
| `compat/rules`                  | Checked-in KDL policy tree: taxonomy (classes/families/revisions), class/provider cascade rules, runtime behavior vocabulary; compiled by `bun run gen:compat` into the committed `rules.json` |
| `compat`                        | The rule engine: `classifyModel` (taxonomy), `resolveModelPolicy` (cascade), behavior accessors (`api-routes`, `model-limits`, `exclude-models`, `pricing-peer`), collapse, and OpenAI/Anthropic wire builders that consume resolved records |
| `identity`                      | Mechanical id utilities: reference resolution against the bundled index, dialects, selection priority, tokenizer families                                |
| `model-thinking`                | Runtime thinking helpers (`getSupportedEfforts`, effort clamping/mapping, wire-id routing) over resolved model records                                   |
| `model-manager` / `model-cache` | Runtime model registry with discovery refresh and on-disk caching                                           |
| `wire`                          | Wire-level helpers: Codex, Gemini headers, GitHub Copilot                                                   |
| `effort`                        | Reasoning-effort level definitions                                                                          |

Import from subpaths (`@oh-my-pi/pi-catalog/<module>`) or the root barrel.

## models.json and rules.json are generated

Never edit `src/models.json` or `src/compat/rules.json` by hand. `models.json` is produced from upstream sources (stencil.so, provider catalog discovery, OpenCode docs) by `scripts/generate-models.ts`; `rules.json` is compiled from the KDL tree in `src/compat/rules/`. Regenerate with:

```sh
bun run gen:compat   # src/compat/rules/**/*.kdl -> src/compat/rules.json
bun run gen:models   # upstream sources + rules -> src/models.json
```

Model- or provider-conditional policy (identity, effort ladders, wire quirks, modality/limit/pricing corrections, API routing, roster exclusions) lives in the KDL tree — see `src/compat/rules/README.md` for the grammar and axis vocabulary. TypeScript changes are only for transport mechanics: provider entries in `provider-models/descriptors.ts`, discovery/request plumbing in `provider-models/openai-compat.ts`, and generator wiring in `scripts/generate-models.ts`. Commit `rules.json` (and a rebaked `models.json` when values change) alongside the `.kdl` edit.

## Install

```sh
bun add @oh-my-pi/pi-catalog
```

Ships TypeScript source directly (no build step); requires Bun ≥ 1.3.14.

## References

- [Monorepo README](https://github.com/can1357/oh-my-pi#readme)
- [CHANGELOG](./CHANGELOG.md)
