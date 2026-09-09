# QA rig: e2e-ish spec cases over the real binary

Fast deterministic drives of the production `omp` binary — no `crates/e2e`
harness, no unit-test mocks. A scripted mock model server stands in for the
LLM; everything else (catalog, inference spine, agent loop, envd, tools,
journal, sessions) is production code. Pure-stdlib Python.

## Spine smoke gates

These five executable smoke drivers exercise the production binary rather
than a library-only substitute:

| Driver | Gate proved |
|---|---|
| `scripts/qa/smoke-print.sh` | P0/P1: vendor credentials and the Anthropic, OpenAI, and OpenRouter routes each complete one real `pong` turn. |
| `scripts/qa/smoke-spine.sh` | P3: the journal-first kernel performs a provider turn, journals causal `.oms` entries, resumes it, and renders the replayed session. |
| `scripts/qa/smoke-tools.sh` | P6: the production kernel dispatches the built-in tool matrix and journals settled outcomes. |
| `scripts/qa/smoke-pty.ts` | P5/P7: terminal chat paints welcome/composer, streams a provider turn and tool card, survives resize, and exits with terminal state restored. |
| `scripts/qa/run.py` | Deterministic joined-system regression smoke over the real binary with the scripted model, including extension and transport cases. |

Prerequisites: build `target/debug/omp` (or let the TypeScript PTY driver
build it), run `just setup-python` once, and create
`/tmp/omp-smoke/note.txt` containing `hello from fixture`. The real-provider
driver needs vendor-standard `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and
`OPENROUTER_API_KEY`; the deterministic suite does not. The PTY driver needs
Bun and the repository's `.omp/tools` dependencies. Run the shell scripts
from the repository root.

## Gallery references

`fixtures/gallery/` holds TypeScript-reference captures: collapsed, expanded, and
styled tool cards plus terminal-surface captures. `crates/chat/tests/chrome.rs`
also reads the chrome goldens here. Keep these fixtures; they are comparison
inputs, not disposable build output.

Compare against the current `target/debug/omp` binary:

```sh
OMP_GALLERY_BIN=target/debug/omp uv run --no-project python scripts/qa/gallery-diff.py
OMP_GALLERY_BIN=target/debug/omp uv run --no-project python scripts/qa/gallery-diff.py --expanded
```

Pass tool names to narrow the comparison and `--diff` to show differences.
After an intentional reference change, regenerate selected tool captures from
`/work/pi` (override with `PI_ROOT`) and review the results:

```sh
uv run --no-project python scripts/qa/gallery-ref-regen.py resolve reject
```

## Run the spec suite

```sh
just build
python3 scripts/qa/run.py                  # all cases (serve cases skip without grpcio)
uv run --with "grpcio>=1.83" --with protobuf python3 scripts/qa/run.py   # including gRPC serve cases
python3 scripts/qa/run.py -v -k Lifecycle
```

Cases encode EXPECTED behavior. Ones tagged `Ledger: Cluster …` in their
docstrings assert contracts the QA sweep found broken
(`.plan/qa/SUMMARY.md`); they fail until the corresponding fix lands and are
the acceptance gate for it.

## Pieces

- `harness.py` — `call()` and `raw_call()` reply builders, `MockModel`
  (scripted OpenAI chat-completions server: SSE + non-streaming, request
  capture, exhausted queue → loud 500), and `drive()` (isolated
  `OMP_DATA_DIR` + generated `models.toml` routing provider `mock` at the mock
  server, hard-bounded `omp print --mode json --yolo --model mock`, parsed
  NDJSON events, mock captures, timeout-as-data).
- `fixtures/extensions/<name>/` — production-shaped Python extensions. Each
  fixture owns a complete manifest (`omp.toml` or `extension.json`) plus
  `src/<package>/__init__.py`.
  `extension_fixture()` copies one to a temporary directory for a drive.
- `cases/` — the durable spec suite (stdlib `unittest`).
- `drive.py` — one-shot CLI over `drive()` for exploration:
  ```sh
  python3 scripts/qa/drive.py \
    --call bash '{"command":"echo hi","i":"Echoing"}' \
    --text done --prompt "run it" --keep
  ```
- `mock_model.py` — standalone mock server for non-print surfaces (rpc, acp,
  serve), using the same ordered `--call`/`--text` flags.
- `reply_cli.py` — shared command-line adapter for those typed replies.

## Authoring Python cases

Each reply is either `call(tool, ...)` for one assistant tool call,
`raw_call(tool, raw_arguments)` when the argument document must deliberately
be malformed, or a bare string for assistant text. Pass replies positionally;
`loop=True` repeats them after the last reply.

```python
from harness import call, drive, raw_call

result = drive(
	call("bash", command="echo hi", i="Echoing"),
	"done",
	prompt="run it",
)
malformed = drive(raw_call("bash", '{"command":'), "recovered")
```

Use checked-in extension fixtures rather than embedding extension source in a
case. Dynamic values go through `params`; fixture code reads them with
`from ._qa_params import PARAMS`. Pass the yielded directory through
`extensions`, which makes `drive()` emit `--plugin-dir`.

```python
from harness import call, drive, extension_fixture

with extension_fixture("env/contract") as extension:
	result = drive(call("hello"), "done", extensions=[extension])
```

## Conventions for QA agents

- Drive the REAL binary (`target/debug/omp`); rebuild with
  `just build` after fixes.
- Wrap every drive in a hard timeout; a hung process is itself a finding.
- Deterministic behavior (tool loops, hooks, journal, devices, sessions,
  RPC/ACP surfaces): mock model only.
- Semantic behavior needing a real LLM: OpenRouter
  `inclusionai/ling-3.0-flash` with `OMP_OPENROUTER_API_KEY` (source:
  `OPENROUTER_API_KEY` in `~/.env`).
- Multi-turn / interactive surfaces: `omp rpc` (framed stdio; Python client at
  `crates/py/python/omp_rpc/client.py`) or `omp acp`; the same `OMP_DATA_DIR`
  + `models.toml` wiring applies.
- Findings go to `.plan/qa/<area>.md` with exact reproduction commands;
  promote stable repros into `cases/`.
