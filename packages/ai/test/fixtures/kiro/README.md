# Sanitized Kiro stream fixtures

These fixtures preserve only the Kiro runtime EventStream fields needed to exercise the production decoder and event normalizer. The event names and payload keys are derived from the retained local Kiro evidence and the phase handoff; request IDs, visible text, and metric values are synthetic.

The frame bytes are generated independently with valid AWS EventStream CRCs. Raw `.mitm` captures and the analysis scripts remain outside the repository. These fixtures do not claim support for unobserved event semantics, continuation requests, image payloads, or tool-result images.
