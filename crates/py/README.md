# omp-py

`omp-py` embeds CPython 3.14 in a Rust process. Desktop builds use a statically
linked, free-threaded runtime with a frozen standard library. Native Termux
builds link the installed GIL-enabled CPython dynamically and retain isolated
module paths while freezing repository-provided modules and pinned pure-Python
packages.

## Structure

- `src/lib.rs` exposes `Engine` and `Builder`, installs the frozen-module tables, boots CPython in isolated mode, and provides the default site-packages location.
- `build.rs` links the vendored interpreter's native dependencies and packs project modules and bundled packages into frozen-module blobs without network access.
- `python/` contains repository-provided Python modules, including `omp_remote`; `requirements.txt` pins bundled pure-Python packages.
- `scripts/fetch-python.sh` fetches python-build-standalone archives (dev `python/` + release `python-release/`) and generates derived build inputs (`stdlib.bin`, `pyo3-config.txt`, bundled packages); `scripts/pack-pymodules.py` and `scripts/ld64.lld` support the build.
- `src/bin/demo.rs` is the crate's `omp-demo` binary.
- `THIRD-PARTY-NOTICES.txt` records notices for bundled Python packages and is also exposed through `THIRD_PARTY_LICENSES`.

## Philosophy

Keep the interpreter self-contained and deterministic: Python boots once per process in isolated mode, and frozen modules remain available to subinterpreters without relying on a host Python installation or ordinary filesystem imports. The frozen data is stored uncompressed so CPython can point directly into static binary data and the operating system can avoid paging unused modules.

## Building

The crate links a vendored [python-build-standalone](https://github.com/astral-sh/python-build-standalone) CPython that is fetched once, outside cargo:

```sh
scripts/fetch-python.sh /path/to/vendor   # populates /path/to/vendor/python
export PYO3_CONFIG_FILE=/path/to/vendor/python/pyo3-config.txt
cargo build
```

`PYO3_CONFIG_FILE` must be set before cargo runs (environment or a `.cargo/config.toml` `[env]` entry) — it pins both pyo3 and this crate's build script to the same runtime. In this repository the checkout's `.cargo/config.toml` already points it at `vendor/python/pyo3-config.txt`.

On native Termux/aarch64, install Termux's Python 3.14 and run
`OMP_PY_TARGET=aarch64-linux-android scripts/fetch-python.sh`. This generates
`vendor/python-android/pyo3-config.txt` for the system `libpython3.14.so` and
installs only the pinned pure-Python bundle. `just build-android` performs this
setup and selects the Android configuration automatically. Android uses the
`cp314` ABI; it does not claim free-threaded `cp314t` execution.

The deliberate filesystem exception is the authorized site-packages directory, because native extension modules must be loaded from disk. Its default policy processes standard `.pth` metadata (including editable-install paths and executable import lines) and imports `sitecustomize`, while isolated mode continues to exclude ambient global sites and `usercustomize`; embedders can select a narrower `SitePolicy`. Binaries supporting native wheels must export CPython's C API at final link time (for example, with `-Wl,-export_dynamic`); this crate applies the flag to its own binaries, while downstream binaries must apply the equivalent final-link configuration themselves.
