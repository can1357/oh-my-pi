# Catalog Development Rules

- Never edit `src/models.json`; fix resolver/descriptors, `generate-models.ts`, or `model-thinking.ts`, then run `bun run generate-models` from this package.
- Test resolver and descriptor behavior, not bundled generated JSON.
- Treat current `main` descriptors and generator policy as canonical during PR 45 convergence. Port a donor model only when it is absent or demonstrably more current; do not replace generated catalogs wholesale from the donor branch.
- Regenerate deterministically after a descriptor change and verify the focused provider/model contract before accepting the generated diff.
