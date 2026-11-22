Error: a <fieldset> holds radios that each carry a different `name`, so each is a group of its own:
{{#each fieldsets}}
- {{#if legend}}<fieldset> "{{legend}}"{{else}}An untitled <fieldset>{{/if}}: {{join names ", "}}
{{/each}}

A preselected radio of one group is submitted together with the user's pick in another, so the answer holds two values for one question. Give every option of a question the same `name` with its own `value`:

```html
<fieldset>
  <legend>Sharing</legend>
  <label><input type="radio" name="sources" value="common" checked> Common location only</label>
  <label><input type="radio" name="sources" value="personal"> Include personal installations</label>
</fieldset>
```

Questions that really are separate get a <fieldset> each. Then call ask again.
