//! Per-env state that napi-rs keeps for each load of this addon.
//!
//! One addon image can be registered into several live `napi_env`s on the same
//! OS thread: `process.dlopen` of the same file twice, `delete require.cache`
//! followed by `require` again, a hardlinked copy of the `.node` file, or one
//! Electron renderer thread hosting several frames. Each load gets a new
//! `napi_env`, but all of them share this image's statics and thread-locals.
//! So anything cached per load has to be keyed by env, not by thread, and has to
//! be dropped at that env's teardown.
//!
//! Each successful registration pushes one [`EnvRegistration`] and adds one env
//! cleanup hook whose arg is the record's id. The hook first takes the record out
//! of the list, so no lookup can find it any more, and only then deletes the
//! references it holds. Below Node-API 3 there is no cleanup hook; a strongly
//! referenced external plays its part, because the env runs its finalizer at
//! teardown (see [`begin`]).
//!
//! Ids start at 1 and are never reused, so the `(fn, arg)` pair handed to
//! `napi_add_env_cleanup_hook` is unique even if an embedder registers the
//! module twice into the same env. A record is always removed before its env is
//! freed, so a new env that reuses a freed env's address can never match a stale
//! record.
//!
//! Because multiple envs can legitimately be live at once on the same OS thread,
//! registering a new env never tears down earlier records on that thread. Each
//! record keeps its strong `napi_ref`s alive until the host tears down its env
//! and runs the cleanup hook (or, on native targets below Node-API 3, the
//! external finalizer); a host that retires a realm on a reused thread without
//! tearing down its `napi_env` must release or weaken those refs itself.
//! (On wasm below Node-API 3, teardown cannot be observed, so [`begin`] installs
//! neither a hook nor a finalizer and instead clears earlier records without
//! deleting their references; see [`begin`].)

use std::cell::RefCell;
use std::collections::HashMap;
#[cfg(not(feature = "noop"))]
use std::collections::HashSet;
#[cfg(all(
  not(feature = "noop"),
  any(feature = "napi3", not(target_family = "wasm"))
))]
use std::os::raw::c_void;
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(all(feature = "napi4", not(feature = "noop")))]
use std::sync::Arc;

use rustc_hash::FxBuildHasher;

#[cfg(all(feature = "napi4", not(feature = "noop")))]
use crate::bindgen_runtime::module_register::CustomGcHandle;
use crate::{async_work::SettleMode, sys};

/// Identifies one registration of this addon into one env. Starts at 1 and is
/// never reused.
pub(crate) type RegistrationId = usize;

#[cfg(not(feature = "noop"))]
static NEXT_REGISTRATION_ID: AtomicUsize = AtomicUsize::new(1);

/// One load's class constructor references, keyed by the class's JS name with its
/// trailing NUL (the key generated code passes).
pub(crate) type ClassConstructors = HashMap<&'static str, sys::napi_ref, FxBuildHasher>;

/// How many cached `Reflect` holder references env teardown has deleted, across
/// every env of this process.
static REFLECT_REFS_DELETED: AtomicUsize = AtomicUsize::new(0);

/// How many custom-GC threadsafe functions env teardown has released, across
/// every env of this process.
static CUSTOM_GC_RELEASED: AtomicUsize = AtomicUsize::new(0);

/// How many class constructor references env teardown has deleted, across every
/// env of this process.
static CLASS_REFS_DELETED: AtomicUsize = AtomicUsize::new(0);

