//! Picks, once per env, how that env's `AsyncTask` / `Env::spawn` promises are settled. See
//! `promise.rs` for the two ways.
//!
//! The pick is made at the env's first task after this addon's registration into it has
//! returned, not while it registers. The check reads `process.versions`, and a getter there may
//! load another addon. Node holds its addon-loader lock while an addon registers, and that lock
//! is not re-entrant: a nested load there aborts the process. After registration no loader lock
//! is held. A task created while this addon registers takes the thenable path and picks nothing.

/// How the promises of one env are settled.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum SettleMode {
  /// `napi_create_promise`, then `napi_resolve_deferred` / `napi_reject_deferred` when the task
  /// completes. The cheap way, as before #3689. Chosen only where the env dies with its process
  /// (the main env of Node and Bun) or with its realm (wasm). Some hosts are not told apart: an
  /// embedder that links `libnode.so` and creates and frees several envs on the default loop
  /// gets this mode too, and leaks one deferred per task in flight at each teardown, as before.
  /// So does a host that is not Bun but fakes `process.versions.bun` before the env's first
  /// task, on its main OS thread.
  Deferred,
  /// The deferred is settled at once with a thenable (see `promise.rs`). Costs more main-thread
  /// CPU per task, but a task still in flight when the env is torn down leaks nothing.
  Thenable,
}

impl SettleMode {
  pub(crate) fn as_str(self) -> &'static str {
    match self {
      SettleMode::Deferred => "deferred",
      SettleMode::Thenable => "thenable",
    }
  }
}

/// Picks the settle mode of `env`. Called once per load, at the env's first task after
/// `napi_register_module_v1` returned, inside that call into `env` on its thread. Never
/// throws, and never clears an exception it did not cause. Every doubt gives `Thenable`,
/// which is always correct, only slower.
///
/// Native, in this order:
///
/// 1. `globalThis.process.versions` is read first. Electron and NW.js (`versions.electron` /
///    `versions.nw` set), a pending exception, and a read that fails or finds the wrong types
///    all give `Thenable`.
/// 2. Bun (`versions.bun` set, any value) is placed by its OS thread, never by libuv. Bun runs
///    its main VM on the process main thread and its Workers on other threads. On macOS, Linux,
///    Android and the BSDs that can tell, the main thread gives `Deferred`; any other thread,
///    and every other target (Windows too), gives `Thenable`. `uv_default_loop()` is never
///    called for Bun: Bun before 1.4.4 exports it as a stub that aborts the process, no
///    exported symbol tells 1.4.4 apart from 1.4.3, and the version string is writable.
/// 3. Any other host on macOS, Linux and the other Unix hosts: `uv_default_loop()` is called
///    only when the host is Node-based (it exports `node::Buffer::Data`). Any other host (Deno,
///    a Bun whose `versions.bun` was removed) gets `Thenable` without the call. Windows skips
///    this check: Node, Electron and Bun all have a real libuv there, and Deno does not export
///    `uv_default_loop`.
/// 4. `Deferred` only when the host exports both `uv_default_loop` and
///    `napi_get_uv_event_loop` (found at run time, never linked) and the env's loop is the
///    default loop: the main env of Node. Workers give `Thenable`.
///
/// A faked `process.versions` can only move an env to the other mode: `Thenable` costs CPU,
/// `Deferred` leaks one 16 B deferred per task in flight at teardown, as before #3689. It can
/// never crash the process or settle a promise wrongly.
#[cfg(not(feature = "noop"))]
pub(crate) fn detect(env: crate::sys::napi_env) -> SettleMode {
  #[cfg(target_family = "wasm")]
  {
    // emnapi refuses JavaScript only after `Context.destroy()`; a deferred refused there is a
    // JavaScript object that dies with the realm.
    let _ = env;
    SettleMode::Deferred
  }
  #[cfg(not(target_family = "wasm"))]
  {
    let deferred = match host::read_versions(env) {
      host::Versions::Thenable => false,
      host::Versions::Bun => host::on_main_os_thread() == Some(true),
      // The loop check runs only here.
      host::Versions::NotBun => host::runs_on_default_loop(env),
    };
    if deferred {
      SettleMode::Deferred
    } else {
      SettleMode::Thenable
    }
  }
}

