# Fork maintenance

This checkout is a fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi)
carrying the agent-networking work on top of upstream.

- **Features**: [README-EN.md](README-EN.md) ([Русская версия](README-RU.md),
  [полное руководство](FORK-RU.md))
- **Base**: upstream `main` is merged fast-forward into this fork's `main`;
  all fork work lands there directly (the old `integrate/agents-upgrade`
  branch model is retired — history is linear on `main`).
- **Conventions**: fork invariants for contributors are in
  [AGENTS.md](AGENTS.md#fork-additions-this-fork).
- **Upstream-PR candidates**: ingress guard, session spawn limiter,
  `pi.spawnSubagent`, the A2A module, modern MCP transport (PR #14172 lineage).
- **A2A bridge**: on by default, loopback only. With no `--a2a-name` and an
  empty `a2a.name`, each terminal gets a `<slug(basename(cwd))>-<pid>` auto
  name. Peers auto-register; a reply to an outstanding request is correlated
  automatically through `metadata.inReplyTo` and receives no new reply
  envelope. Discovery is symmetric on demand, and each process owns one
  `<pid>.json` bridge-registry file. See [docs/a2a.md](docs/a2a.md) for the
  wire contract and settings.

## Build & install from this fork

```bash
bun install && bun run build
# dist/omp is a self-contained binary; run it with the stock profile:
./packages/coding-agent/dist/omp --version
```

Never run `bun run setup` on a machine with a production omp install.
