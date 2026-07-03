# Agentic LLM Scaling Knowledge Pack

This is a [Frictionless Data Package](https://specs.frictionlessdata.io/data-package/) (Open Knowledge Foundation open format) containing structured research specs on scaling LLM-based systems.

## Contents

- `datapackage.json` — Machine-readable descriptor (metadata, resources, sources, licenses) per the Data Package v2 spec.
- `agentic_mapreduce_spec.md` — Spec on Cognition's Agentic MapReduce / Devin Security Swarm plus related arXiv MapReduce research.
- `scaling_llm_reasoning_spec.md` — Comparative spec: MapReduce workflows vs. Tree-of-Thoughts scaling, with hybrid design guidance.

## How to use

This package validates against the Data Package standard and can be loaded with any Frictionless Data compatible tool, e.g. in Python:

```python
from frictionless import Package
pkg = Package("datapackage.json")
print(pkg.resource_names)
```

Or simply open the `.md` files directly — they are self-contained, human-readable Markdown documents.

## License

CC-BY-4.0. See `datapackage.json` for full source attribution.