#[cfg(all(not(feature = "noop"), not(target_family = "wasm")))]
mod host {
  use std::ffi::{c_void, CStr};
  use std::ptr;
  use std::sync::OnceLock;

  use crate::sys;

  /// What `globalThis.process.versions` tells about the host.
  #[derive(Clone, Copy, PartialEq, Eq, Debug)]
  pub(super) enum Versions {
    /// A host whose envs can die before the process. Also given when it cannot tell: an
    /// exception was already pending, or a read failed, threw or found the wrong type.
    Thenable,
    /// `versions.bun` is set, to any value. Placed by its OS thread, see [`on_main_os_thread`].
    Bun,
    /// No `versions.bun`, `versions.electron` or `versions.nw`.
    NotBun,
  }

  pub(super) fn read_versions(env: sys::napi_env) -> Versions {
    let mut pending = false;
    // An exception pending on entry is not ours: it must stay pending, untouched.
    if unsafe { sys::napi_is_exception_pending(env, &mut pending) } != sys::Status::napi_ok
      || pending
    {
      return Versions::Thenable;
    }
    let mut scope = ptr::null_mut();
    if unsafe { sys::napi_open_handle_scope(env, &mut scope) } != sys::Status::napi_ok {
      return Versions::Thenable;
    }
    let verdict = versions_verdict(env);
    // Nothing was pending before, so anything pending now came from the reads above.
    let threw = crate::async_work::promise::take_pending_exception(env).is_some();
    unsafe { sys::napi_close_handle_scope(env, scope) };
    if threw {
      return Versions::Thenable;
    }
    verdict.unwrap_or(Versions::Thenable)
  }

  /// `None` when `process.versions` cannot be read.
  fn versions_verdict(env: sys::napi_env) -> Option<Versions> {
    let mut global = ptr::null_mut();
    if unsafe { sys::napi_get_global(env, &mut global) } != sys::Status::napi_ok || global.is_null()
    {
      return None;
    }
    let process = object_property(env, global, c"process")?;
    let versions = object_property(env, process, c"versions")?;
    for embedder in [c"electron", c"nw"] {
      let value = named_property(env, versions, embedder)?;
      if value_type(env, value)? != sys::ValueType::napi_undefined {
        return Some(Versions::Thenable);
      }
    }
    // The version itself is not read: it is writable, so it must not decide anything.
    let bun = named_property(env, versions, c"bun")?;
    Some(if value_type(env, bun)? == sys::ValueType::napi_undefined {
      Versions::NotBun
    } else {
      Versions::Bun
    })
  }

  /// `object[key]` when it is an object. Checking the type before the next read matters:
  /// `napi_get_named_property` on `undefined` throws through `ToObject`, and on a primitive it
  /// reads prototype getters.
  fn object_property(
    env: sys::napi_env,
    object: sys::napi_value,
    key: &CStr,
  ) -> Option<sys::napi_value> {
    let value = named_property(env, object, key)?;
    (value_type(env, value)? == sys::ValueType::napi_object).then_some(value)
  }

  fn named_property(
    env: sys::napi_env,
    object: sys::napi_value,
    key: &CStr,
  ) -> Option<sys::napi_value> {
    let mut value = ptr::null_mut();
    (unsafe { sys::napi_get_named_property(env, object, key.as_ptr(), &mut value) }
      == sys::Status::napi_ok
      && !value.is_null())
    .then_some(value)
  }

  fn value_type(env: sys::napi_env, value: sys::napi_value) -> Option<sys::napi_valuetype> {
    let mut value_type = sys::ValueType::napi_undefined;
    (unsafe { sys::napi_typeof(env, value, &mut value_type) } == sys::Status::napi_ok)
      .then_some(value_type)
  }