/// What napi-rs keeps for one registration of this addon into one env.
// Under `noop` nothing registers, so no record is ever built.
#[cfg_attr(feature = "noop", allow(dead_code))]
pub(crate) struct EnvRegistration {
  id: RegistrationId,
  env: sys::napi_env,
  /// Holder object for the env's `Reflect` / `Reflect.getOwnPropertyDescriptor`
  /// pair, see `crate::error::cache_reflect_intrinsics_for_env`.
  reflect_intrinsics: Option<sys::napi_ref>,
  /// How this env's `AsyncTask` promises are settled. Picked at the env's first task after
  /// this registration has returned (see `crate::async_work::promise`). Holds no reference.
  promise_settle: PromiseSettle,
  /// The native `then` shared by the thenables that settle this env's `AsyncTask`
  /// promises, see `crate::async_work::promise`. Created on first use. Only used on the
  /// thenable path.
  promise_then: Option<sys::napi_ref>,
  /// The env's promise wrapper, `(then, handle) => settle({ then, handle })` with an `async`
  /// `settle`, which makes the promise of a thenable-mode task or `JsDeferred` in one call, see
  /// `crate::async_work::promise`. Compiled at the first thenable-mode promise.
  promise_wrapper: PromiseWrapper,
  /// This env's custom-GC threadsafe function, see
  /// `crate::bindgen_runtime::module_register::create_custom_gc`. The record
  /// holds a strong `Arc`, so teardown can always reach the function to release
  /// it, even when no value captured the handle.
  #[cfg(all(feature = "napi4", not(feature = "noop")))]
  custom_gc: Option<Arc<CustomGcHandle>>,
  /// The constructor reference of every `#[napi]` class this load defined in
  /// `env`. Class lookups of generated code read them by env (see
  /// [`class_constructor_in_env`]), so each load builds and checks its own classes.
  classes: ClassConstructors,
  /// Strong reference to the external whose finalizer observes this env's
  /// teardown below Node-API 3 (see [`begin`]). It is a userland reference, which
  /// the env never frees, so teardown deletes it.
  #[cfg(all(
    not(feature = "napi3"),
    not(feature = "noop"),
    not(target_family = "wasm")
  ))]
  sentinel_ref: sys::napi_ref,
}

/// The per-env function that creates a thenable-mode promise. See `crate::async_work::promise`.
#[cfg_attr(feature = "noop", allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PromiseWrapper {
  /// Not compiled yet.
  Unset,
  /// A strong reference to the compiled function.
  Ready(sys::napi_ref),
  /// The host will never compile it (it blocks code generation): the env's thenable-mode
  /// promises are made from a deferred from now on.
  Unavailable,
}

/// The cached functions of an env's thenable-mode promises.
#[cfg_attr(feature = "noop", allow(dead_code))]
#[derive(Clone, Copy)]
pub(crate) struct PromiseCache {
  pub(crate) then: Option<sys::napi_ref>,
  pub(crate) wrapper: PromiseWrapper,
}

/// Where an env's settle mode stands. See `crate::async_work::promise`.
// Under `noop` nothing registers, so no record is ever built.
#[cfg_attr(feature = "noop", allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub(crate) enum PromiseSettle {
  /// `napi_register_module_v1` is still running for this record. Tasks take the thenable path
  /// and decide nothing.
  Registering,
  /// Registration has returned; the next task decides.
  Undecided,
  /// A task is deciding right now. A task made meanwhile (by a getter the check ran) takes the
  /// thenable path and decides nothing.
  Deciding,
  Decided(SettleMode),
}

thread_local! {
  // In registration order: the newest record is the last one. Records are only
  // ever touched on their env's own thread (registration, the cleanup hook, and
  // lookups from calls into that env all run there).
  static ENV_REGISTRATIONS: RefCell<Vec<EnvRegistration>> = const { RefCell::new(Vec::new()) };
  // Env pointers whose registration record on this thread has already been torn
  // down. Cleared for `env` if a new registration starts at the same address,
  // so lookups can tell a torn-down registered env apart from an env that never
  // registered with napi-rs.
  #[cfg(not(feature = "noop"))]
  static TORN_DOWN_ENVS: RefCell<HashSet<usize, FxBuildHasher>> = const { RefCell::new(HashSet::with_hasher(FxBuildHasher)) };
}

/// Lifecycle state of a `napi_env` on the current thread.
#[cfg(not(feature = "noop"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EnvState {
  /// The env has a live registration record on this thread.
  Live(RegistrationId),
  /// A registration for this env already ran teardown on this thread, or this
  /// thread's TLS is tearing down.
  TornDown,
  /// No registration for this env has been seen on this thread (for example, a
  /// custom embedder that does not run `napi-rs` module registration).
  Unregistered,
}

