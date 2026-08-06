# Catalog Development Rules

- Never edit `src/models.json`; fix resolver/descriptors, `generate-models.ts`, or `model-thinking.ts`, then run `bun run generate-models` from this package.
- Test resolver and descriptor behavior, not bundled generated JSON.
