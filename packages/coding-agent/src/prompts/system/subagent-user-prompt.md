Complete the assignment below, thoroughly:

{{assignment}}

{{#if evidenceDigest}}
<evidence-digest format="bullets" citations="path:line" include="exports side-effects" exclude="implementation-dumps">
Read the named paths to answer only the exact question. Your enforced tools are read, grep, glob, ast_grep, and yield. Do not edit, execute code, discover extra tools, or spawn tasks.
<paths>
{{#each evidenceDigest.paths}}
<path>{{escapeXml this}}</path>
{{/each}}
</paths>
<question>{{escapeXml evidenceDigest.question}}</question>
Return concise bullets with [path:line] evidence for material claims. Identify relevant exports and side effects, distinguish observations from inferences, and report missing files as cited failures. Do not dump implementations or whole files. Parent output is capped at 8,000 UTF-8 bytes with the full output retained as an artifact; citations are not edit anchors and require bounded re-reading before editing.
</evidence-digest>
{{/if}}

{{#if codeWrite}}
<code-write>
Create exactly one new file using conventions from the local reference. This specification supplements, never replaces, the assignment acceptance checks.
<spec>{{escapeXml codeWrite.spec}}</spec>
<reference>{{escapeXml codeWrite.reference}}</reference>
<target>{{escapeXml codeWrite.target}}</target>
Use native read to inspect the reference, then native write to create the target directly on disk. Your enforced tools are read, write, and yield. Write only the assigned target, once; no existing-file edits, shell, eval, extra files, discovery, or task recursion. Never wrap non-Markdown source in an outer Markdown fence. End with a concise completion; the parent receives only a filesystem-verified integration receipt, never your prose or generated source. Do not claim checks ran unless they actually did.
</code-write>
{{/if}}

{{#if prefetchEvidence}}
{{prefetchEvidence}}
{{/if}}
