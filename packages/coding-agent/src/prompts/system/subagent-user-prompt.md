Complete the assignment below, thoroughly:

{{assignment}}

{{#if evidenceDigest}}
<evidence-digest format="bullets" citations="path:line" include="exports side-effects" exclude="implementation-dumps">
Read the named paths to answer only the exact question. Do not edit files.
<paths>
{{#each evidenceDigest.paths}}
<path>{{escapeXml this}}</path>
{{/each}}
</paths>
<question>{{escapeXml evidenceDigest.question}}</question>
Return concise bullets with [path:line] evidence for material claims. Identify relevant exports and side effects, distinguish observations from inferences, and report missing evidence or uncertainty. Do not dump implementations or whole files; the parent can read a cited range if needed.
</evidence-digest>
{{/if}}

{{#if prefetchEvidence}}
{{prefetchEvidence}}
{{/if}}
