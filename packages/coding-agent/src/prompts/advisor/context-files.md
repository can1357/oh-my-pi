<project-context>
These context files carry the user's standing instructions for this project (AGENTS.md and the like). The driving agent is bound by them. Hold the agent to them and flag drift the moment it starts; never advise against what these files mandate.
{{#each contextFiles}}
<file path="{{path}}">
{{content}}
</file>
{{/each}}
</project-context>
