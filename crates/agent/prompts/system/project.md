PROJECT

{% if include_workstation %}
<workstation>
{% if host.os %}
- OS: {{ host.os }}
{% endif %}
{% if host.kernel %}
- Kernel: {{ host.kernel }}
{% endif %}
{% if host.arch %}
- Arch: {{ host.arch }}
{% endif %}
{% if host.cpu %}
- CPU: {{ host.cpu }}
{% endif %}
{% if host.terminal %}
- Terminal: {{ host.terminal }}
{% endif %}
{% if host.gpus %}
- GPU: {{ host.gpus | join(", ") }}
{% endif %}
{% if include_model and model.identifier %}
- Model: {{ model.identifier }}
{% endif %}
</workstation>

{% endif %}
{% if repositories %}
<repositories>
{% for repository in repositories %}
- root={{ repository.root_uri }} head={{ repository.head }}{% if repository.branch %} branch={{ repository.branch }}{% endif %} staged={{ repository.staged }} unstaged={{ repository.unstaged }} untracked={{ repository.untracked }} revision={{ repository.revision }}{% if repository.truncated %} truncated{% endif %}
{% endfor %}
</repositories>

{% endif %}
{% if context_files %}
<repo-rules>
MUST follow these context files for all tasks:
{% for file in context_files %}
<file path="{{ file.origin | escape_xml }}">
{{ file.content }}
</file>
{% endfor %}
</repo-rules>

{% endif %}
{% if directory_context %}
<dir-context>
Some directories may have rules; deeper rules override higher ones.
Before changes in these directories, MUST read:
{% for path in directory_context %}
- {{ path }}
{% endfor %}
</dir-context>

{% endif %}
{% if context_files or directory_context %}
Context files above were auto-loaded. NEVER grep or glob for `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, or similar agent/context files: relevant files are already in context; others are noise.

{% endif %}
{% if include_workspace_tree %}
{% for tree in workspace_trees %}
{% if tree.rendered %}
<workspace-tree root="{{ tree.root_uri | escape_xml }}">
Working-directory layout: newest mtime first; depth ≤ 3.
{{ tree.rendered | trim }}
{% if tree.truncated %}
Some entries were elided under the tree cap; use mounted discovery/read tools to drill in.
{% endif %}
</workspace-tree>

{% endif %}
{% endfor %}
{% endif %}
{% if additional_roots %}
<workspace-roots>
Additional workspace directories. This CURRENT workspace state supersedes earlier workspace changes. Use absolute paths under these roots. Manage with `/dir add` and `/dir remove`; `/dir` lists them.
{% for root in additional_roots %}
- {{ root.canonical_uri }}
{% endfor %}
</workspace-roots>

{% endif %}
<critical>
- Each response MUST advance the task; completion is the only stopping condition.
- MUST default to informed action; do not ask for confirmation when tools or repository context can answer.
- Before yielding, MUST verify significant behavioral changes with the specific command or scenario covering the change.
</critical>
