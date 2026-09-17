# Codex Security example report

This fixture is derived from the completed-scan example in the pinned Codex Security plugin.

## Findings

- **High — Unsafe archive extraction can escape the output directory**
  - Rule: `path-traversal.archive-extraction`
  - Location: `src/extract.py:41-44`
