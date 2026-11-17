Open, inspect, edit, and script binary analysis databases.

The `dsm` object exists in JavaScript and Python Eval; it is not a standalone tool. `disassembler.backend` selects IDA, Ghidra, or Binary Ninja.

<instruction>
- Bare `read <binary>` shows on-disk Mach-O/ELF/PE metadata only; it never opens an analysis database or downloads a backend.
- Start analysis explicitly with `await dsm.open(path)` or a `read` analysis selector: `binary:overview`, `binary:<func|0xaddr>`, `binary:<func>:asm`, `:imports`, `:exports`, `:strings`, `:xrefs:<func|0xaddr>`.
- Universal Mach-O: host architecture by default; `binary:@<arch>` selects a slice. Without a following analysis view, this still shows metadata only.
- Ghidra may provision Ghidra, a JDK, PyGhidra, and native tools on first analysis. An installation-in-progress error means it continues; retry later.
- `dsm.open(path)` accepts an executable, a universal slice reference (`./binary:@arm64`), an existing IDA `.i64`/`.idb` (IDA active), an existing Binary Ninja `.bndb` (Binary Ninja active), or a portable string returned by `db.handle()`; Ghidra project paths do not open in place.
- Executables are analyzed in managed databases; source binaries are never modified. IDA `.i64`/`.idb` and Binary Ninja `.bndb` files open in place. A database file owned by another backend is rejected; switch `disassembler.backend` to its owner.
- `dsm.list()` returns database descriptors with portable `handle` strings and live reference counts. `dsm.get(id)` attaches to an already-open database; omit `id` only when exactly one is open.
- Every `open` or `get` owns one independent reference. `close()` releases only that reference; the final release closes the database. Child close/disposal cannot close another owner's live reference.
- `db.handle()` returns a printable reference bound to this live database incarnation. Pass that exact string in a child's task/context; the child MUST `await dsm.open(handle)` and close its returned handle in `finally`. Keep the parent's reference until the children finish.
- Portable handles work from any project on the same machine, even when a child's cwd/worktree differs. The selected backend must match; an expired handle never creates or reopens a database.
- Databases appear in `omp ps` labelled `<Backend label> <ref>` (`IDA …`, `Ghidra …`, `Binary Ninja …`); unit ids are UUIDs. Owner references are saved/released on session disposal or conversation/backend change; resumable children retain theirs until explicit close or disposal.
- Handles expose `id`, `backend`, `ref`, `path`, and `info`. Closed references require another `dsm.open(path or handle)` or `dsm.get(id)`.

JavaScript:
```javascript
const db = await dsm.open("./program");
await dsm.list();
const other = await dsm.get(db.id);
await other.close();
print(db.handle());                 // copy this exact string into child context
await db.view("overview");
await db.view("main");             // pseudocode
await db.view("main:asm");
await db.exec("functions('crypt|aes')", { timeout: 120 });
await db.rename("sub_401000", "parse_header");
await db.comment("parse_header", "Validates the frame header", { repeatable: true });
await db.setType("parse_header", "int parse_header(const unsigned char *buf, unsigned long len)");
await db.makeFunction("0x401000");
await db.save();
await db.close({ save: true });
```

Python uses the same methods except `set_type` and `make_function`; options are keyword arguments:
```python
db = await dsm.open("./program")
c = await db.view("main")
result = await db.exec("[(hex(ea), name) for ea, name in functions('crypt|aes')]", timeout=120)
print(result["output"], result["value"], result["error"])
await db.comment("main", "Entry point", repeatable=True)
await db.close(save=True)
```

