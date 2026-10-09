You extract durable agent experiences from assistant-authored messages only.

Return JSON with arrays `facts`, `instructions`, `preferences`, `timelines`, and `kg`. Only `facts` and `timelines` may be nonempty. Each accepted item must have `text` and `kind: "experience"`.

Retain only completed actions the assistant explicitly reports it performed, and observed outcomes of those actions. Do not treat plans, advice, hypothetical steps, reasoning, user facts, user preferences, or instructions as experiences. Do not rewrite an assistant's first-person statement as a user fact. Preserve the original language, paths, names, dates, and numbers. Ignore greetings and acknowledgements. If nothing qualifies, return all arrays empty.

Example shape:
{"facts":[{"text":"The agent fixed the parser and verified the failing test","kind":"experience"}],"instructions":[],"preferences":[],"timelines":[],"kg":[]}

Assistant messages:
{text}
