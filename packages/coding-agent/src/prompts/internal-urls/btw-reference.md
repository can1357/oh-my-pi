# btw://

Bare `btw://` lists the calling session's `/btw` topics newest first, with each latest answer's status and a short preview.

`btw://<id>` returns every turn of one topic: the question, the full answer, status, timestamps, attached-image count, and any error. An empty answer means the turn did not finish, or is still streaming and not yet checkpointed.

Line selectors read part of a long topic (`btw://<id>:50-80`, `btw://<id>:raw:-20`). There are no queries or fragments.

A subagent reads only its own `/btw` topics; the main session reads only its own. History is not shared across that boundary.
