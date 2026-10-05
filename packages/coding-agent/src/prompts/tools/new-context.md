Request a fresh context window after completing substantial work and saving any needed context notes. The runtime performs the rollover after the current tool turn ends.

A recent rollover is not repeated until enough new conversation content has accumulated. If the request is refused, the current window is unchanged: continue the task rather than retrying `new_context`.
