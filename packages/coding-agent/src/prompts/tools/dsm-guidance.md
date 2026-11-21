Binary analysis lives in eval's `dsm` namespace; read `help://eval/dsm` before use. Bare executable reads show metadata only.

Sharing a database with a child: pass the string from `db.handle()` in its task/context. The child MUST `await dsm.open(handle)` to retain its own reference, then close its handle in `finally`. Keep the parent's reference until the children finish; NEVER pass a process-local database object or assume its variable exists in a child.
