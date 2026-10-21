The following skills provide specialized instructions for specific tasks.
{{#if readTool}}Use the read tool to load a skill's file when the task matches its description.{{else if bashTool}}Use bash to load a skill's file when the task matches its description.{{else}}Load a skill's file when the task matches its description.{{/if}}
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.

<available_skills>
{{#each skills}}
  <skill>
    <name>{{name}}</name>
    <description>{{description}}</description>
    <location>{{location}}</location>
  </skill>
{{/each}}
</available_skills>