/// Starts a registration of this addon into `env`: sets up what will tear the
/// record down at `env`'s teardown, then records it.
///
/// - Node-API 3 and up: one env cleanup hook, whose arg is the record's id.
/// - Below Node-API 3, native: there is no cleanup hook, so a strongly referenced
///   external stands in for it. The env runs the finalizers of the externals it
///   still holds when it is torn down (before it finalizes plain references, so
///   the finalizer may still delete them), and the strong reference keeps this one
///   from being collected before that.
/// - Below Node-API 3, wasm: nothing can observe teardown (a strongly referenced
///   external would keep the whole emnapi instance alive). Each wasm instance has
///   its own memory and registers once, so the new record just replaces every
///   earlier one on this thread, and nothing that needs deleting is cached.
///
/// Returns `None` when teardown cannot be observed: the hook (or the external)
/// could not be added. In that case nothing is recorded, and the load must fail,
/// because nothing would ever delete what it caches.
///
/// Call it after `create_custom_gc` and before the first module-init callback: hooks
/// run newest first, so this record then outlives every hook that the module's exports
/// add, and is gone before Node's own custom-GC TSFN cleanup. The record starts in
/// [`PromiseSettle::Registering`]; keep a [`RegisteringGuard`] for it until
/// registration returns.
#[cfg(not(feature = "noop"))]
pub(crate) fn begin(env: sys::napi_env) -> Option<RegistrationId> {
  let id = NEXT_REGISTRATION_ID.fetch_add(1, Ordering::Relaxed);
  #[cfg(feature = "napi3")]
  {
    #[cfg(not(target_family = "wasm"))]
    let status = unsafe {
      sys::napi_add_env_cleanup_hook(env, Some(env_registration_cleanup), id as *mut c_void)
    };
    // `sys::` would import the symbol from the `env` wasm module; emnapi provides it
    // under `napi` (see `crate::napi_add_env_cleanup_hook`). emnapi runs the hook
    // from `Context.destroy()`.
    #[cfg(target_family = "wasm")]
    let status = unsafe {
      crate::napi_add_env_cleanup_hook(env, Some(env_registration_cleanup), id as *mut c_void)
    };
    if status != sys::Status::napi_ok {
      return None;
    }
    // The hook stays added either way; finding no record, it does nothing.
    push_registration(new_registration(id, env)).then_some(id)
  }
  #[cfg(all(not(feature = "napi3"), not(target_family = "wasm")))]
  {
    use std::ptr;
    let mut sentinel = ptr::null_mut();
    let mut sentinel_ref = ptr::null_mut();
    let observed = unsafe {
      sys::napi_create_external(
        env,
        id as *mut c_void,
        Some(env_registration_finalize),
        ptr::null_mut(),
        &mut sentinel,
      ) == sys::Status::napi_ok
        && sys::napi_create_reference(env, sentinel, 1, &mut sentinel_ref) == sys::Status::napi_ok
    };
    // Without the strong reference the external is collected some time later, and
    // its finalizer, finding no record, does nothing.
    if !observed {
      return None;
    }
    let mut registration = new_registration(id, env);
    registration.sentinel_ref = sentinel_ref;
    if push_registration(registration) {
      Some(id)
    } else {
      unsafe { sys::napi_delete_reference(env, sentinel_ref) };
      None
    }
  }
  #[cfg(all(not(feature = "napi3"), target_family = "wasm"))]
  {
    ENV_REGISTRATIONS
      .try_with(|registrations| {
        let mut registrations = registrations.try_borrow_mut().ok()?;
        let _ = TORN_DOWN_ENVS.try_with(|torn_down| {
          if let Ok(mut torn_down) = torn_down.try_borrow_mut() {
            for old in registrations.iter() {
              torn_down.insert(old.env as usize);
            }
            torn_down.remove(&(env as usize));
          }
        });
        // Dropped without deleting anything: they belong to envs this instance no
        // longer serves, and dropping them keeps a reused env address from
        // matching a stale record.
        registrations.clear();
        registrations.push(new_registration(id, env));
        Some(id)
      })
      .ok()
      .flatten()
  }
}

