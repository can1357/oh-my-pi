You are in the Linux VM. Do not write secrets here.

Install omp Grok Bot auth on the user’s host only (Mac via local-exec / registered machine). Read `GROKBOT_RENEWAL_CREDENTIAL` or `SAND_INFERENCE_RENEWAL_CREDENTIAL`, and `GROKBOT_MACHINE_ID`, from env (or the live host-main process). Never print the values.

Write `{{secretsPath}}` on the host with only those two keys. `chmod 600`. That path is omp’s resolved agent secrets file (profile / `PI_CODING_AGENT_DIR` / XDG aware) — do not invent a different directory.

Report host path, key names, mode. If the host is unreachable, stop. Do not fall back to the VM, `/tmp`, or chat.

Press Enter after the host secrets file exists.
