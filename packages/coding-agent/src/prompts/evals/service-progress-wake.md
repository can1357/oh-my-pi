Start a supervised service named `{{name}}` that runs this command:

`bash -lc "sleep 2 && printf 'SERVICE_READY\n' && sleep 8 && printf 'SERVICE_DONE\n'"`

While it runs, calculate 23 × 29 and report the result. When the harness pushes `SERVICE_READY`, acknowledge that event with the exact text `WAKE_ACK SERVICE_READY`.