/// An empty record for `id` in `env`.
#[cfg(not(feature = "noop"))]
fn new_registration(id: RegistrationId, env: sys::napi_env) -> EnvRegistration {
  EnvRegistration {
    id,
    env,
    reflect_intrinsics: None,
    promise_settle: PromiseSettle::Registering,
    promise_then: None,
    promise_wrapper: PromiseWrapper::Unset,
    #[cfg(all(feature = "napi4", not(feature = "noop")))]
    custom_gc: None,
    classes: ClassConstructors::default(),
    #[cfg(all(
      not(feature = "napi3"),
      not(feature = "noop"),
      not(target_family = "wasm")
    ))]
    sentinel_ref: std::ptr::null_mut(),
  }
}

/// Appends `registration` as the newest record. `false` when the thread-local is
/// gone or busy.
#[cfg(all(
  not(feature = "noop"),
  any(feature = "napi3", not(target_family = "wasm"))
))]
fn push_registration(registration: EnvRegistration) -> bool {
  let env = registration.env as usize;
  let pushed = ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return false;
      };
      registrations.push(registration);
      true
    })
    .unwrap_or(false);
  if pushed {
    let _ = TORN_DOWN_ENVS.try_with(|torn_down| {
      if let Ok(mut torn_down) = torn_down.try_borrow_mut() {
        torn_down.remove(&env);
      }
    });
  }
  pushed
}

/// Env cleanup hook added by [`begin`]. `arg` is the registration id.
///
/// Runs on the env's own thread while the env can still delete references.
#[cfg(all(not(feature = "noop"), feature = "napi3"))]
unsafe extern "C" fn env_registration_cleanup(arg: *mut c_void) {
  // The borrow ends inside `take_registration`, before any napi call below.
  let Some(registration) = take_registration(arg as RegistrationId) else {
    return;
  };
  unsafe { release_registration(registration) };
}

/// Finalizer of the external that [`begin`] adds below Node-API 3. `data` is the
/// registration id. The strong reference to the external means it runs only when
/// the env is torn down, on the env's own thread. The env runs these finalizers
/// before it finalizes plain references, so deleting references here is allowed.
#[cfg(all(
  not(feature = "napi3"),
  not(feature = "noop"),
  not(target_family = "wasm")
))]
unsafe extern "C" fn env_registration_finalize(
  _env: sys::napi_env,
  data: *mut c_void,
  _hint: *mut c_void,
) {
  let Some(registration) = take_registration(data as RegistrationId) else {
    return;
  };
  unsafe { release_registration(registration) };
}

/// Removes the record with `id`, so that no lookup can find it any more.
#[cfg(all(
  not(feature = "noop"),
  any(feature = "napi3", not(target_family = "wasm"))
))]
fn take_registration(id: RegistrationId) -> Option<EnvRegistration> {
  let removed = ENV_REGISTRATIONS
    .try_with(|registrations| {
      let mut registrations = registrations.try_borrow_mut().ok()?;
      let position = registrations
        .iter()
        .rposition(|registration| registration.id == id)?;
      // `remove`, not `swap_remove`: the newest-last order must be kept.
      Some(registrations.remove(position))
    })
    .ok()
    .flatten()?;
  let _ = TORN_DOWN_ENVS.try_with(|torn_down| {
    if let Ok(mut torn_down) = torn_down.try_borrow_mut() {
      torn_down.insert(removed.env as usize);
    }
  });
  Some(removed)
}

