Ghidra programs: lifecycle, structured edits, and Python `exec` via PyGhidra.

<instruction>
- Each open program runs as `omp.ghidra.<id>` in the project's `omp ps`, shared across agents and omp processes.
- Programs survive compaction. `list` shows them.
- At most `disassembler.maxOpen` databases (default 4, shared with IDA) stay open; opening another saves and closes the least recently used idle database.
- Databases idle for `disassembler.idleCloseSec` (default 15 min) save and close; reopening resets the `exec` namespace.
- `db` accepts an executable path (`<bin>:@<arch>` for a universal Mach-O slice), an open db id, or its daemon name. Ghidra project paths do not open in place.
- `db` MAY be omitted when exactly one Ghidra database is open.
- `read <binary>` opens or creates the program and shows its overview; `open` does the same without a view.
- First use may download Ghidra, JDK 25, and PyGhidra and build native tools for several minutes. An installation-in-progress error means installation continues; retry later.
- Executables get a managed project under `~/.omp/agent/ghidra-projects/<sha16>-<name>/`; the source binary is never modified.
- Inspect with `read`: `<bin>:<func|0xaddr>` pseudocode, `:<func>:asm`, `:imports`, `:exports`, `:strings`, `:xrefs:<func|0xaddr>`.
- Unavailable native decompiler? Pseudocode views explain the failure and show disassembly.
- Change with `ghidra` actions (`rename`, `comment`, `set_type`, `make_function`) or `exec`.
- `target` is a symbol name or `0x` address; Mach-O names resolve with or without a leading underscore.
- `set_type` takes a C function prototype at a function entry; elsewhere use a type expression such as `char[16]` or `uint32_t *`.
- Preloaded in `exec`: `program` / `currentProgram`, `project`, `flat`, `monitor`, `pyghidra`, `jpype`, and helpers accepting a name, `0x` string, or integer address:
  - `resolve(t)`, `func(t)`, `name_of(ea)`
  - `pseudocode(t)`, `asm(t)` → str
  - `xrefs_to(t)`, `xrefs_from(t)` → dicts; `callers(t)`, `callees(t)` → names
  - `functions(pattern)`, `strings(pattern)`, `imports(pattern)` → tuples (optional case-insensitive regex)
  - `hexdump(t, size=64)`, `read_bytes(t, size)`
  - `rename(t, name)`, `comment(t, text, repeatable=False)`, `set_type(t, decl)`, `make_function(t)`
  - `help_ghidra()` lists them all
- The namespace persists per database and is shared across agents. The last expression's repr follows `=>`.
- `exec` runs in one transaction, rolled back on error or interruption; namespace assignments are not rolled back.
- Default exec timeout is 120 s; cancellation interrupts the request, then kills an unresponsive worker.
</instruction>

<examples>
```
ghidra(action: "rename", db: "./bin/server", target: "FUN_00401000", name: "parse_header")
ghidra(action: "set_type", target: "parse_header", decl: "int parse_header(const unsigned char *buf, unsigned long len)")
ghidra(action: "exec", code: "[(hex(ea), n) for ea, n in functions('crypt|aes')]")
```
</examples>

<critical>
- Dirty databases autosave ~10 s after the worker goes idle; `save` forces it.
- `close` saves by default; `save: false` discards unsaved changes.
- A killed worker (unresponsive timeout, crash, `omp ps kill`) loses changes since the last save; orderly `omp ps stop` saves first.
</critical>
