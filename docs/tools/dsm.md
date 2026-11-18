# dsm

> Inspect, edit, and script executable analysis databases through IDA Pro or Ghidra from Eval.

## Source

- Eval prelude: `packages/coding-agent/src/disasm/prelude-definition.ts` and `prelude.js` / `prelude.py`.
- Model-facing reference: `packages/coding-agent/src/prompts/tools/dsm.md`.
- Binary metadata and opt-in read views: `packages/coding-agent/src/tools/read-binary.ts` and `packages/coding-agent/src/disasm/metadata.ts`.
- Backend selection and settings: `packages/coding-agent/src/disasm/active.ts` and `settings.ts`.
- Shared database hosts and lifetime: `packages/coding-agent/src/disasm/client.ts`, `host.ts`, and `reference-owner.ts`.

## Availability

- `dsm` is an object in JavaScript and Python Eval, not a standalone `ida` or `ghidra` tool. Read its on-demand reference at `xd://eval/dsm`.
- `disassembler.backend` chooses `auto` (default), `ida`, `ghidra`, or `none`. Auto uses an installed IDA Pro with idalib when available, otherwise Ghidra on supported hosts. `ida` without a detected installation, `ghidra` on an unsupported host, and `none` disable analysis; bare executable reads still show metadata.
- Ghidra may provision Ghidra, a JDK, PyGhidra, and native tools on first analysis. `ida.python` and `ida.installDir` remain IDA-specific interpreter and install-directory overrides, not backend selectors.
- `disassembler.maxOpen` (default 4) caps open databases per project across both backends; an unreferenced, idle database can be evicted to make room. `disassembler.idleCloseSec` (default 900; `0` disables idle close) saves and closes unreferenced idle databases.

## Reading binaries

- `read <binary>` returns on-disk ELF, PE, or Mach-O metadata and opt-in selectors without opening a database or downloading a backend. A bare IDA `.i64`/`.idb` read likewise shows metadata.
- `read <binary>:overview` starts analysis and shows an overview; `:<func|0xaddr>` shows pseudocode, `:<func>:asm` disassembly, and `:imports`, `:exports`, `:strings`, `:xrefs:<func|0xaddr>` select other views. Append line selectors to page generated views.
- For a universal Mach-O, `read <binary>:@<arch>` selects a slice but remains metadata-only until followed by an analysis view such as `:overview`.
- Views are generated immutable text, not edit snapshots. `:raw` bypasses executable views.

## Eval usage

JavaScript:

```js
const db = await dsm.open("./program");
try {
  print(await db.view("overview"));
  print(await db.view("main:asm"));
  const result = await db.exec("functions('crypt|aes')", { timeout: 120 });
  print(result);
  await db.rename("sub_401000", "parse_header");
  await db.save();
} finally {
  await db.close();
}
```

Python Eval exposes the same facade with snake_case `set_type` and `make_function` methods and keyword options (`await db.exec("functions('crypt|aes')", timeout=120)`).

- `dsm.open(path)` accepts an executable, a universal slice reference (`./program:@x86_64`), an existing IDA `.i64`/`.idb`, or a live portable string returned by `db.handle()`. IDA database files open in place; executable analysis uses managed databases and never modifies the source binary. Ghidra project paths do not open in place.
- `dsm.list()` returns open database descriptors; `dsm.get(id)` attaches to one without starting analysis. Omit the id only when exactly one database is open. Each `open` or `get` owns a separate reference; close it in `finally` when done.
- A database exposes `view(view = "overview")`, `exec(code, { timeout })`, `rename(target, name)`, `comment(target, text, { repeatable })`, `setType(target, decl)`, `makeFunction(target)`, `save()`, and `close({ save: true })`. `exec` runs Python in a per-database namespace shared by agents, even from JavaScript Eval; it returns `{ output, value, error }`.
- To share a database with a child agent, keep the parent's reference open, pass `db.handle()` to the child, and have the child call `dsm.open(handle)` and close its own reference. Portable handles expire when the originating database closes and must use the same backend; they never reopen a database.

## Persistence and failures

- Databases run as `omp.ida.<id>` or `omp.ghidra.<id>` hosts visible through `omp ps`. Dirty databases autosave after roughly 10 seconds idle; `save()` forces a save and `close()` requests a save by default. Changes since the last save can be lost on crashes, forced kills, or an unresponsive timeout.
- Retained references prevent idle-close and eviction. The final release closes the database; session disposal or a backend/conversation change releases that session's references. Reopening after idle-close resets the persistent Python `exec` namespace.
- An unavailable backend refuses explicit analysis with guidance to select `disassembler.backend`; bare reads remain metadata-only. A database limit with all hosts busy or retained requires releasing a reference or raising `disassembler.maxOpen`.
- Ghidra `exec` rolls back database edits on error or interruption; IDA edits made before an `exec` failure remain.