/// Deletes every reference a record held. The record must already be out of
/// the list (see [`take_registration`]), so nothing can look these up again.
///
/// # Safety
///
/// Must run on `registration.env`'s thread while that env is still alive.
#[cfg(all(
  not(feature = "noop"),
  any(feature = "napi3", not(target_family = "wasm"))
))]
unsafe fn release_registration(registration: EnvRegistration) {
  // Release the custom-GC threadsafe function first-hand: its initial thread
  // count is 1 and nothing else ever releases it. The hook runs before Node's
  // own cleanup for that function (hooks run newest first, and the function was
  // created before this record's hook was added), so the function is still
  // open: the release only drops the thread count to 0. Node's cleanup then
  // closes it and, with the count at 0, frees it. Without this, Node >= 24.13.1,
  // >= 25.4.0 and emnapi keep the function alive forever (their final delete is
  // gated on a zero thread count); older Node frees it either way. The same call
  // deletes the references released off-thread that the JS thread has not
  // deleted yet.
  #[cfg(all(feature = "napi4", not(feature = "noop")))]
  if let Some(handle) = registration.custom_gc {
    if unsafe {
      handle.close(
        registration.env,
        sys::ThreadsafeFunctionReleaseMode::release,
      )
    } == sys::Status::napi_ok
    {
      CUSTOM_GC_RELEASED.fetch_add(1, Ordering::Relaxed);
    }
  }
  // `napi_delete_reference` does not throw, on Node or on emnapi, so there is no
  // pending exception to clear.
  for reference in registration.classes.into_values() {
    if unsafe { sys::napi_delete_reference(registration.env, reference) } == sys::Status::napi_ok {
      CLASS_REFS_DELETED.fetch_add(1, Ordering::Relaxed);
    }
  }
  if let Some(reference) = registration.reflect_intrinsics {
    if unsafe { sys::napi_delete_reference(registration.env, reference) } == sys::Status::napi_ok {
      REFLECT_REFS_DELETED.fetch_add(1, Ordering::Relaxed);
    }
  }
  if let Some(reference) = registration.promise_then {
    unsafe { sys::napi_delete_reference(registration.env, reference) };
  }
  if let PromiseWrapper::Ready(reference) = registration.promise_wrapper {
    unsafe { sys::napi_delete_reference(registration.env, reference) };
  }
  // `AsyncTask` outcomes kept for a promise whose `then` never ran: nothing can run it now.
  crate::async_work::release_env_promise_states(registration.env);
  #[cfg(all(
    not(feature = "napi3"),
    not(feature = "noop"),
    not(target_family = "wasm")
  ))]
  unsafe {
    sys::napi_delete_reference(registration.env, registration.sentinel_ref)
  };
}

/// Releases every record on this thread whose env is not `env`: the env that
/// registers now supersedes them.
///
/// Local change (see the vendored README): this module keeps an earlier env's
/// record until that env is torn down, on the premise that a host never retires a
/// realm on a reused thread without tearing its env down. Bun breaks it: `bun
/// test --isolate` (implied by `--parallel`) gives every test file a fresh global
/// object and `napi_env` on the same thread and never tears the old one down. The
/// records' strong references (class constructors, the custom-GC sentinel, the
/// `Reflect` holder, the promise functions) then pin every earlier realm (its
/// global object and full module graph) for the life of the worker. A record that
/// is still listed when another env registers proves its env is alive, so its
/// references are deleted through it here. Under Node an env on a thread is always
/// torn down (removing its record) before another registers, so this never finds
/// one there. Records of `env` itself (the same env registering again, e.g.
/// `delete require.cache` + re-`require`) are kept.
///
/// Call it at the start of `napi_register_module_v1`, before `create_custom_gc`.
#[cfg(all(feature = "napi3", not(feature = "noop"), not(target_family = "wasm")))]
pub(crate) fn release_superseded_envs(env: sys::napi_env) {
  // The borrow ends here, before any napi call below.
  let superseded = ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return Vec::new();
      };
      let (kept, superseded) = std::mem::take(&mut *registrations)
        .into_iter()
        .partition(|registration| registration.env == env);
      *registrations = kept;
      superseded
    })
    .unwrap_or_default();
  for registration in superseded {
    let _ = TORN_DOWN_ENVS.try_with(|torn_down| {
      if let Ok(mut torn_down) = torn_down.try_borrow_mut() {
        torn_down.insert(registration.env as usize);
      }
    });
    // The env lives on, so the late sentinel's finalizer would never run: delete
    // its strong reference too, as for a handle no record owns.
    #[cfg(feature = "napi4")]
    if let Some(handle) = registration.custom_gc.as_ref() {
      unsafe { handle.give_up_sentinel(registration.env) };
    }
    unsafe { release_registration(registration) };
  }
}

