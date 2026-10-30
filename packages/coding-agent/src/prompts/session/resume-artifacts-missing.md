{{#if sourceChanged}}
The artifacts of session `{{sessionId}}` did not reach this fork: while they were being copied, `{{source}}` stopped holding that session, so the copy was discarded rather than inherited. Nothing of the session that took that path was kept here, and nothing already in this conversation was removed. The originals are not at `{{source}}` — a different session's journal is there now. If they survive anywhere, it is beside session `{{sessionId}}`'s own journal, wherever that was moved to.
{{else}}
The artifacts of session `{{sessionId}}` did not reach this fork: the copy could not be completed, so it was discarded rather than half-inherited. Nothing already in this conversation was removed, and the originals are untouched where they were, beside session `{{sessionId}}`'s own journal at `{{source}}`.
{{/if}}
{{#if hasIds}}
`artifact://0` through `artifact://{{reservedThroughId}}`, which this transcript refers to, have no file here. Those identifiers stay reserved for this session and anything forked from it, so nothing written from now on can take one of them and answer in their place.
{{/if}}
