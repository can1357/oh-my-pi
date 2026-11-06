# Fatal-site matrix regeneration

This chain generates `crates/pi-shell/tests/fatal-site-matrix.json`, the
regression corpus for fatal-error status handling. The in-crate test
`the_site_matrix_covers_every_variant_of_the_model` compares the fixture's
recorded `Opcode`, `DeclareKind`, `JumpCode` and `LandingCatch` lists with the
current Rust enums. The integration test `fatal_site_matrix.rs` runs the
selected shell programs and checks their output and status.

## Prerequisites

- Python 3.9 or later, with only the standard library.
- Bun on `PATH`, or an executable supplied with `--bun`.
- **Bash 5.2.21 and Bash 5.3.0**, as two executable builds. Both are live oracle
  columns: every generated program runs separately under each version with
  `--noprofile --norc -c`. The measurement script checks the full version,
  including patch level. It does not accept another 5.2 or 5.3 release.
  The emitter uses Bash 5.3.0's measured output and status only when Bash
  5.2.21 agrees on the selected row; it refuses a disagreement rather than
  guessing which answer to commit. Measurements retain disagreements on
  other rows and report their count.
- A built native addon in each selected repository tree. Install repository
  dependencies with `bun install`, then run
  `bun run --cwd packages/natives build` from each tree's root. Use the build
  prerequisites documented in `packages/natives/README.md`. The native loader
  selects the platform-specific addon; the runner refuses one loaded from
  outside the requested tree.
- The usual Unix commands on `PATH`, including `bash`, `cat` and `echo`.
  Some generated programs explicitly invoke `bash`; those nested invocations
  use `PATH`, unchanged from the original measurement. Keep Bash 5.2.21 as
  `bash` on `PATH` to reproduce that environment. `--bash-52` and `--bash-53`
  select the outer oracle processes, not these nested invocations.

`run-batch.ts` is included beside the three Python scripts. It creates a fresh
native `Shell` per case but uses one Bun process per tree to avoid thousands
of startups. Including it makes the chain runnable without an external audit
harness. It retains the check that the loaded addon belongs to the selected
tree. `--runner` can select an explicit alternative; none is required.

## Run the three stages

Run from the repository root. Set `BASH_53` to your Bash 5.3.0 executable path,
ensure `bash` on `PATH` is Bash 5.2.21, and create an empty scratch directory
named `.fatal-site-matrix`. Then run these three commands in order:

```sh
python3 crates/pi-shell/scripts/fatal-site-matrix/gen-sites.py \
  . .fatal-site-matrix/sites.json

python3 crates/pi-shell/scripts/fatal-site-matrix/measure-sites.py \
  .fatal-site-matrix/sites.json .fatal-site-matrix/measured.json \
  --main-tree . --head-tree . --bash-52 bash --bash-53 "$BASH_53" \
  --bun bun --runner crates/pi-shell/scripts/fatal-site-matrix/run-batch.ts \
  --tmp .fatal-site-matrix

python3 crates/pi-shell/scripts/fatal-site-matrix/emit-fixture.py \
  .fatal-site-matrix/sites.json .fatal-site-matrix/measured.json \
  crates/pi-shell/tests/fatal-site-matrix.json
```

The example explicitly measures the current checkout for both native columns.
For a comparison with a different revision, set `--main-tree` to a separate,
built baseline checkout. Neither engine column supplies expected fixture
values; both are independent live runs used for the mismatch summary. No
baseline revision or output is inferred when a tree is missing.

## Inputs, outputs and options

- `gen-sites.py TREE OUTPUT`: reads the four enum declarations under
  `TREE/crates/pi-shell/src/bash/` (`ir/mod.rs`, `vm/builtins/vars.rs`,
  `vm/exec.rs`, `vm/proc.rs`). Writes `OUTPUT` with enum lists, sample
  definitions and the full cross-product of constructs, error raisers, catch
  contexts and prior statuses. Sample definitions live in this script.
- `measure-sites.py SITES OUTPUT --main-tree TREE --bash-53 EXECUTABLE`:
  reads the generated JSON and writes one row per program, with `out` and
  `rc` for `5.2`, `5.3`, `main` and `head`. `--head-tree` defaults to the
  repository containing the script; `--main-tree` is required. `--bash-52`
  defaults to `bash` on `PATH`; `--bash-53` is required. `--bun` defaults to
  `bun` on `PATH`. `--runner` defaults to the adjacent `run-batch.ts`.
  `--tmp` selects a scratch parent; otherwise Python uses its system temporary
  directory, honoring `TMPDIR`. Each run creates and removes its own scratch
  subdirectory containing case JSON, result JSON Lines and separate working
  directories for each column. Missing executables, wrong Bash versions,
  missing addons, failed batches, timeouts and incomplete columns fail
  non-zero rather than copying an answer from another column. Non-zero shell
  statuses are normal measurements, not batch failures.
- `emit-fixture.py SITES MEASURED OUTPUT`: reads the generated and measured
  JSON, selects the regression rows by axis and writes `OUTPUT` with enum
  lists, row identifiers, axis labels, programs, expected output and expected
  status. A missing row or unusable Bash column, or disagreement between the
  two Bash columns on a selected row, fails before it writes the fixture.
- `run-batch.ts TREE`: called by the measurement script with `CASE_FILE`
  (input JSON), `RESULT_FILE` (output JSON Lines), `CASE_CWD` (case working
  directory) and `TMPDIR` (scratch directory). No private runner is needed.

All paths supplied on the command line are relative to the calling directory
or absolute paths chosen by the caller. Every Python script supports `--help`.
The sample generation, row selection and expected-output format are unchanged.

## When the variant-list gate fails

1. Inspect the new enum variant and decide which shell program exercises it.
   For an `Opcode`, add or adjust a `CONSTRUCTS` sample. For `DeclareKind`, add
   its declaration forms in `decl_forms` (generation refuses an unknown kind).
   For `JumpCode`, update `RAISERS` and its contexts. For `LandingCatch`, update
   `CONTEXTS`. Update the emitter's axis selection if the new sample needs a
   different selection rule. Recording a new name alone does not establish
   behavioral coverage.
2. Rebuild the measured native addon or addons, then run all three commands
   above. If the two Bash versions disagree on a selected row, investigate
   the program and oracle behavior; do not hand-edit an expected result or
   replace a missing column with another column's output.
3. Review and commit the generated fixture with the sample changes. Run the
   variant-list gate and the `fatal_site_matrix` regression test through the
   repository's Rust test workflow (`bun run test:rs`). The gate remains in
   place; do not remove it or hand-edit the recorded variant lists.

The full cross-product is measurement input, not the committed corpus. The
selected regression rows do not prove every possible shell program correct.
Remove the scratch directory after reviewing the generated output; only the
fixture and any intentional script changes belong in the commit.
