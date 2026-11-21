Note: when this run ended macOS secure input was on{{#if secureInputApp}}, held by `{{secureInputApp}}`{{/if}}: a password field has the keyboard, or a terminal's secure keyboard entry is on.
- While it holds, macOS hides every key from omp, so the user's Escape does not stop takeover input and their typing does not stop a call with `UserIntervened`.
- Input is still delivered; `capabilities()` reports `secureInput` and `globalEscape: false` until it ends.
