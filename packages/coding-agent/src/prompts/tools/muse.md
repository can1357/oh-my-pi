Delegate one self-contained task to the local Muse Code client (`muse exec --json`).

Muse runs headlessly in its own session with its own tools. It uses the installed client's licensed provider, keeps the client's approval and sandbox defaults, and cannot receive follow-up messages or continue a previous Muse run. Write the whole task in `prompt`, including verification steps and the expected deliverable.

- Muse is rooted at this session's working directory and must not be pointed at another workspace. It does not gain OMP's write or approval grants.
- `max_model_steps` caps the client's model loop. `timeout_seconds` bounds the whole run (default 900).
- The result is Muse's terminal answer plus sanitized usage and task-activity counts. Failed or cancelled subtask records are activity, not run failures; only a missing or non-`completed` run terminal makes the call fail.

Use this tool only when the user asks for Muse delegation. Do not use it as a substitute for normal OMP tools, and do not ask it to bypass approvals, widen its sandbox, or use an unlicensed provider.
