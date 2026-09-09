{% set open_todos = select("todo item[status!=completed]") %}
{% set active_directors = select("directors director") %}
{% if turn_number or cwd or date or mounts or open_todos or active_directors %}
<session-status>
{% if turn_number %}
turn: {{ turn_number }}
{% endif %}
{% if cwd %}
cwd: {{ cwd }}
{% endif %}
{% if date %}
date: {{ date }}
{% endif %}
{% if mounts %}
mounts:
{% for mount in mounts %}
- {{ mount }}
{% endfor %}
{% endif %}
{% if open_todos %}
todo:
{% for item in open_todos %}
- {{ item.content | default("untitled") }} [{{ item.props?.status | default("pending") }}]
{% endfor %}
{% endif %}
{% if active_directors %}
active directors: {{ count(active_directors) }}
{% endif %}
</session-status>
{% endif %}
