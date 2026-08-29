//! Demo for the `omp-py` embedded interpreter.
//!
//! Exposes a native Rust primitive (`omp.nth_prime`) to Python, runs a
//! snippet that calls it, spins up concurrent sub-interpreters, and pulls a
//! Python expression's result back into Rust. `--noop` boots and exits, for
//! startup benchmarking.

use std::{env, process};

use omp_py::{
	Engine,
	pyo3::{self, exceptions::PyValueError, ffi::c_str, prelude::*},
};

/// Native primitive exposed to Python: returns the 1-based `n`-th prime.
#[pyfunction]
fn nth_prime(n: u64) -> PyResult<u64> {
	if n == 0 {
		return Err(PyValueError::new_err("n must be >= 1"));
	}
	let mut found = 0u64;
	let mut candidate = 1u64;
	while found < n {
		candidate += 1;
		if (2..=candidate.isqrt()).all(|d| !candidate.is_multiple_of(d)) {
			found += 1;
		}
	}
	Ok(candidate)
}

/// The `omp` module as seen from Python.
#[pymodule(gil_used = false)]
fn omp(m: &Bound<'_, PyModule>) -> PyResult<()> {
	m.add_function(wrap_pyfunction!(nth_prime, m)?)
}

fn main() -> PyResult<()> {
	pyo3::append_to_inittab!(omp);
	let engine = Engine::builder().init().expect("boot python");

	engine.attach(|py| {
		// `--noop`: boot-only mode for startup benchmarking.
		if env::args().nth(1).as_deref() == Some("--noop") {
			return py.run(c_str!("pass"), None, None);
		}

		// Run a snippet that imports and calls the native primitive; the
		// stdlib imports exercise statically linked C extensions and the
		// frozen in-memory stdlib.
		py.run(
			c_str!(
				r#"
import sys, sqlite3, ssl, hashlib, zlib, statistics, omp
print(f"python : {sys.version.split()[0]} (GIL {'on' if sys._is_gil_enabled() else 'off'})")
print(f"stdlib : statistics from {statistics.__spec__.origin!r}; sys.path = {sys.path}")
print(f"builtin: sqlite {sqlite3.sqlite_version}, {ssl.OPENSSL_VERSION.split('(')[0].strip()}, "
      f"sha256 ok = {hashlib.sha256(b'omp').hexdigest()[:8]}")
print(f"snippet: omp.nth_prime(10_000) = {omp.nth_prime(10_000):,}")
try:
    import numpy
    a = numpy.arange(6, dtype=numpy.float64).reshape(2, 3)
    print(f"site   : numpy {numpy.__version__}, (a @ a.T).trace() = {(a @ a.T).trace()}, "
          f"GIL still {'on' if sys._is_gil_enabled() else 'off'}")
except ModuleNotFoundError:
    print(f"site   : numpy not installed — uv pip install "
          f"--python python3.14 --target {sys.path[0]!r} numpy")
"#
			),
			None,
			None,
		)?;

		// Concurrent engines: sub-interpreters with isolated state (the frozen
		// desktop stdlib or Termux filesystem stdlib is available in each).
		py.run(
			c_str!(
				r#"
import threading, time
from concurrent import interpreters

a, b = interpreters.create(), interpreters.create()
a.exec("secret = 42")
try:
    b.exec("secret")
    isolated = "leaked!"
except interpreters.ExecutionFailed:
    isolated = "isolated"

work = "x = 0\nfor i in range(2_000_000):\n    x += i"
t0 = time.perf_counter()
a.exec(work); b.exec(work)
serial = time.perf_counter() - t0
threads = [threading.Thread(target=i.exec, args=(work,)) for i in (a, b)]
t0 = time.perf_counter()
for t in threads: t.start()
for t in threads: t.join()
concurrent = time.perf_counter() - t0
print(f"engines: 2 sub-interpreters ({isolated}); serial {serial*1e3:.0f} ms, "
      f"concurrent {concurrent*1e3:.0f} ms ({serial/concurrent:.2f}x)")
"#
			),
			None,
			None,
		)?;

		// Bundled remote functions: loopback worker on a socketpair with an
		// HMAC handshake, exercising every code-shipping mode — bundled
		// cloudpickle (closure), marshal (self-contained fn), module source
		// (real file) — plus both error paths: a loadable exception re-raised
		// with the remote traceback chained on, and a worker-only exception
		// type degrading to the structured RemoteError stand-in.
		py.run(
			c_str!(
				r#"
import os, socket, sys, tempfile, threading
from concurrent import interpreters
import omp_remote

# Worker lives in a sub-interpreter: its own sys.modules, so worker-only
# types (synthetic source modules) are genuinely unloadable client-side.
client, server = socket.socketpair()
worker = interpreters.create()
worker_thread = threading.Thread(target=worker.exec, daemon=True, args=(
    "import socket, omp_remote\n"
    f"sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM, fileno={server.detach()})\n"
    "omp_remote.serve(sock, authkey=b'demo-key')",))
worker_thread.start()
session = omp_remote.Session(client, authkey=b"demo-key")

def make_adder(n):                      # closure: bundled cloudpickle by-value
    @omp_remote.remote
    def adder(x):
        return x + n
    return adder

assert session.call(make_adder(40), 2) == 42

@omp_remote.remote(ship="code")
def add(a, b=10):                       # marshal mode: self-contained fn
    return a + b

assert session.call(add, 32) == 42      # ships code
assert session.call(add, 2, b=3) == 5   # cache hit: hash + args only

with tempfile.TemporaryDirectory() as tmp:
    with open(os.path.join(tmp, "demo_remote_mod.py"), "w") as fh:
        fh.write("import omp_remote\nSCALE = 3\n\n"
                 "class DemoError(Exception):\n    pass\n\n"
                 "@omp_remote.remote\ndef scaled(x):\n    return SCALE * x\n\n"
                 "@omp_remote.remote\ndef fail():\n    raise DemoError('custom boom')\n")
    sys.path.insert(0, tmp)
    import demo_remote_mod
    sys.path.remove(tmp)
    # Default mode for a flat file-backed module is source shipping: the
    # isolated worker never sees tmp on sys.path, so a by-reference pickle
    # would fail with ModuleNotFoundError here.
    assert session.call(demo_remote_mod.scaled, 14) == 42

    try:                                      # DemoError lives only in the
        session.call(demo_remote_mod.fail)    # worker's synthetic module
    except omp_remote.RemoteError as exc:
        assert "DemoError: custom boom" in str(exc)
        assert isinstance(exc.__cause__, omp_remote.RemoteTraceback)
    else:
        raise AssertionError("expected RemoteError")

@omp_remote.remote
def boom():
    raise ValueError("remote failure")

try:
    session.call(boom)
except ValueError as exc:
    assert isinstance(exc.__cause__, omp_remote.RemoteTraceback)
else:
    raise AssertionError("expected ValueError")

session.close()                         # worker sees EOF; serve() returns
worker_thread.join(5)
assert not worker_thread.is_alive()

print("remote : omp_remote loopback ok — auth, code cache, cloudpickle/source/"
      "marshal shipping, remote traceback + RemoteError fallback")
"#
			),
			None,
			None,
		)?;

		// And the other direction: evaluate Python, extract into Rust.
		let back: u64 = py
			.eval(c_str!("sum(__import__('omp').nth_prime(n) for n in range(1, 11))"), None, None)?
			.extract()?;
		println!("rust   : sum of first 10 primes via Python = {back}");

		// Proof of embedding: the interpreter shares our process.
		let py_pid: u32 = py
			.eval(c_str!("__import__('os').getpid()"), None, None)?
			.extract()?;
		assert_eq!(py_pid, process::id());
		println!("proof  : os.getpid() == std::process::id() == {py_pid}");
		Ok(())
	})
}