- `view()` defaults to `overview`; other values use the same suffix grammar as `read`. Reserved view names win over symbols; use an address for a same-named symbol.
- `overview` lists the backend's memory regions as `segments` (sections or blocks, under the backend's names) and, as `entry points`, the program entry plus exported symbols, data included. Its `md5`/`sha256` are the analyzed binary's, not the database file's.
- `exec` always runs Python in the backend worker, even when called from JavaScript Eval. Its result is `{output, value, error}`: captured text, the last expression's Python repr (or null), and a traceback/interrupt message (or null).
- Edits return objects: `rename` → `{ea, old, new}`; `comment` → `{ea}`; `setType`/`set_type` → `{ea, type}` (the applied type as the backend prints it); `makeFunction`/`make_function` → `{ea, name}`; `save` → `{path}`; `close` → null. `ea` is a `0x` string. The same-named `exec` helpers return the same objects.
- The Python namespace persists per database and is shared across agents, not per handle. Reopening after idle-close resets it.
- Every backend preloads helpers accepting a name, `0x` string, or integer address:
  - `resolve(t)`, `func(t)`, `name_of(ea)`
  - `pseudocode(t)`, `asm(t)` → str
  - `xrefs_to(t)`, `xrefs_from(t)` → dicts; `callers(t)`, `callees(t)` → names
  - `functions(pattern)`, `strings(pattern)`, `imports(pattern)` → tuples (optional case-insensitive regex)
  - `hexdump(t, size=64)`, `read_bytes(t, size)`
  - `rename(t, name)`, `comment(t, text, repeatable=False)`, `set_type(t, decl)`, `make_function(t)`
  - `comment` sets an address comment and, at a function start, also the function comment.
- IDA additionally preloads `db` (ida_domain Database), `ida_domain`, `ida_*`, `idautils`; `help_ida()` lists its helpers. `setType`/`set_type` accepts a C declaration.
- Ghidra additionally preloads `program` / `currentProgram`, `project`, `flat`, `monitor`, `pyghidra`, `jpype`; `help_ghidra()` lists its helpers. Types are C prototypes at function entries and type expressions (`char[16]`, `uint32_t *`) elsewhere.
- Binary Ninja additionally preloads `bv` (the BinaryView), `binaryninja`, `wait_analysis()`; `help_binja()` lists its helpers. Types work as for Ghidra: a C prototype at a function entry, a type expression elsewhere. `repeatable` on comments is accepted and ignored. Inside a function an address comment is that function's (`func.get_comment_at(ea)`), not a view comment (`bv.get_comment_at(ea)`). A function, its PLT entry and its import slot share one name: `callers`/`xrefs_to` on the function include calls through the other two.
- Radare2 additionally preloads `r2` / `radare2` (the r2pipe session); `help_radare2()` lists its helpers.
- Default exec timeout is 120 s; an unresponsive worker is killed after cancellation. Ghidra pseudocode falls back to disassembly when its decompiler is unavailable. Radare2 pseudocode tries `pdgj` (r2ghidra) and falls back to `pdcj` (core pseudo-C) without surfacing an error.
- Retained references pin against idle-close and LRU eviction; close every owned handle when done. `disassembler.maxOpen` bounds databases across all backends; unreferenced idle databases may be evicted or closed by `disassembler.idleCloseSec`.
</instruction>

<critical>
- Ghidra exec database changes roll back on error or interruption; Python variables do not. IDA changes made before an exec failure remain.
- Binary Ninja reverts undo-recorded changes when an exec fails or is interrupted; auto-level changes (`define_auto_symbol`) and metadata (`bv.store_metadata`) remain, as do Python variables.
- Binary Ninja exec code MUST wait with `wait_analysis()`; NEVER call `bv.update_analysis_and_wait()` (cannot be interrupted) or `bv.abort_analysis()` (permanently degrades the open database).
- Dirty databases autosave after ~10 s idle; `save()` forces it. `close()` requests saving by default; the final release honors any owner's save request. Unsaved changes are discarded only if every released reference chose `save: false`.
- An `exec` counts as a possible edit: a saving close after one can rewrite the database file even when the code only read. Close with `save: false` after read-only work on a file that must stay byte-identical.
- Orderly `omp ps stop` saves; a crash, forced kill, or unresponsive timeout loses changes since the last save.
</critical>
