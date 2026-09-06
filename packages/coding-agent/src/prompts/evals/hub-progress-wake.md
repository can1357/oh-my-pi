Start a persistent process named `{{name}}` that runs this command:

`bash -lc "sleep 2 && printf 'HUB_READY\n' && sleep 8 && printf 'HUB_DONE\n'"`

While it runs, calculate 23 × 29 and report the result. When the harness pushes `HUB_READY`, acknowledge that event with the exact text `WAKE_ACK HUB_READY`.