  /// Whether the calling thread is the process main thread. Bun runs its main VM there and its
  /// Workers on other threads, and Bun frees a deferred settled after its context is gone, so
  /// `Deferred` is safe on its main thread. `None` where there is no clean way to tell.
  #[cfg(any(
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd"
  ))]
  pub(super) fn on_main_os_thread() -> Option<bool> {
    Some(unsafe { libc::pthread_main_np() } == 1)
  }

  /// Linux and Android: the main thread's id is the process id. Through the raw syscall, since
  /// musl and older glibc may not export `gettid`.
  #[cfg(any(target_os = "linux", target_os = "android"))]
  pub(super) fn on_main_os_thread() -> Option<bool> {
    Some(unsafe { libc::syscall(libc::SYS_gettid) } as libc::pid_t == unsafe { libc::getpid() })
  }

  /// No clean way to tell (Windows among them; Bun's main thread does not run libuv's default
  /// loop there either): Bun takes the thenable path.
  #[cfg(not(any(
    target_vendor = "apple",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "openbsd",
    target_os = "linux",
    target_os = "android"
  )))]
  pub(super) fn on_main_os_thread() -> Option<bool> {
    None
  }

  type UvDefaultLoop = unsafe extern "C" fn() -> *mut c_void;
  type GetUvEventLoop = unsafe extern "C" fn(sys::napi_env, *mut *mut c_void) -> sys::napi_status;

  struct HostLoop {
    /// `uv_default_loop()`, called once, and only in a host [`may_call_default_loop`] allows.
    /// libuv keeps the default loop in one static struct, so the address never changes for the
    /// life of the process. In a host that never used the default loop, this first call creates
    /// it: one loop and its backend fd stay open for the life of the process (Node and Electron
    /// create it at startup, so nothing changes there).
    default_loop: usize,
    get_uv_event_loop: GetUvEventLoop,
  }

  /// Set by the first env that may call `uv_default_loop()`. An env that may not leaves it
  /// unset, so a later env that may still sets it.
  static HOST_LOOP: OnceLock<Option<HostLoop>> = OnceLock::new();

  fn host_loop() -> Option<&'static HostLoop> {
    if !may_call_default_loop() {
      return None;
    }
    HOST_LOOP
      .get_or_init(|| {
        let (uv_default_loop, get_uv_event_loop) = host_symbols()?;
        let default_loop = unsafe { uv_default_loop() };
        (!default_loop.is_null()).then_some(HostLoop {
          default_loop: default_loop as usize,
          get_uv_event_loop,
        })
      })
      .as_ref()
  }

  /// Whether `env` runs on libuv's default loop, the loop of the host's main thread. `false`
  /// when `uv_default_loop()` may not be called, the host does not export both symbols, or
  /// `uv_default_loop()` gives null. Never called for Bun.
  pub(super) fn runs_on_default_loop(env: sys::napi_env) -> bool {
    let Some(host) = host_loop() else {
      return false;
    };
    let mut event_loop = ptr::null_mut();
    // No `NAPI_PREAMBLE` (Node: `CHECK_ENV` + `CHECK_ARG` only).
    (unsafe { (host.get_uv_event_loop)(env, &mut event_loop) } == sys::Status::napi_ok)
      && !event_loop.is_null()
      && event_loop as usize == host.default_loop
  }

  /// Whether `uv_default_loop()` may be called: only in a Node-based host. Bun before 1.4.4
  /// exports it as a stub that aborts the process, and nothing native tells 1.4.4 apart.
  /// `process.versions.bun` is the only sign of Bun, and a script can delete it, so a missing
  /// `versions.bun` does not prove the host is not Bun. A host that is not Node-based (a Bun
  /// whose `versions.bun` was removed, Deno, any other) never has it called and takes the
  /// thenable path.
  #[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  ))]
  fn may_call_default_loop() -> bool {
    node_host()
  }

  /// Whether the host exports `node::Buffer::Data(v8::Local<v8::Value>)` (Itanium-mangled),
  /// declared `NODE_EXTERN` in `node_buffer.h` since Node 0.x. Exported by Node and Electron;
  /// not by Bun (which exports some other `node::` functions) nor Deno. Looked up once.
  #[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  ))]
  fn node_host() -> bool {
    static NODE_HOST: OnceLock<bool> = OnceLock::new();
    *NODE_HOST.get_or_init(|| {
      // glibc before 2.34 keeps `dlsym` in a separate library.
      #[cfg(any(target_os = "linux", target_os = "android"))]
      #[link(name = "dl")]
      unsafe extern "C" {}

      // `dlsym` adds the leading `_` of Mach-O names itself.
      !unsafe {
        libc::dlsym(
          libc::RTLD_DEFAULT,
          c"_ZN4node6Buffer4DataEN2v85LocalINS1_5ValueEEE".as_ptr(),
        )
      }
      .is_null()
    })
  }

  /// `uv_default_loop` and `napi_get_uv_event_loop` from the global scope, the same scope
  /// napi-sys loads every Node-API function from. Found at run time, not linked: a link-time
  /// import of `uv_default_loop` fails to load on Deno, which does not export it. Also finds
  /// them in a `libnode.so` the executable depends on, so a distro `node` built against it is
  /// placed correctly, and an embedder that links it is not told apart (see
  /// [`SettleMode::Deferred`]). Windows checks the executable only; this difference between the
  /// platforms is accepted.
  #[cfg(any(
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  ))]
  fn host_symbols() -> Option<(UvDefaultLoop, GetUvEventLoop)> {
    // glibc before 2.34 keeps `dlsym` in a separate library.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    #[link(name = "dl")]
    unsafe extern "C" {}

    let uv_default_loop = unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"uv_default_loop".as_ptr()) };
    let get_uv_event_loop =
      unsafe { libc::dlsym(libc::RTLD_DEFAULT, c"napi_get_uv_event_loop".as_ptr()) };
    if uv_default_loop.is_null() || get_uv_event_loop.is_null() {
      return None;
    }
    // SAFETY: both are the host's exported C functions with these signatures.
    Some(unsafe {
      (
        std::mem::transmute::<*mut c_void, UvDefaultLoop>(uv_default_loop),
        std::mem::transmute::<*mut c_void, GetUvEventLoop>(get_uv_event_loop),
      )
    })
  }

  /// Windows: always, as before. Node, Electron and Bun all have a real libuv there, so the
  /// call cannot abort, and Deno does not export `uv_default_loop`.
  #[cfg(windows)]
  fn may_call_default_loop() -> bool {
    true
  }

  /// Windows: the process executable only, not `libnode.dll` / `node.dll`. A host that keeps
  /// Node in a DLL is an embedder, which may create and free several envs on the default loop.
  #[cfg(windows)]
  fn host_symbols() -> Option<(UvDefaultLoop, GetUvEventLoop)> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
      fn GetModuleHandleW(module_name: *const u16) -> *mut c_void;
      fn GetProcAddress(module: *mut c_void, proc_name: *const std::ffi::c_char) -> *mut c_void;
    }
    // Takes no reference, so nothing is freed.
    let exe = unsafe { GetModuleHandleW(ptr::null()) };
    if exe.is_null() {
      return None;
    }
    let uv_default_loop = unsafe { GetProcAddress(exe, c"uv_default_loop".as_ptr()) };
    let get_uv_event_loop = unsafe { GetProcAddress(exe, c"napi_get_uv_event_loop".as_ptr()) };
    if uv_default_loop.is_null() || get_uv_event_loop.is_null() {
      return None;
    }
    // SAFETY: both are the host's exported C functions with these signatures (cdecl, as
    // `NAPI_CDECL` / `UV_EXTERN` declare them, also on i686).
    Some(unsafe {
      (
        std::mem::transmute::<*mut c_void, UvDefaultLoop>(uv_default_loop),
        std::mem::transmute::<*mut c_void, GetUvEventLoop>(get_uv_event_loop),
      )
    })
  }

  /// No portable way to find the symbols: the thenable path.
  #[cfg(not(any(
    windows,
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  )))]
  fn may_call_default_loop() -> bool {
    false
  }

  /// No portable way to find the symbols: the thenable path.
  #[cfg(not(any(
    windows,
    target_vendor = "apple",
    target_os = "linux",
    target_os = "android",
    target_os = "freebsd",
    target_os = "dragonfly",
    target_os = "netbsd",
    target_os = "solaris",
    target_os = "illumos"
  )))]
  fn host_symbols() -> Option<(UvDefaultLoop, GetUvEventLoop)> {
    None
  }
}
