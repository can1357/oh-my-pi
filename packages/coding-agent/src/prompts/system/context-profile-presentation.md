<context-profile>
Bare `skill://` lists active skills; `skill://?q=<term>` searches; `skill://<name>` reads instructions.
{{#if xdevTools.length}}
Some enabled tools are mounted as `xd://` devices instead of provider-callable functions:
- `{{toolRefs.read}} xd://` lists a bounded catalog; add `?q=<term>` to search.
- `{{toolRefs.read}} xd://<tool>` returns docs and its JSON parameter schema.
- `{{toolRefs.write}} xd://<tool>` runs it with the JSON args object in `content`.
{{xdevDocs}}
{{/if}}
</context-profile>
