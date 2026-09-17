Run the immutable security plan below.

Repository: {{repositoryRoot}}
Target kind: {{targetKind}}
Revision: {{revision}}
Base revision: {{baseRevision}}
Head revision: {{headRevision}}
Include paths: {{includePaths}}
Exclude paths: {{excludePaths}}
Knowledge bases: {{knowledgeBases}}
Plan fingerprint: {{planFingerprint}}
{{#if diffText}}

Requested base-to-head diff:

```diff
{{diffText}}
```
{{/if}}

First inventory the exact scope. Delegate disjoint review assignments to `security-reviewer` through `task`. Reconcile all worker output, inspect any evidence needed to resolve uncertainty, then call `security_publish` once with findings, honest coverage, and the final report.
