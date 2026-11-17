# S4 hashing experiment: test-only SHA-256 optimization

Measured on 2026-11-16 against unchanged `omp-core` source from `omp2` base
`bf873e3f53b4bf539cf77563fd67b9d52c540381`. This experiment explains an
unoptimized dependency bottleneck observed while validating S4. It measures
in-memory hashing, not verification throughput or defect detection.

The [program](experiments/hash_throughput.rs) uses the existing
`omp_core::Hash32` streaming API. It hashes a 16-MiB buffer containing byte
`0x5a` four times, either in four whole-buffer updates or in 64-KiB updates
matching the native input inventory's read-buffer size. Allocation precedes
the timer. The digest is printed and passed through `black_box`.

## Executed comparison

The isolated temporary Cargo project used LLVM, `opt-level = 0`, `debug = 0`
and `incremental = false`. The second variant changed only the `sha2`
dependency's optimization level to 3. `omp-core`, `digest` and the benchmark
remained unoptimized. Both used `sha2 0.10.9`, the repository's `asm` feature,
`digest 0.10.7`, `block-buffer 0.10.4` and `crypto-common 0.1.7`.

Host: `x86_64-unknown-linux-gnu`, rustc `1.99.0-nightly`
(`1a98b1e135b254f209c67d447b6d8bcd56a859e0`), LLVM `23.1.0`.
The container's `cpu.max` was `200000 100000`. Other task work could contend
for these CPUs; this is one environment, not a hardware survey.

Three samples per update shape/profile were executed after building each
variant. [Raw stdout, durations and environment facts](experiments/hash-throughput.raw.json)
are committed beside the program.

| Update shape | Baseline median | Only `sha2` optimized median | Median ratio |
| --- | ---: | ---: | ---: |
| 16 MiB | 2.254869297 s | 0.039200670 s | 57.52× |
| 64 KiB | 2.235308787 s | 0.040651777 s | 54.99× |

All twelve recorded samples returned the same digest:

```text
103f23a15401a701b73587902f16e3b5b3bf38a039d5c94b675a9a8e84dbd5b5
```

A separate Python `hashlib.sha256` calculation over the same four buffers
returned that digest. Initial exploratory whole-buffer runs, before adding
the chunk-selection argument, took 2.151601898 s and 0.038939767 s; the table
uses only the repeated runs from the committed program.

This supports the narrow test-profile decision to optimize `sha2` rather than
change hashing algorithms or weaken byte inventories. The repository change is
`[profile.test.package.sha2] opt-level = 3`; it retains the homogeneous LLVM
test backend. This isolated experiment used a `dev` profile outside the
repository to reproduce its unoptimized LLVM execution without replacing the
repository's profiles or lockfile. It is not an exact build of the repository's
full test profile.

## Reproduction

The executed task paths were `/tmp/omp2-s4-hash-bench` and the separate
`/dev/shm/omp2-s4-hash-bench-target`, which stayed below 200 MiB. No repository
target directory was used. The following recreates the same inputs outside
the repository; use the pinned toolchain and an already populated Cargo cache
for `--offline`.

```sh
research_repo="$(pwd)"
research_tmp="$(mktemp -d)"
mkdir -p "$research_tmp/src"
cp "$research_repo/docs/research/omp2-hybrid-verification/experiments/hash_throughput.rs" "$research_tmp/src/main.rs"
cat > "$research_tmp/Cargo.toml" <<EOF
[package]
name = "omp2-s4-hash-bench"
version = "0.0.0"
edition = "2024"
[dependencies]
omp-core = { path = "$research_repo/crates/core" }
[profile.dev]
opt-level = 0
debug = 0
incremental = false
EOF
export CARGO_TARGET_DIR="$research_tmp/target"
cd "$research_tmp"
cargo +nightly-2026-08-08 build --manifest-path "$research_tmp/Cargo.toml" --offline
for mode in "" "--chunked"; do
  for run in 1 2 3; do
    "$CARGO_TARGET_DIR/debug/omp2-s4-hash-bench" $mode
  done
done
cargo +nightly-2026-08-08 build --manifest-path "$research_tmp/Cargo.toml" --offline \
  --config 'profile.dev.package.sha2.opt-level=3'
for mode in "" "--chunked"; do
  for run in 1 2 3; do
    "$CARGO_TARGET_DIR/debug/omp2-s4-hash-bench" $mode
  done
done
```

The isolated project resolves its own temporary lockfile. Record the resolved
dependency versions when repeating the experiment; the measured versions are
in the raw JSON. Neither that temporary manifest nor its lockfile is added to
the repository. Original build/run logs and repetitions were recorded under
`/tmp/omp2-s4-hash-bench-*.txt`; the committed JSON preserves the measurement
stdout, while those local temporary log paths are not durable artifacts.

## Limits

This excludes filesystem traversal, reads, inode checks, sandbox setup, process
execution, compilation, test execution, evidence publication and final source
fences. A roughly 55× improvement in this hashing loop is **not** a claim of a
55× verifier speedup. It provides no LLM token/cost measurement, defect recall,
reranking result, Apple Silicon result or 16-GB Mac performance result.
Source/dependency admission must remain byte-complete regardless of timing.
