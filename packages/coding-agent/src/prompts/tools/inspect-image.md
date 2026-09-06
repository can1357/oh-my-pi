Inspects image files via a vision-capable model; returns compact text analysis.

<instruction>
- Use for image understanding: OCR, UI/screenshot debugging, scene/object questions.
- `path`: local image-file path | local `.svg`/`.svgz` path with `:img` | `Image #N` attachment label | `attachment://N` URI.
- `question` specific: inspection target; constraints (e.g. "quote visible text verbatim", "only report confirmed findings"); output format (bullets/table/JSON/short answer).
- Ground `question` in observable evidence; request uncertainty for unclear details.
- For image analysis, use over `read`.
</instruction>

<output>
- Vision-model text-only analysis.
- Tool output: no image content blocks.
</output>

<critical>
- Settings-blocked image submission → actionable error.
- Configured model lacks image input → configure a vision-capable model role before retrying.
</critical>