/// Stores the `Reflect` holder reference in the record with `id`.
///
/// Returns `false` when the record is gone or already has one, or on wasm below
/// Node-API 3; the caller then still owns `reference` and must delete it.
#[cfg(not(feature = "noop"))]
pub(crate) fn set_reflect_intrinsics(id: RegistrationId, reference: sys::napi_ref) -> bool {
  // Nothing observes teardown on wasm below Node-API 3 (see [`begin`]), so
  // nothing would ever delete the reference: cache nothing there.
  if cfg!(all(not(feature = "napi3"), target_family = "wasm")) {
    return false;
  }
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return false;
      };
      match registrations
        .iter_mut()
        .rev()
        .find(|registration| registration.id == id)
      {
        Some(registration) if registration.reflect_intrinsics.is_none() => {
          registration.reflect_intrinsics = Some(reference);
          true
        }
        _ => false,
      }
    })
    .unwrap_or(false)
}

/// Stores the shared `then` of `AsyncTask` thenables in `env`'s newest live record.
///
/// Returns `false` when there is no such record or it already has one, or on wasm
/// below Node-API 3; the caller then still owns `reference` and must delete it.
pub(crate) fn set_promise_then(env: sys::napi_env, reference: sys::napi_ref) -> bool {
  // Nothing observes teardown on wasm below Node-API 3 (see [`begin`]), so
  // nothing would ever delete the reference: cache nothing there.
  if cfg!(all(not(feature = "napi3"), target_family = "wasm")) {
    return false;
  }
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return false;
      };
      match registrations
        .iter_mut()
        .rev()
        .find(|registration| registration.env == env)
      {
        Some(registration) if registration.promise_then.is_none() => {
          registration.promise_then = Some(reference);
          true
        }
        _ => false,
      }
    })
    .unwrap_or(false)
}

/// Stores the compiled promise wrapper (or that it is unavailable) in `env`'s newest live
/// record, if that record has none yet.
///
/// Returns `false` when there is no such record or it already has one, or on wasm below
/// Node-API 3; the caller then still owns a `Ready` reference and must delete it.
pub(crate) fn set_promise_wrapper(env: sys::napi_env, wrapper: PromiseWrapper) -> bool {
  if cfg!(all(not(feature = "napi3"), target_family = "wasm")) {
    return false;
  }
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return false;
      };
      match registrations
        .iter_mut()
        .rev()
        .find(|registration| registration.env == env)
      {
        Some(registration) if registration.promise_wrapper == PromiseWrapper::Unset => {
          registration.promise_wrapper = wrapper;
          true
        }
        _ => false,
      }
    })
    .unwrap_or(false)
}

/// The id, the settle mode and the cached functions of `env`'s `AsyncTask` promises, from its
/// newest live record, in one scan. `None` when `env` has no live record.
pub(crate) fn promise_settle(
  env: sys::napi_env,
) -> Option<(RegistrationId, PromiseSettle, PromiseCache)> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let registrations = registrations.try_borrow().ok()?;
      let registration = registrations
        .iter()
        .rev()
        .find(|registration| registration.env == env)?;
      Some((
        registration.id,
        registration.promise_settle,
        PromiseCache {
          then: registration.promise_then,
          wrapper: registration.promise_wrapper,
        },
      ))
    })
    .ok()
    .flatten()
}

/// Moves the settle mode of the record with `id` from `from` to `to`. `false` when the
/// record is gone, busy, or not in `from`.
fn move_promise_settle(id: RegistrationId, from: PromiseSettle, to: PromiseSettle) -> bool {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return false;
      };
      match registrations
        .iter_mut()
        .rev()
        .find(|registration| registration.id == id)
      {
        Some(registration) if registration.promise_settle == from => {
          registration.promise_settle = to;
          true
        }
        _ => false,
      }
    })
    .unwrap_or(false)
}

/// Claims the settle decision of the record with `id`: `Undecided` becomes `Deciding`.
/// `false` when it was not `Undecided`; the caller then decides nothing.
pub(crate) fn start_promise_settle_decision(id: RegistrationId) -> bool {
  move_promise_settle(id, PromiseSettle::Undecided, PromiseSettle::Deciding)
}

/// Stores the settle mode a claimed decision picked.
pub(crate) fn finish_promise_settle_decision(id: RegistrationId, mode: SettleMode) {
  move_promise_settle(id, PromiseSettle::Deciding, PromiseSettle::Decided(mode));
}

