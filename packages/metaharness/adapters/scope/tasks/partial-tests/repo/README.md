# notes-cli

Plain-text notes in a directory (`$NOTES_DIR`, default `./notes`).

```sh
bun src/cli.ts <command> [args]
```

| command | does |
|---|---|
| `init` | creates the notes directory and its index |
| `add <name> <text...>` | creates a note |
| `remove <name>` | deletes a note and its tags |
| `rename <from> <to>` | renames a note, keeping its tags |
| `archive <name>` | moves a note into `archive/` |
| `restore <name>` | moves an archived note back |
| `tag <name> <tag>` | tags a note |
| `clean` | deletes `*.tmp` and `*.bak` files |
| `import <dir>` | copies notes from another directory |
| `export <file>` | writes every note into one file |
| `list` | lists notes with their tags |
