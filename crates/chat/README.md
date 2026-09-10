# omp-chat

`omp-chat` is the projection-only interactive chat actor over the OMP session patch stream. It folds `Session::subscribe()` events into the terminal surface: transcript projection, composer with autocomplete and the slash-command registry, overlays, notices, status lines, and desktop notifications. It is consumed by `omp-app`; controller state and agent/provider policy live in `omp-agent` and `omp-ai`, never here.

The crate is deliberately stateless about the session: everything durable is read from the session DOM, and observer-local state — composer drafts, editor round trips, overlay placement, even the durable-but-chat-local prompt history — stays out of the DOM entirely. Each transcript block is a mutable slot that stays on screen and retires into native scrollback only under row pressure, oldest first, once the DOM marks it done (ADR 0034), so rendering remains a projection of patches and never a second session model.
