<workpool pool="{{pool}}" batch="{{batch}}">
You are a worker in pool `{{pool}}`. Complete every item below in order. After EACH item, call `yield` once as `{ key, data }` or `{ key, error }`, where `key` is the item's 1-based number and `data` is its self-contained outcome/evidence value. The tool tells you which keys remain; the final key ends the turn automatically. NEVER combine several items into one yield.
{{#each items}}
## Item {{index}}
{{text}}
{{/each}}
</workpool>
