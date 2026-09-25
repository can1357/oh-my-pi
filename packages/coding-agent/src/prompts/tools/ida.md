IDA Pro (idalib) databases: lifecycle, structured edits, and Python `exec` inside the database.

<instruction>
- Each open DB runs as an `omp.ida.<id>` daemon in the project's `omp ps`, shared by every agent, subagent, and omp process in the project; DBs survive compaction; at most `ida.maxOpen` (default 4) stay open: opening another saves and closes the least recently used idle DB, and DBs idle for `ida.idleCloseSec` (default 15 min) are saved and closed. Reopening is fast but resets the `exec` namespace. `list` shows them. `db` accepts a binary or `.i64`/`.idb` path (`<bin>:@<arch>` for a universal Mach-O slice), an open db id, or its daemon name, and MAY be omitted when exactly one DB is open.
- `read <binary>` opens or creates the DB and shows the overview; `open` does the same without a view. Executables get a store IDB under `~/.omp/agent/idbs/<sha16>-<name>/` (the binary itself is never modified); `.i64`/`.idb` files open in place.
- Look with `read` views (`<bin>:<func|0xaddr>` pseudocode, `:<func>:asm`, `:imports`, `:exports`, `:strings`, `:xrefs:<func|0xaddr>`); change with `ida` (`rename`, `comment`, `set_type`, `make_function`) or `exec`.
- `target` is a symbol name or `0x` address; `_`-prefixed Mach-O names resolve without the underscore.
- `exec` runs Python in the DB's worker. Preloaded: `db` (ida_domain Database), `ida_domain`, `ida_*` modules, `idautils`, and helpers taking a name, `0x` string, or int ea:
  - `resolve(t)`, `func(t)`, `name_of(ea)`
  - `pseudocode(t)`, `asm(t)` → str
  - `xrefs_to(t)`, `xrefs_from(t)` → dicts; `callers(t)`, `callees(t)` → names
  - `functions(pattern)`, `strings(pattern)`, `imports(pattern)` → tuples (case-insensitive regex, optional)
  - `hexdump(t, size=64)`, `read_bytes(t, size)`
  - `rename(t, name)`, `comment(t, text, repeatable=False)`, `set_type(t, decl)`, `make_function(t)`
  - `help_ida()` lists them all
- The `exec` namespace persists per DB and is shared by all agents; the last expression's repr is returned after `=>`. Default timeout 120 s: SIGINT first, then the worker is killed.
</instruction>

<examples>
```
ida(action: "rename", db: "./bin/server", target: "sub_401000", name: "parse_header")
ida(action: "set_type", target: "parse_header", decl: "int __fastcall parse_header(const uint8_t *buf, size_t len)")
ida(action: "exec", code: "[(hex(ea), n) for ea, n in functions('crypt|aes')]")
```
</examples>

<critical>
- Dirty DBs autosave ~10 s after the worker goes idle; `save` forces it. A killed worker (timeout that ignores SIGINT, crash, `omp ps kill`) loses only changes made since the last save.
</critical>