/// Marks the record with `id` as registering until it is dropped, on every path out of
/// `napi_register_module_v1`. While it lives, the env's tasks decide no settle mode: the
/// check reads `process.versions`, whose getter may load another addon, and Node holds its
/// addon-loader lock, which is not re-entrant, while this addon registers.
#[cfg(not(feature = "noop"))]
pub(crate) struct RegisteringGuard(RegistrationId);

#[cfg(not(feature = "noop"))]
impl RegisteringGuard {
  /// For a record [`begin`] just made, which starts as registering.
  pub(crate) fn new(id: RegistrationId) -> Self {
    RegisteringGuard(id)
  }
}

#[cfg(not(feature = "noop"))]
impl Drop for RegisteringGuard {
  fn drop(&mut self) {
    move_promise_settle(self.0, PromiseSettle::Registering, PromiseSettle::Undecided);
  }
}

/// Stores this load's class constructor references in the record with `id`.
///
/// Gives them back when the record is gone or already has classes; the caller
/// then still owns them and must delete them.
#[cfg(not(feature = "noop"))]
pub(crate) fn set_classes(
  id: RegistrationId,
  classes: ClassConstructors,
) -> Result<(), ClassConstructors> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return Err(classes);
      };
      match registrations
        .iter_mut()
        .rev()
        .find(|registration| registration.id == id)
      {
        Some(registration) if registration.classes.is_empty() => {
          registration.classes = classes;
          Ok(())
        }
        _ => Err(classes),
      }
    })
    // The thread-local is gone, which only happens while this thread exits: the
    // closure (and `classes` with it) was never run, so nothing to give back.
    .unwrap_or(Ok(()))
}

/// Stores the custom-GC handle in the record with `id`.
///
/// Gives the handle back when the record is gone or already has one; the caller
/// then still owns it and must release it.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn set_custom_gc(
  id: RegistrationId,
  handle: Arc<CustomGcHandle>,
) -> Result<(), Arc<CustomGcHandle>> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(mut registrations) = registrations.try_borrow_mut() else {
        return Err(handle);
      };
      match registrations
        .iter_mut()
        .rev()
        .find(|registration| registration.id == id)
      {
        Some(registration) if registration.custom_gc.is_none() => {
          registration.custom_gc = Some(handle);
          Ok(())
        }
        _ => Err(handle),
      }
    })
    // The thread-local is gone, which only happens while this thread exits:
    // the closure (and `handle` with it) was never run, so nothing to give back.
    .unwrap_or(Ok(()))
}

/// Inspects the registration state of `env` on the current thread.
///
/// Separates a live registered env (`Live`), an env whose registration has
/// already torn down on this thread or whose thread TLS is exiting (`TornDown`),
/// and an env that never registered with `napi-rs` on this thread (`Unregistered`).
#[cfg(not(feature = "noop"))]
pub(crate) fn env_state(env: sys::napi_env) -> EnvState {
  let live = match ENV_REGISTRATIONS.try_with(|registrations| {
    let Ok(registrations) = registrations.try_borrow() else {
      return None;
    };
    Some(
      registrations
        .iter()
        .rev()
        .find(|registration| registration.env == env)
        .map(|registration| registration.id),
    )
  }) {
    Ok(Some(Some(id))) => return EnvState::Live(id),
    Ok(Some(None)) => false,
    // TLS is tearing down or re-entrantly borrowed: never assume live/unregistered.
    Ok(None) | Err(_) => return EnvState::TornDown,
  };
  debug_assert!(!live);
  match TORN_DOWN_ENVS.try_with(|torn_down| {
    let Ok(torn_down) = torn_down.try_borrow() else {
      return true;
    };
    torn_down.contains(&(env as usize))
  }) {
    Ok(true) | Err(_) => EnvState::TornDown,
    Ok(false) => EnvState::Unregistered,
  }
}

/// Whether registration `id` is still live for `env` on the current thread.
///
/// Returns `false` once `env`'s teardown hook or finalizer has removed the
/// record, or when called from another thread or during TLS teardown.
#[cfg(not(feature = "noop"))]
pub(crate) fn is_registration_alive(id: RegistrationId, env: sys::napi_env) -> bool {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(registrations) = registrations.try_borrow() else {
        return false;
      };
      registrations
        .iter()
        .rev()
        .any(|registration| registration.id == id && registration.env == env)
    })
    .unwrap_or(false)
}

