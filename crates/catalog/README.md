# omp-catalog

`omp-catalog` defines the allocation-conscious, serializable vocabulary shared by OMP's inference catalog compiler and runtime. It keeps providers, routes, codecs, models, accounts, and opaque wire model identifiers structurally separate.

The crate contains facts rather than executable provider behavior. Router-facing `PolicyModel` values expose capabilities and policy identifiers but never raw wire model identifiers; only codec-facing `WireTarget` values carry those identifiers. Unknown capability evidence remains distinct from explicit lack of support.

## Refreshing the checked-in catalog

The runtime loads `data/catalog.postcard`, compiled offline from checked-in sources: `fixtures/llm-oracle/catalog/{providers.toml,models.json.zst,oauth.toml}`, the policy fixtures, and the KDL cascade in `compat/`. `data/sources.lock.json` pins the SHA-256 of every source and `build.rs` refuses a snapshot compiled from different bytes.

- Provider entries (endpoint, auth, discovery, facets) are data in `providers.toml`; a new provider needs code only when its wire behavior is genuinely new.
- The model roster is imported from pi's generated `models.json` by `scripts/import_v1_models.py` (`just catalog-import-v1 <models.json>`); the rewrite rules and every deliberately dropped field live in that script.
- The importer reads pi's older provider-keyed map and its compact `version: 1` catalog alike. `just catalog-import-v1 <models.json> <provider,provider>` imports only the named providers and keeps every other provider's rows, so adding a provider does not rewrite the whole roster.
- `just catalog-snapshot` relocks the sources and regenerates the postcard; commit both files with the source change.
- Host-facing per-model facts (service-tier family, snapcompact frame geometry) are `compat/` rule axes compiled into `ModelSpec`, never model-id predicates in host code. See `compat/README.md`.
