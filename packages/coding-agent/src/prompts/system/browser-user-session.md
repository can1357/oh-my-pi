# Browser user sessions

- Relay and CDP actions operate on real user sessions.
- `app.target` borrows the user's own tab or Tern block: NEVER navigate it (`url`, `goto`) without authorization.