/// The custom-GC handle of `env`, from its newest live record.
///
/// `None` when `env` has no live record (never registered, already torn down)
/// or no handle.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn custom_gc(env: sys::napi_env) -> Option<Arc<CustomGcHandle>> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let registrations = registrations.try_borrow().ok()?;
      registrations
        .iter()
        .rev()
        .find(|registration| registration.env == env)?
        .custom_gc
        .clone()
    })
    .ok()
    .flatten()
}

/// Whether a live record on this thread holds exactly `handle`, that is, whether
/// this thread is the JavaScript thread of `handle`'s env and that env is not
/// torn down yet. Compares allocations, so it is immune to env-pointer reuse.
#[cfg(all(feature = "napi4", not(feature = "noop")))]
pub(crate) fn holds_custom_gc(handle: &Arc<CustomGcHandle>) -> bool {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let Ok(registrations) = registrations.try_borrow() else {
        return false;
      };
      registrations.iter().rev().any(|registration| {
        registration
          .custom_gc
          .as_ref()
          .is_some_and(|held| Arc::ptr_eq(held, handle))
      })
    })
    .unwrap_or(false)
}

/// The cached `Reflect` holder reference of `env`, from its newest live record.
///
/// `None` when `env` has no live record (never registered, already torn down,
/// or a build that cannot observe teardown) or no cache.
pub(crate) fn reflect_intrinsics(env: sys::napi_env) -> Option<sys::napi_ref> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let registrations = registrations.try_borrow().ok()?;
      registrations
        .iter()
        .rev()
        .find(|registration| registration.env == env)?
        .reflect_intrinsics
    })
    .ok()
    .flatten()
}

/// The constructor reference of class `js_name` in `env`, from `env`'s newest
/// live record.
///
/// `None` when `env` has no live record (never registered, already torn down) or
/// that load defined no such class. Never falls back to another env's classes.
pub(crate) fn class_constructor_in_env(
  env: sys::napi_env,
  js_name: &'static str,
) -> Option<sys::napi_ref> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let registrations = registrations.try_borrow().ok()?;
      registrations
        .iter()
        .rev()
        .find(|registration| registration.env == env)?
        .classes
        .get(js_name)
        .copied()
    })
    .ok()
    .flatten()
}

/// The constructor reference of class `js_name` from the newest live record on
/// this thread that has one, whatever its env.
pub(crate) fn class_constructor_on_thread(js_name: &'static str) -> Option<sys::napi_ref> {
  ENV_REGISTRATIONS
    .try_with(|registrations| {
      let registrations = registrations.try_borrow().ok()?;
      registrations
        .iter()
        .rev()
        .find_map(|registration| registration.classes.get(js_name).copied())
    })
    .ok()
    .flatten()
}

/// How many cached `Reflect` holder references env teardown has deleted in this
/// process, across every env and every load of this addon.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn env_teardown_reflect_refs_deleted() -> usize {
  REFLECT_REFS_DELETED.load(Ordering::Relaxed)
}

/// How many custom-GC threadsafe functions env teardown has released in this
/// process, across every env and every load of this addon.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn env_teardown_custom_gc_released() -> usize {
  CUSTOM_GC_RELEASED.load(Ordering::Relaxed)
}

/// How many class constructor references env teardown has deleted in this
/// process, across every env and every load of this addon.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn env_teardown_class_refs_deleted() -> usize {
  CLASS_REFS_DELETED.load(Ordering::Relaxed)
}

#[cfg(all(test, not(feature = "noop")))]
pub(crate) mod test_helpers {
  use super::*;

  pub(crate) fn mark_env_torn_down(env: sys::napi_env) {
    TORN_DOWN_ENVS.with(|torn_down| {
      torn_down.borrow_mut().insert(env as usize);
    });
  }

  pub(crate) fn clear_env_torn_down(env: sys::napi_env) {
    TORN_DOWN_ENVS.with(|torn_down| {
      torn_down.borrow_mut().remove(&(env as usize));
    });
  }
}
