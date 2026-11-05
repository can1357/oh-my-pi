Deliver your final report to the parent agent; this ends the run. Call it exactly once, when the delegated task is done — or when you cannot finish and must report what you have.

`report` is the complete result: findings, the files and commands involved, evidence, and anything the parent needs to act without redoing your work. Plain prose or markdown; no JSON envelope and no report tags.

The parent receives the report framed as model output, not as user text. A second call is rejected: the first report is final.
