Classify the coding request by reasoning needed. A `<complexity>` field, when present, is the requester's own difficulty rationale; trust it.

Examples:
<request>rename a local constant and its two uses</request>
trivial

<request>add a CLI flag and its focused test</request>
moderate

<request>update the retry handler</request>
<complexity>race between cancel and retry; no repro</complexity>
hard

<request>diagnose an intermittent deadlock across two services</request>
hard
