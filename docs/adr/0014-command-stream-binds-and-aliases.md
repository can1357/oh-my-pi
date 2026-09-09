# 0014. Binds, toggles, aliases, and profiles ride the command stream

Status: accepted
Date: 2026-09-02
Area: control-plane

## Context

Every input pattern the harness needed — keybindings, profiles, slash commands, remote
administration — was getting its own schema: a keybindings document with its own defaults table
and action ids, a profile format, a command roster with its own alias list, an RPC surface for
remote control. Each schema had to be loaded, validated, migrated, documented, and kept consistent
with the settings it ultimately mutated. None of them could express the others: a keybinding could
not run a profile, a profile could not set a keybinding, and the journal recorded none of it.

Source Engine has one language for all of it. `bind`, `toggle`, and `alias` are console commands
like any other; cfg files are lists of console commands; the server console and `rcon` accept the
same lines; and the demo file records the variable changes those lines produced. A user who wants
to hide thinking on a key never touches a schema:

```sh
bind ctrl+t "cl_showthinking 0"        # careful — one-way; the second press still writes 0
bind ctrl+t "toggle cl_showthinking"   # toggle also cycles value lists

alias +thinkhud "cl_showthinking 1"    # fires on key-down...
alias -thinkhud "cl_showthinking 0"    # ...and on key-up
bind ctrl+h +thinkhud                  # hold to peek at the thinking stream
```

## Decision

There is ONE command language over the declared variables (0012). `bind`, `toggle`, `alias`,
`exec`, and variable assignment are console commands in that language.

- Keybindings MUST be expressed as `bind <chord> "<command>"`. The keybinding layer is NEVER a
  bespoke schema with its own defaults table; the default bindings are a cfg file of `bind` lines.
- `toggle <var> [values…]` MUST flip a boolean or cycle a value list; users are not expected to
  write one-way assignments for two-state keys.
- `alias <name> "<commands>"` defines a named command; `+name`/`-name` pairs bind to key-down and
  key-up so hold-to-peek behaviors need no dedicated feature.
- cfg files (0013) are sequences of these commands; `exec <file>` runs one. Profiles are cfgs.
- Console input, cfg files, aliases, binds, remote administration, and journal replay MUST all
  parse and execute the same command stream. A remote client sends the same lines a local console
  would; replay re-executes the variable changes those lines produced (0004).

No subsystem MAY introduce a second customization schema for something the command stream can
express.

## Consequences

- Customization stops multiplying formats: one parser, one help system (`help <var|cmd>` from the
  declaration's help string), one migration story.
- Binds, profiles, and remote administration are inspectable as text and diffable in a repo.
- Extensions register commands and variables; they do not register keybinding schemas.
- Prohibited: `keybindings.*` documents with action ids, per-feature "hotkey" tables, and remote
  control paths that mutate settings by a route other than the command stream.
- Cost accepted: a small interpreter (tokenizer, quoting, alias expansion, `+`/`-` semantics, exec
  recursion limits) has to be owned by the engine, and terminal chord decoding must be
  normalized so `bind` strings mean the same thing across keymaps.

## Status in omp

**Implemented.** Primary implementation: `crates/con/src/builtins.rs`. Bindings, toggles, aliases,
actions, exec, `dumpcfg`, and `writecfg` share the con command stream (`dump` writes the
transcript; `crates/chat/src/commands/control.rs`). Pause/resume use the same typed host command
locally and the RPC `pause`/`resume` commands remotely; both journal the same DOM transition.

## References

- The Harness Playbook, "The control plane" → "Profiles and keybindings stay in-band"
- Valve Developer Community, ConVar; Source console commands `bind`, `toggle`, `alias`, `exec`
- 0012 (declared variables), 0013 (cfg files and auto-exec points), 0004 (replay)
- `crates/app/src/keybindings/config.rs`, `crates/app/src/keybindings/mod.rs`,
  `crates/app/src/chat_ui/commands/mod.rs`, `crates/app/src/chat_ui/commands/registry.rs`
