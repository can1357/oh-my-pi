//! The promise an `AsyncTask` / `Env::spawn` hands to JavaScript, and how it is settled. The
//! promise of a `JsDeferred` (`#[napi] async fn`, `Env::spawn_future`, `Env::create_deferred`)
//! uses the same machinery, see [`DetachedPromise`].
//!
//! `napi_create_promise` hands back a `napi_deferred` that only `napi_resolve_deferred` /
//! `napi_reject_deferred` free. Both begin with `NAPI_PREAMBLE`, which refuses once the env can
//! no longer run JavaScript. A worker that is terminated while a task is queued or running still
//! runs the task's completion callback during teardown (Node drains the threadpool before it
//! frees the env), and a deferred settled there is never freed: 16 bytes of C++ heap per task,
//! per terminated worker, on every Node version.
//!
//! Each env settles its promises one of two ways ([`SettleMode`], `settle_mode.rs`), picked once,
//! at the env's first task or `JsDeferred` after this addon's registration into it has returned.
//! Not while it registers: the check reads `process.versions`, whose getter may load another
//! addon, and Node holds its addon-loader lock while an addon registers. That lock is not
//! re-entrant, so the nested load would abort the process. A task created while this addon registers (by module-init
//! code) takes the thenable path and decides nothing; so does a task created by a getter while
//! the check runs.
//!
//! * **Deferred**, where the env can only die with its process: the main env of Node (the env's
//!   loop is `uv_default_loop()`), the main env of Bun (it runs on the process main thread), and
//!   every wasm env (emnapi refuses JavaScript only after `Context.destroy()`; the refused
//!   deferred dies with the realm, or stays until process exit if the process continues after
//!   `beforeExit`, the same as before). The deferred is settled when the task completes, as
//!   before. A task still in flight when such an env is torn down leaks its deferred, which only
//!   happens on process exit there.
//! * **Thenable**, everywhere else: workers, Electron and NW.js (whose renderer envs are freed
//!   on navigation), Bun on Windows, Deno, and any host the check cannot place. Described
//!   below. It costs about 2 µs more main-thread CPU per task.
//!
//! Bun is placed by its OS thread, never by libuv. Bun before 1.4.4 exports `uv_default_loop`
//! as a stub that aborts the process, and `process.versions.bun` is writable, so no Bun ever
//! has `uv_default_loop()` called. On other Unix hosts it is called only when the host is
//! Node-based (it exports `node::Buffer::Data`). A faked `process.versions` can only move an env
//! to the other mode: more CPU, or the 16 B deferred leak of the code before #3689. It never
//! crashes the process or settles a promise wrongly. Windows is unchanged: Node, Electron and
//! Bun all have a real libuv there, Deno does not export `uv_default_loop`, and Bun takes the
//! thenable path because its main thread does not run the default loop there.
//!
//! In deferred mode a settling call behaves as before #3689: one that fails after Node freed the
//! deferred gives `Err(generic_failure)` or `Ok(false)` from [`conclude`] and the promise stays
//! pending; `napi_invalid_arg` from a null `napi_value` leaves the deferred unsettled; on WASI, a
//! replaced `globalThis.Promise` whose resolving functions throw leaves one emnapi deferred
//! reference and its promise pending.
//!
//! In thenable mode no deferred exists. [`create`] calls the env's *promise wrapper*, a function
//! compiled once per env, `(then, handle) => settle({ then, handle })` where `settle` is
//! `async (thenable) => thenable`, and hands out the promise it returns. That promise is resolved
//! with the object `settle` returns (the *thenable*): a fresh plain object whose own `then` data
//! property is a native function of this module. Resolving a promise with a thenable reads
//! `then` once, at once, and queues a job that later calls
//! `then.call(thenable, resolve, reject)` with the engine's own resolving functions for the
//! promise. The native `then` keeps them behind two `napi_ref`s, and the completion
//! callback settles the promise by calling one of them. `napi_delete_reference` has no
//! `NAPI_PREAMBLE` (Node and emnapi alike), so the references are deleted on every path,
//! including a settlement the env refused.
//!
//! Building the promise is one call that the env can refuse (`napi_call_function`), and nothing
//! native is allocated before it. `worker.terminate()` runs on the parent thread and can make the
//! env refuse JavaScript at any moment, so this matters: a refused call leaves nothing behind,
//! and a call that ran made a promise the GC owns.
//!
//! The wrapper costs, per env, one `napi_run_script` at the env's first thenable-mode promise (an
//! anonymous script, so the inspector reports one more `scriptParsed`) and one reference, deleted
//! at teardown. Calling it is a JavaScript call, so near the stack limit it can throw a
//! `RangeError` where `napi_create_promise` did not. It throws before any promise exists (the
//! `async` body only returns its argument), so that one promise is then made without the
//! wrapper, below, and the exception is cleared: no task fails to start, and none gets a promise
//! already rejected.
//!
//! Without the wrapper, a thenable-mode task creates a deferred and resolves it right away with
//! the thenable. A terminate that lands between those two calls leaks the deferred (16 B; at most
//! one per terminated worker, since every later `napi_create_promise` on that env is refused).
//! That path keeps that window. It is taken when the env has no registration record to keep the
//! wrapper in, when compiling or calling the wrapper fails (for this task only; the next task
//! tries again), and for good when the host blocks code generation (compiling threw an
//! `EvalError`). Node, Electron, Bun and Deno compile the wrapper with the engine's own script
//! compiler, which `--disallow-code-generation-from-strings` and a Content Security Policy
//! without `'unsafe-eval'` do not block.
//!
//! In thenable mode, nothing here reads a property user code can reach, and nothing calls user
//! code to build or settle the promise on Node: the promise is an `async` function's (made from
//! the intrinsic `%Promise%`, not `globalThis.Promise`), the function is called by
//! `napi_call_function` (not through `Function.prototype.call`), `then` is an own data property of
//! an object no script holds (an object literal defines it, so an `Object.prototype.then`
//! accessor or setter is never consulted), and `resolve` / `reject` are the built-in resolving
//! functions of this very promise. Only the inspector (`Runtime.queryObjects`) can reach the
//! thenable; calling its `then` first steals the promise's settlement, which then never happens.
//! A promise hook (`async_hooks`, `v8.promiseHooks`) does run user code while the promise is
//! made, as it does for `napi_create_promise`. It cannot reach the `then` function, the thenable
//! or the wrapper's functions (the wrapper is strict code, so a structured stack trace hides
//! them).
//! In deferred mode the task's value goes straight to `napi_resolve_deferred`, as before #3689,
//! so V8 reads `then` on an object value and an `Object.prototype.then` accessor runs there.
//!
//! On WASI, emnapi builds these calls in JavaScript: `napi_create_promise` uses the
//! `globalThis.Promise` of the moment, and `napi_call_function` uses the current
//! `Array.prototype.push` and `Function.prototype.apply`. Replacing those can run user code
//! while a task settles; a throwing replacement leaves the promise pending and its exception
//! reported as uncaught.
//!
//! The `then` function and the promise wrapper are shared by every task of an env (kept in the
//! env's registration record, released at its teardown); the thenable carries a number naming the
//! task's [`Slot`].
//!
//! Observable differences of thenable mode from deferred mode (workers, Electron and the other
//! thenable hosts only):
//!
//! * One extra microtask job per task, the one that calls `then`, at the first microtask
//!   checkpoint after the task is created. The task cannot settle the promise before it.
//! * That job runs with the task's promise as its resource, so `async_hooks` and
//!   `v8.promiseHooks` see one extra `before`/`after` pair for the promise, while it is still
//!   pending (standard behaviour for a promise resolved with a thenable).
//! * If the task completes before that job (only possible when its completion runs inside a
//!   nested event loop, before the outer callback drained its microtasks), the outcome is kept
//!   and `then` settles the promise with it. Kept outcomes settle at the next microtask
//!   checkpoint in task-creation order, not completion order, and the task's `finally` runs
//!   before its promise is settled. A kept outcome whose `then` never comes is released at env
//!   teardown.
//!
//! A `JsDeferred` settles from any thread, through a threadsafe function that env teardown can
//! cut off, so nothing is sure to come back to its state. In thenable mode its promise is made
//! by the same wrapper, and its state is a [`DetachedPromise`]: a slot that is not owned, so the
//! env-teardown sweep ([`release_env_promise_states`], run from the env's registration cleanup
//! hook) frees it, settled or not, with its resolving functions and the `deferred_trace` error
//! reference. On Node that hook runs before the threadsafe functions' close callbacks hand
//! their leftover settles to the callback with a null env, so those touch nothing. Only plain
//! numbers travel off the thread. The same differences as above apply, and the env's first
//! `JsDeferred` may pick its settle mode and compile the wrapper. A `JsDeferred` made in
//! deferred mode, or without the wrapper, keeps its `napi_deferred` as before (16 B leaked if
//! its env is torn down before it settles). If every clone is dropped unsettled first, the
//! promise is either rejected (a task's promise, or a deferred dropped on another thread), or
//! cleaned up on its JavaScript thread: `release_deferred_pending` frees the deferred, and the
//! promise stays pending, held by nothing (see `JsDeferred`).

use std::cell::RefCell;
use std::ptr;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::settle_mode::SettleMode;
use crate::bindgen_runtime::env_registration::{PromiseCache, PromiseWrapper, RegistrationId};
use crate::{check_status, sys, Error, Result, Status};

/// Counts the per-task promise states freed, read through [`async_task_promise_states_freed`].
static STATES_FREED: AtomicUsize = AtomicUsize::new(0);
/// Counts the resolving-function pairs released, read through
/// [`async_task_promise_resolvers_released`].
static RESOLVERS_RELEASED: AtomicUsize = AtomicUsize::new(0);
/// Counts the promise wrappers compiled, read through [`async_task_promise_wrappers_compiled`].
static WRAPPERS_COMPILED: AtomicUsize = AtomicUsize::new(0);
/// Counts the thenable-mode promises made without a wrapper, read through
/// [`async_task_promise_wrapper_fallbacks`].
static WRAPPER_FALLBACKS: AtomicUsize = AtomicUsize::new(0);
/// Counts the `JsDeferred` promises made by the wrapper, read through
/// [`js_deferred_thenable_promises_created`].
static DETACHED_CREATED: AtomicUsize = AtomicUsize::new(0);
/// Counts the thenable-mode `JsDeferred` promises made from a deferred, read through
/// [`js_deferred_promise_fallbacks`].
static DETACHED_FALLBACKS: AtomicUsize = AtomicUsize::new(0);

/// How many promise states have been freed in this process — settled or refused, on every env
/// and every load of this addon — for `AsyncTask` / `Env::spawn` and for `JsDeferred`
/// (`#[napi] async fn`, `Env::spawn_future`, `Env::create_deferred`). Each state holds what is
/// needed to settle one promise (its resolving functions, or an outcome kept for them), so a
/// test can tell that teardown left none behind. Deferred-mode envs never move it.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn async_task_promise_states_freed() -> usize {
  STATES_FREED.load(Ordering::Relaxed)
}

/// How many pairs of promise resolving functions (the references `then` keeps) have been
/// released in this process, settled or not, for `AsyncTask` and `JsDeferred` promises alike. A
/// subset of [`async_task_promise_states_freed`]: the states whose `then` had already run.
/// Deferred-mode envs never move it.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn async_task_promise_resolvers_released() -> usize {
  RESOLVERS_RELEASED.load(Ordering::Relaxed)
}

/// How many promise wrappers (see the module docs) have been compiled in this process, on every
/// env and every load of this addon: one per env that created a thenable-mode promise.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn async_task_promise_wrappers_compiled() -> usize {
  WRAPPERS_COMPILED.load(Ordering::Relaxed)
}

/// How many thenable-mode promises have been made without a promise wrapper in this process, by
/// creating a deferred and resolving it with the thenable at once (see the module docs).
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn async_task_promise_wrapper_fallbacks() -> usize {
  WRAPPER_FALLBACKS.load(Ordering::Relaxed)
}

/// How many `JsDeferred` promises (`#[napi] async fn`, `Env::spawn_future`,
/// `Env::create_deferred`) have been made by the promise wrapper in this process, so without a
/// `napi_deferred`. Each one has a promise state, counted by [`async_task_promise_states_freed`]
/// once it is freed.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn js_deferred_thenable_promises_created() -> usize {
  DETACHED_CREATED.load(Ordering::Relaxed)
}

/// How many `JsDeferred` promises created in a thenable-mode env have been made with
/// `napi_create_promise` instead, in this process: the env had no registration record, the host
/// blocks the wrapper, or the wrapper could not be used for that one promise (see the module
/// docs). Such a promise leaks its 16 B deferred if its env is torn down before it settles.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn js_deferred_promise_fallbacks() -> usize {
  DETACHED_FALLBACKS.load(Ordering::Relaxed)
}

/// `"deferred"` or `"thenable"`: how `AsyncTask` / `Env::spawn` promises created in `env`
/// right now are settled. Picks the env's mode the way its first task would, when it is not
/// picked yet: `"thenable"`, picking nothing, while this addon registers into `env`.
/// `"thenable"` for an env this addon has no record of.
///
/// Introspection hook for napi-rs' own tests. No stability guarantee.
#[doc(hidden)]
pub fn async_task_promise_settle_mode(env: sys::napi_env) -> &'static str {
  settle_mode_of(env).0.as_str()
}

/// The settle mode of `env`, and its cached functions when it has a record: one record lookup on
/// native once the mode is picked, none on wasm. Picks it at the env's first call after
/// registration (see the module docs).
fn settle_mode_of(env: sys::napi_env) -> (SettleMode, Option<PromiseCache>) {
  use crate::bindgen_runtime::env_registration::{self, PromiseSettle};

  if cfg!(target_family = "wasm") {
    return (SettleMode::Deferred, None);
  }
  match env_registration::promise_settle(env) {
    Some((_, PromiseSettle::Decided(mode), cache)) => (mode, Some(cache)),
    Some((id, PromiseSettle::Undecided, cache)) => (decide_settle_mode(env, id), Some(cache)),
    // Still registering, or another call is picking the mode right now.
    Some((_, PromiseSettle::Registering | PromiseSettle::Deciding, cache)) => {
      (SettleMode::Thenable, Some(cache))
    }
    None => (SettleMode::Thenable, None),
  }
}

/// Picks and stores the settle mode of the record `id` of `env`. Runs inside a call into
/// `env` on its thread, after registration returned: no loader lock is held. The check may
/// run user getters, which may create tasks; those see `Deciding` and take the thenable path.
#[cold]
fn decide_settle_mode(env: sys::napi_env, id: RegistrationId) -> SettleMode {
  use crate::bindgen_runtime::env_registration;

  // An exception pending now says nothing about the host: decide at a later task.
  if exception_pending(env) || !env_registration::start_promise_settle_decision(id) {
    return SettleMode::Thenable;
  }
  #[cfg(not(feature = "noop"))]
  let mode = super::settle_mode::detect(env);
  // Nothing registers under `noop`, so there is no record to decide for.
  #[cfg(feature = "noop")]
  let mode = SettleMode::Thenable;
  env_registration::finish_promise_settle_decision(id, mode);
  mode
}

/// The value a promise is settled with.
pub(super) enum Settlement {
  Fulfill(sys::napi_value),
  Reject(sys::napi_value),
}

/// Own property of the thenable that carries its [`Handle`].
const HANDLE_KEY: &std::ffi::CStr = c"handle";
/// Own property of a kept outcome's holder object.
const VALUE_KEY: &std::ffi::CStr = c"value";
/// Generations wrap below 2^20, so `generation << 32 | index` is exact in an `f64`.
const GENERATION_MASK: u32 = (1 << 20) - 1;

/// Names one [`Slot`]. Travels through JavaScript as a number on the thenable, so a stale or
/// forged one must be harmless: a slot is only used when its generation and env match.
#[derive(Clone, Copy, PartialEq, Eq)]
struct Handle {
  index: u32,
  generation: u32,
}

impl Handle {
  fn to_f64(self) -> f64 {
    (((self.generation as u64) << 32) | self.index as u64) as f64
  }

  fn from_f64(value: f64) -> Option<Handle> {
    if !(0.0..(1u64 << 52) as f64).contains(&value) || value.trunc() != value {
      return None;
    }
    let bits = value as u64;
    Some(Handle {
      index: bits as u32,
      generation: (bits >> 32) as u32,
    })
  }
}

enum SlotState {
  /// `then` has not been called yet.
  Waiting,
  /// `then` was called: the promise's resolving functions.
  Resolvers {
    resolve: sys::napi_ref,
    reject: sys::napi_ref,
  },
  /// The task finished before `then` was called: a holder object whose own `value` property is
  /// the outcome.
  Kept {
    fulfill: bool,
    holder: sys::napi_ref,
  },
}

/// What one task's promise needs to be settled.
struct Slot {
  env: sys::napi_env,
  /// Whether the task's [`ThenableSettler`] still exists. Always `false` for a
  /// [`DetachedPromise`]: nothing is sure to come back to it on the JavaScript thread, so the
  /// env-teardown sweep frees it.
  owned: bool,
  state: SlotState,
  /// One more reference the slot's owner keeps here, so that the env-teardown sweep deletes it
  /// if the owner never comes back (a `JsDeferred`'s trace error). Null when there is none.
  extra: sys::napi_ref,
}

struct Entry {
  generation: u32,
  slot: Option<Slot>,
  /// Not null: the slot was freed before its `then` job ran, and this is its env. The job is
  /// still queued in JavaScript and carries this entry's handle, so the index stays reserved
  /// until the job comes ([`Slots::retire`]) or the env is torn down ([`Slots::retire_env`]).
  /// Reused at once, the index could meet that job again with the same generation after the
  /// generation counter wrapped (2^20 slots made and freed in one synchronous job), and the job
  /// would put another promise's resolving functions into the new slot.
  awaiting_then: sys::napi_env,
}

/// A table of [`Slot`]s. Generations come from one counter, not per entry, so the table can be
/// dropped whole once it is empty without a later slot reusing a stale handle's generation.
/// The generation is a second line of defense: an index is never reused while a queued `then`
/// job can still carry its handle (see [`Entry::awaiting_then`]).
#[derive(Default)]
struct Slots {
  entries: Vec<Entry>,
  free: Vec<u32>,
  next_generation: u32,
}

/// An empty table bigger than this gives its memory back.
const RETAINED_SLOTS: usize = 1024;

impl Slots {
  fn insert(&mut self, slot: Slot) -> Handle {
    let generation = self.next_generation;
    self.next_generation = (generation + 1) & GENERATION_MASK;
    let entry = Entry {
      generation,
      slot: Some(slot),
      awaiting_then: ptr::null_mut(),
    };
    let index = match self.free.pop() {
      Some(index) => {
        self.entries[index as usize] = entry;
        index
      }
      None => {
        self.entries.push(entry);
        (self.entries.len() - 1) as u32
      }
    };
    Handle { index, generation }
  }

  fn get_mut(&mut self, handle: Handle, env: sys::napi_env) -> Option<&mut Slot> {
    let entry = self.entries.get_mut(handle.index as usize)?;
    if entry.generation != handle.generation {
      return None;
    }
    entry.slot.as_mut().filter(|slot| slot.env == env)
  }

  /// Frees the slot `handle` names (which must exist), so the handle never matches again.
  ///
  /// `then_may_come`: a `then` job for this slot may still be queued in JavaScript. When it has
  /// not run yet (the slot is `Waiting`), the index is not reused until it does (see
  /// [`Entry::awaiting_then`]). `false` when no job was ever queued, when the caller is that job,
  /// or when the env can run no job any more.
  fn remove(&mut self, handle: Handle, then_may_come: bool) -> Slot {
    let entry = &mut self.entries[handle.index as usize];
    let slot = entry.slot.take().expect("a slot is removed once");
    if then_may_come && matches!(slot.state, SlotState::Waiting) {
      entry.awaiting_then = slot.env;
    } else {
      self.free.push(handle.index);
    }
    STATES_FREED.fetch_add(1, Ordering::Relaxed);
    slot
  }

  /// The `then` job of a slot freed before it ran has come: nothing carries `handle` any more,
  /// so its index can be reused. `true` when `handle` named such a slot.
  fn retire(&mut self, handle: Handle, env: sys::napi_env) -> bool {
    let Some(entry) = self.entries.get_mut(handle.index as usize) else {
      return false;
    };
    if entry.generation != handle.generation
      || entry.slot.is_some()
      || entry.awaiting_then.is_null()
      || entry.awaiting_then != env
    {
      return false;
    }
    entry.awaiting_then = ptr::null_mut();
    self.free.push(handle.index);
    true
  }

  /// `env` is torn down: its queued `then` jobs never run, so the indexes they reserved are free.
  #[cfg(all(
    not(feature = "noop"),
    any(feature = "napi3", not(target_family = "wasm"))
  ))]
  fn retire_env(&mut self, env: sys::napi_env) {
    for (index, entry) in self.entries.iter_mut().enumerate() {
      if entry.slot.is_none() && !entry.awaiting_then.is_null() && entry.awaiting_then == env {
        entry.awaiting_then = ptr::null_mut();
        self.free.push(index as u32);
      }
    }
  }

  /// Gives the memory of a large table back once no slot is in use. Kept apart from
  /// [`Self::remove`], so a sweep can remove while it walks the table.
  fn shrink_if_idle(&mut self) {
    if self.free.len() == self.entries.len() && self.entries.capacity() > RETAINED_SLOTS {
      self.entries = Vec::new();
      self.free = Vec::new();
    }
  }
}

thread_local! {
  // A slot is only touched on its env's JavaScript thread: the task is created, completed and
  // dropped there, and `then` is called there. One thread can host several envs (a reload, a
  // hardlinked copy), so every lookup also matches the env. The borrow is never held across a
  // call that can run JavaScript, which could create or settle another task.
  static SLOTS: RefCell<Slots> = RefCell::new(Slots::default());
}

fn with_slots<R>(f: impl FnOnce(&mut Slots) -> R) -> Option<R> {
  SLOTS
    .try_with(|slots| {
      slots.try_borrow_mut().ok().map(|mut slots| {
        let result = f(&mut slots);
        slots.shrink_if_idle();
        result
      })
    })
    .ok()
    .flatten()
}

/// What [`ThenableSettler::settle`] found in its slot.
enum Observed {
  Waiting,
  Resolvers(sys::napi_ref, sys::napi_ref),
  /// Already settled or kept (or the slot is unreachable).
  Settled,
}

/// Owns the settle side of one promise.
pub(super) enum PromiseSettler {
  Deferred(DeferredSettler),
  Thenable(ThenableSettler),
}

impl PromiseSettler {
  /// Settles the promise once. Returns the raw status of the settling call, so the caller can
  /// tell a refusal (teardown, pending exception) from success.
  fn settle(&mut self, settlement: &Settlement) -> sys::napi_status {
    match self {
      PromiseSettler::Deferred(settler) => settler.settle(settlement),
      PromiseSettler::Thenable(settler) => settler.settle(settlement),
    }
  }

  /// Whether `settle` may run again after it reported an exception. A deferred whose settling
  /// call ran is gone (Node frees it before it reports what the call caught), so it may not.
  fn can_retry(&self) -> bool {
    match self {
      PromiseSettler::Deferred(settler) => settler.deferred.is_some(),
      PromiseSettler::Thenable(_) => true,
    }
  }

  /// Ends a promise that was never handed to JavaScript (`async_work::run` failed to create or
  /// queue the work): a deferred is resolved with `undefined`, so it is freed and no rejection
  /// goes unhandled; a thenable state is released.
  pub(super) fn discard(&mut self) {
    match self {
      PromiseSettler::Deferred(settler) => settler.discard(),
      PromiseSettler::Thenable(settler) => settler.release(),
    }
  }
}

/// The deferred of a promise settled at completion ([`SettleMode::Deferred`]). Dropping it
/// settles nothing: a deferred nobody settled stays with the env, as before #3689. Deferred mode
/// is only picked where that env dies with its process or realm.
pub(super) struct DeferredSettler {
  env: sys::napi_env,
  /// `None` once a settling call ran: Node frees the deferred inside that call.
  deferred: Option<sys::napi_deferred>,
  /// The env refused a settling call because it cannot run JavaScript any more.
  refused: bool,
}

impl DeferredSettler {
  fn settle(&mut self, settlement: &Settlement) -> sys::napi_status {
    let Some(deferred) = self.deferred.take() else {
      return sys::Status::napi_generic_failure;
    };
    let status = unsafe {
      match *settlement {
        Settlement::Fulfill(value) => sys::napi_resolve_deferred(self.env, deferred, value),
        Settlement::Reject(value) => sys::napi_reject_deferred(self.env, deferred, value),
      }
    };
    // `NAPI_PREAMBLE` refused before the deferred was touched (Node and emnapi). Node also
    // returns `napi_pending_exception` AFTER it freed the deferred when the call caught an
    // exception (`delete deferred_ref`, then `GET_RETURN_STATUS`). `conclude` clears
    // exceptions before calling, so an exception pending now came from inside the call: then
    // the deferred is gone.
    if matches!(
      status,
      sys::Status::napi_pending_exception | sys::Status::napi_cannot_run_js
    ) && !exception_pending(self.env)
    {
      self.deferred = Some(deferred);
      self.refused = true;
    }
    status
  }

  /// Resolves a deferred nobody settled with `undefined`, so it is freed. Skipped after a
  /// refusal: the env is going away and would refuse again. A pending exception is set aside
  /// and thrown again afterwards.
  fn discard(&mut self) {
    if self.deferred.is_none() || self.refused {
      return;
    }
    let env = self.env;
    let pending = take_pending_exception(env);
    let mut undefined = ptr::null_mut();
    if unsafe { sys::napi_get_undefined(env, &mut undefined) } == sys::Status::napi_ok {
      let _ = self.settle(&Settlement::Fulfill(undefined));
    }
    if let Some(exception) = pending {
      unsafe { sys::napi_throw(env, exception) };
    }
  }
}

/// Whether an exception is pending on `env`. `napi_is_exception_pending` has no
/// `NAPI_PREAMBLE`. `false` when it cannot tell.
fn exception_pending(env: sys::napi_env) -> bool {
  let mut pending = false;
  (unsafe { sys::napi_is_exception_pending(env, &mut pending) } == sys::Status::napi_ok) && pending
}

/// The thenable state of one promise ([`SettleMode::Thenable`]). Dropping it releases what it
/// holds, settled or not, so every path that ends an `AsyncWork` — normal settlement, a
/// settlement refused during teardown, a failed create/queue, a cancellation — frees it.
pub(super) struct ThenableSettler {
  env: sys::napi_env,
  handle: Option<Handle>,
  /// Whether the promise's `then` job was queued in JavaScript (the promise was made). Until
  /// then, a freed slot's index is reused at once: no job carries its handle.
  then_queued: bool,
}

impl ThenableSettler {
  /// Settles the promise once, in thenable mode. Returns the raw status of the settling call,
  /// so the caller can tell a refusal (teardown, pending exception) from success.
  fn settle(&mut self, settlement: &Settlement) -> sys::napi_status {
    let Some(handle) = self.handle else {
      return sys::Status::napi_generic_failure;
    };
    let (value, fulfill) = match *settlement {
      Settlement::Fulfill(value) => (value, true),
      Settlement::Reject(value) => (value, false),
    };
    let env = self.env;
    let state = with_slots(
      |slots| match slots.get_mut(handle, env).map(|slot| &slot.state) {
        Some(SlotState::Waiting) => Observed::Waiting,
        Some(&SlotState::Resolvers { resolve, reject }) => Observed::Resolvers(resolve, reject),
        Some(SlotState::Kept { .. }) | None => Observed::Settled,
      },
    )
    .unwrap_or(Observed::Settled);
    match state {
      // `then` was called: settle through the promise's own resolving function.
      Observed::Resolvers(resolve, reject) => {
        let status = call_resolving_function(env, if fulfill { resolve } else { reject }, value);
        if status == sys::Status::napi_ok {
          self.release();
        }
        status
      }
      // `then` has not been called yet: keep the outcome for it, if JavaScript can still run.
      Observed::Waiting => keep_outcome(env, handle, fulfill, value),
      Observed::Settled => sys::Status::napi_generic_failure,
    }
  }

  fn release(&mut self) {
    let Some(handle) = self.handle.take() else {
      return;
    };
    let env = self.env;
    let then_queued = self.then_queued;
    let mut extra = ptr::null_mut();
    let resolvers = with_slots(|slots| {
      let slot = slots.get_mut(handle, env)?;
      match slot.state {
        // Settled or not, `then` has run and will not run again.
        SlotState::Resolvers { resolve, reject } => {
          extra = slots.remove(handle, false).extra;
          Some((resolve, reject))
        }
        // Nothing to settle any more; a `then` that still comes finds no slot, gives the index
        // back and does nothing else.
        SlotState::Waiting => {
          extra = slots.remove(handle, then_queued).extra;
          None
        }
        // The kept outcome now waits for `then` alone (or for env teardown).
        SlotState::Kept { .. } => {
          slot.owned = false;
          None
        }
      }
    })
    .flatten();
    if !extra.is_null() {
      unsafe { sys::napi_delete_reference(env, extra) };
    }
    if let Some((resolve, reject)) = resolvers {
      // No `NAPI_PREAMBLE` on Node or emnapi: legal while the env refuses to run JavaScript
      // and while an exception is pending. The completion callback that drops this runs before
      // the env is freed.
      unsafe {
        sys::napi_delete_reference(env, resolve);
        sys::napi_delete_reference(env, reject);
      }
      RESOLVERS_RELEASED.fetch_add(1, Ordering::Relaxed);
    }
  }
}

impl Drop for ThenableSettler {
  fn drop(&mut self) {
    self.release();
  }
}

/// `function(value)` with `undefined` as `this`, where `function` is behind `reference`.
fn call_resolving_function(
  env: sys::napi_env,
  reference: sys::napi_ref,
  value: sys::napi_value,
) -> sys::napi_status {
  let mut function = ptr::null_mut();
  let status = unsafe { sys::napi_get_reference_value(env, reference, &mut function) };
  if status != sys::Status::napi_ok {
    return status;
  }
  if function.is_null() {
    // Strong references (refcount 1) cannot be collected; nothing else can empty them.
    return sys::Status::napi_generic_failure;
  }
  call_with_undefined_this(env, function, value)
}

fn call_with_undefined_this(
  env: sys::napi_env,
  function: sys::napi_value,
  value: sys::napi_value,
) -> sys::napi_status {
  let mut undefined = ptr::null_mut();
  let status = unsafe { sys::napi_get_undefined(env, &mut undefined) };
  if status != sys::Status::napi_ok {
    return status;
  }
  unsafe { sys::napi_call_function(env, undefined, function, 1, &value, ptr::null_mut()) }
}

/// Keeps the outcome of a task that finished before its promise's `then` was called.
///
/// Refused — with the status `napi_call_function` would have given — when the env cannot run
/// JavaScript: `then` can then never be called, and [`conclude`] treats it as teardown.
/// `napi_strict_equals` is the probe because it has a `NAPI_PREAMBLE` (Node and emnapi) and
/// runs no JavaScript.
fn keep_outcome(
  env: sys::napi_env,
  handle: Handle,
  fulfill: bool,
  value: sys::napi_value,
) -> sys::napi_status {
  let mut equal = false;
  let status = unsafe { sys::napi_strict_equals(env, value, value, &mut equal) };
  if status != sys::Status::napi_ok {
    return status;
  }
  // A plain object holds the value: references to primitives need Node-API 10.
  let mut holder = ptr::null_mut();
  let status = unsafe { sys::napi_create_object(env, &mut holder) };
  if status != sys::Status::napi_ok {
    return status;
  }
  let status = define_own_data_property(env, holder, VALUE_KEY, value);
  if status != sys::Status::napi_ok {
    return status;
  }
  let mut holder_ref = ptr::null_mut();
  let status = unsafe { sys::napi_create_reference(env, holder, 1, &mut holder_ref) };
  if status != sys::Status::napi_ok {
    return status;
  }
  let kept = with_slots(|slots| match slots.get_mut(handle, env) {
    Some(slot) if matches!(slot.state, SlotState::Waiting) => {
      slot.state = SlotState::Kept {
        fulfill,
        holder: holder_ref,
      };
      true
    }
    _ => false,
  })
  .unwrap_or(false);
  if !kept {
    unsafe { sys::napi_delete_reference(env, holder_ref) };
    return sys::Status::napi_generic_failure;
  }
  sys::Status::napi_ok
}

/// Defines `object[key] = value` as an own data property: an accessor or a setter on the
/// prototype chain is never consulted (`napi_set_named_property` would call it).
fn define_own_data_property(
  env: sys::napi_env,
  object: sys::napi_value,
  key: &std::ffi::CStr,
  value: sys::napi_value,
) -> sys::napi_status {
  let descriptor = data_property(key, value);
  unsafe { sys::napi_define_properties(env, object, 1, &descriptor) }
}

fn data_property(key: &std::ffi::CStr, value: sys::napi_value) -> sys::napi_property_descriptor {
  sys::napi_property_descriptor {
    utf8name: key.as_ptr(),
    name: ptr::null_mut(),
    method: None,
    getter: None,
    setter: None,
    value,
    // All three attributes send Node to its `CreateDataProperty` fast path, which still defines
    // an own property and never consults the prototype chain. Nothing else holds the object.
    attributes: sys::PropertyAttributes::writable
      | sys::PropertyAttributes::enumerable
      | sys::PropertyAttributes::configurable,
    data: ptr::null_mut(),
  }
}

/// Reads `object[key]` where `key` is an own data property this module defined: no prototype
/// lookup, no user code.
fn own_data_property(
  env: sys::napi_env,
  object: sys::napi_value,
  key: &std::ffi::CStr,
) -> Option<sys::napi_value> {
  let mut value = ptr::null_mut();
  (unsafe { sys::napi_get_named_property(env, object, key.as_ptr(), &mut value) }
    == sys::Status::napi_ok
    && !value.is_null())
  .then_some(value)
}

/// The thenable's `then`, shared by every task of an env. The promise's resolve job calls it
/// with the thenable as `this` and the promise's resolving functions, which are kept in the
/// task's slot. A slot that already holds the task's outcome is settled right here instead.
unsafe extern "C" fn thenable_then(
  env: sys::napi_env,
  info: sys::napi_callback_info,
) -> sys::napi_value {
  let mut argc = 2;
  let mut argv = [ptr::null_mut(); 2];
  let mut this = ptr::null_mut();
  if unsafe {
    sys::napi_get_cb_info(
      env,
      info,
      &mut argc,
      argv.as_mut_ptr(),
      &mut this,
      ptr::null_mut(),
    )
  } != sys::Status::napi_ok
    || argc < 2
  {
    return ptr::null_mut();
  }
  let Some(handle) = thenable_handle(env, this) else {
    return ptr::null_mut();
  };
  let kept = with_slots(|slots| {
    // The slot was freed before this job ran: the index it reserved is free now.
    if slots.retire(handle, env) {
      return None;
    }
    let slot = slots.get_mut(handle, env)?;
    match slot.state {
      SlotState::Waiting => {
        let mut resolve = ptr::null_mut();
        let mut reject = ptr::null_mut();
        // `napi_create_reference` runs no JavaScript, so the borrow may stay held.
        unsafe {
          if sys::napi_create_reference(env, argv[0], 1, &mut resolve) != sys::Status::napi_ok {
            return None;
          }
          if sys::napi_create_reference(env, argv[1], 1, &mut reject) != sys::Status::napi_ok {
            sys::napi_delete_reference(env, resolve);
            return None;
          }
        }
        slot.state = SlotState::Resolvers { resolve, reject };
        None
      }
      // Called again: the first call already took the resolving functions.
      SlotState::Resolvers { .. } => None,
      SlotState::Kept { fulfill, holder } => {
        // Settle below, outside the borrow. A task that still owns the slot stops caring once
        // its outcome is kept, so the slot goes now either way.
        let extra = slots.remove(handle, false).extra;
        Some((fulfill, holder, extra))
      }
    }
  })
  .flatten();
  if let Some((fulfill, holder, extra)) = kept {
    if !extra.is_null() {
      unsafe { sys::napi_delete_reference(env, extra) };
    }
    let mut holder_value = ptr::null_mut();
    if unsafe { sys::napi_get_reference_value(env, holder, &mut holder_value) }
      == sys::Status::napi_ok
      && !holder_value.is_null()
    {
      if let Some(value) = own_data_property(env, holder_value, VALUE_KEY) {
        // A resolving function never throws; anything pending afterwards came from elsewhere
        // and propagates to the job, which ignores it once the promise is settled.
        call_with_undefined_this(env, argv[if fulfill { 0 } else { 1 }], value);
      }
    }
    unsafe { sys::napi_delete_reference(env, holder) };
  }
  ptr::null_mut()
}

fn thenable_handle(env: sys::napi_env, thenable: sys::napi_value) -> Option<Handle> {
  let mut value_type = sys::ValueType::napi_undefined;
  if unsafe { sys::napi_typeof(env, thenable, &mut value_type) } != sys::Status::napi_ok
    || value_type != sys::ValueType::napi_object
  {
    return None;
  }
  let handle = own_data_property(env, thenable, HANDLE_KEY)?;
  let mut number = 0.0;
  if unsafe { sys::napi_get_value_double(env, handle, &mut number) } != sys::Status::napi_ok {
    return None;
  }
  Handle::from_f64(number)
}

/// The `then` function of `env`: `cached`, the one in the env's registration record, or one
/// created and cached on first use. A fresh one when there is no record to keep it in (wasm
/// below Node-API 3, an env that never registered this addon).
fn then_function(env: sys::napi_env, cached: Option<sys::napi_ref>) -> Result<sys::napi_value> {
  if let Some(reference) = cached {
    let mut function = ptr::null_mut();
    if unsafe { sys::napi_get_reference_value(env, reference, &mut function) }
      == sys::Status::napi_ok
      && !function.is_null()
    {
      return Ok(function);
    }
  }
  let mut function = ptr::null_mut();
  check_status!(
    unsafe {
      sys::napi_create_function(
        env,
        c"then".as_ptr().cast(),
        4,
        Some(thenable_then),
        ptr::null_mut(),
        &mut function,
      )
    },
    "Create promise thenable failed in async_work::run"
  )?;
  let mut reference = ptr::null_mut();
  if unsafe { sys::napi_create_reference(env, function, 1, &mut reference) } == sys::Status::napi_ok
    && !crate::bindgen_runtime::env_registration::set_promise_then(env, reference)
  {
    unsafe { sys::napi_delete_reference(env, reference) };
  }
  Ok(function)
}

/// `{ then, handle }` as own data properties.
fn create_thenable(
  env: sys::napi_env,
  handle: Handle,
  cached_then: Option<sys::napi_ref>,
) -> Result<sys::napi_value> {
  let then = then_function(env, cached_then)?;
  let mut number = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_double(env, handle.to_f64(), &mut number) },
    "Create promise thenable failed in async_work::run"
  )?;
  let mut thenable = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_object(env, &mut thenable) },
    "Create promise thenable failed in async_work::run"
  )?;
  let properties = [
    data_property(c"then", then),
    data_property(HANDLE_KEY, number),
  ];
  check_status!(
    unsafe { sys::napi_define_properties(env, thenable, properties.len(), properties.as_ptr()) },
    "Create promise thenable failed in async_work::run"
  )?;
  Ok(thenable)
}

/// Source of the env's promise wrapper (see the module docs). The promise of the inner `async`
/// function is the task's promise: the engine resolves it with the object that function returns,
/// so it reads `then` (an own data property, which the object literal defines) and queues the job
/// that calls it, as `napi_resolve_deferred` with the same thenable does. The keys must equal
/// `then` and [`HANDLE_KEY`].
///
/// The object literal is built in the outer, plain function, not in the `async` body. Near the
/// stack limit, building it can throw a `RangeError` (V8 checks the stack while it copies the
/// literal). In an `async` body that error rejects the promise, and the call still returns
/// `napi_ok`, so the task would run with a promise already rejected. In the plain function it is
/// thrown before any promise exists, and [`create_wrapped`] sees it. The `async` body only
/// returns its argument, which does not check the stack.
///
/// The script is strict, so `CallSite.getFunction()` gives a promise hook neither function.
const PROMISE_WRAPPER_SOURCE: &str =
  "'use strict';(() => { const settle = async (thenable) => thenable; return (then, handle) => settle({ then, handle }) })()";

/// The env's promise wrapper: the one in its registration record, or one compiled now and kept
/// there. `None` when there is none to use for this task; the caller then takes the deferred
/// path.
fn promise_wrapper(env: sys::napi_env, cached: PromiseWrapper) -> Option<sys::napi_value> {
  match cached {
    PromiseWrapper::Ready(reference) => {
      let mut function = ptr::null_mut();
      (unsafe { sys::napi_get_reference_value(env, reference, &mut function) }
        == sys::Status::napi_ok
        && !function.is_null())
      .then_some(function)
    }
    PromiseWrapper::Unavailable => None,
    PromiseWrapper::Unset => compile_promise_wrapper(env),
  }
}

/// Compiles the env's promise wrapper and keeps it in the env's record. `None` when it could not
/// be compiled. Only a failure that will happen again (the host blocks code generation, so
/// compiling threw an `EvalError`) is remembered; any other one (a refusal, a termination, a
/// `RangeError` near the stack limit) leaves the next task to try again.
#[cold]
fn compile_promise_wrapper(env: sys::napi_env) -> Option<sys::napi_value> {
  use crate::bindgen_runtime::env_registration;

  // An exception pending now is not ours to clear, and would make the compile fail for a
  // reason unrelated to the host.
  if exception_pending(env) {
    return None;
  }
  let mut source = ptr::null_mut();
  if unsafe {
    sys::napi_create_string_utf8(
      env,
      PROMISE_WRAPPER_SOURCE.as_ptr().cast(),
      PROMISE_WRAPPER_SOURCE.len() as isize,
      &mut source,
    )
  } != sys::Status::napi_ok
  {
    return None;
  }
  let mut function = ptr::null_mut();
  if unsafe { sys::napi_run_script(env, source, &mut function) } != sys::Status::napi_ok {
    // Nothing was pending before the compile, so what is pending now is what it threw.
    if let Some(thrown) = take_pending_exception(env) {
      if crate::error::is_eval_error_without_get(env, thrown) {
        env_registration::set_promise_wrapper(env, PromiseWrapper::Unavailable);
      }
    }
    return None;
  }
  let mut value_type = sys::ValueType::napi_undefined;
  if unsafe { sys::napi_typeof(env, function, &mut value_type) } != sys::Status::napi_ok
    || value_type != sys::ValueType::napi_function
  {
    // The script ran but gave no function: the host would answer the same every time.
    env_registration::set_promise_wrapper(env, PromiseWrapper::Unavailable);
    return None;
  }
  WRAPPERS_COMPILED.fetch_add(1, Ordering::Relaxed);
  let mut reference = ptr::null_mut();
  if unsafe { sys::napi_create_reference(env, function, 1, &mut reference) } == sys::Status::napi_ok
    && !env_registration::set_promise_wrapper(env, PromiseWrapper::Ready(reference))
  {
    unsafe { sys::napi_delete_reference(env, reference) };
  }
  Some(function)
}

/// Creates the promise for one task, settled the way `env`'s [`SettleMode`] says: in deferred
/// mode the returned settler keeps the deferred for the task's completion; in thenable mode the
/// promise comes from the env's promise wrapper (or, without one, from a deferred settled right
/// away), and the thenable's `then` hands the promise's resolving functions to the returned
/// settler.
pub(super) fn create(env: sys::napi_env) -> Result<(sys::napi_value, PromiseSettler)> {
  let (mode, cache) = settle_mode_of(env);
  if mode == SettleMode::Thenable {
    // Without a record there is nowhere to keep a wrapper.
    if let Some((cache, wrapper)) =
      cache.and_then(|cache| promise_wrapper(env, cache.wrapper).map(|wrapper| (cache, wrapper)))
    {
      if let Some((promise, settler)) = create_wrapped(env, wrapper, cache.then, true)? {
        return Ok((promise, PromiseSettler::Thenable(settler)));
      }
    }
    WRAPPER_FALLBACKS.fetch_add(1, Ordering::Relaxed);
  }
  let mut promise = ptr::null_mut();
  let mut deferred = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_create_promise(env, &mut deferred, &mut promise) },
    "Create promise failed in async_work::run"
  )?;
  match mode {
    SettleMode::Deferred => Ok((
      promise,
      PromiseSettler::Deferred(DeferredSettler {
        env,
        deferred: Some(deferred),
        refused: false,
      }),
    )),
    SettleMode::Thenable => {
      create_thenable_settler(env, deferred, cache.and_then(|cache| cache.then))
        .map(|settler| (promise, PromiseSettler::Thenable(settler)))
    }
  }
}

/// Thenable mode with the env's promise wrapper: the promise is made by one call, and nothing
/// native is allocated before it. If the env refuses that call (it started tearing down), only
/// the slot is left, and dropping the settler frees it.
///
/// `Ok(None)` tells the caller to make this one promise from a deferred instead, the way it did
/// before the wrapper existed: when an exception is already pending (not ours to clear; the
/// deferred path refuses it the same way), when the slot table cannot be used, or when the call
/// threw. A call into JavaScript can throw a `RangeError` near the stack limit where
/// `napi_create_promise` does not, and the wrapper throws it before any promise exists (see
/// [`PROMISE_WRAPPER_SOURCE`]). That exception is the call's own, so it is cleared, and the
/// promise does not depend on how much stack is left.
///
/// `owned` is `true` for a task, whose settler always comes back to the slot, and `false` for a
/// [`DetachedPromise`], whose slot the env-teardown sweep frees.
fn create_wrapped(
  env: sys::napi_env,
  wrapper: sys::napi_value,
  cached_then: Option<sys::napi_ref>,
  owned: bool,
) -> Result<Option<(sys::napi_value, ThenableSettler)>> {
  if exception_pending(env) {
    return Ok(None);
  }
  let handle = with_slots(|slots| {
    slots.insert(Slot {
      env,
      owned,
      state: SlotState::Waiting,
      extra: ptr::null_mut(),
    })
  });
  let Some(handle) = handle else {
    return Ok(None);
  };
  // Dropping the settler on an error below frees the slot.
  let mut settler = ThenableSettler {
    env,
    handle: Some(handle),
    then_queued: false,
  };
  let then = then_function(env, cached_then)?;
  let mut args = [then, ptr::null_mut()];
  check_status!(
    unsafe { sys::napi_create_double(env, handle.to_f64(), &mut args[1]) },
    "Create promise thenable failed in async_work::run"
  )?;
  let mut undefined = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_get_undefined(env, &mut undefined) },
    "Create promise failed in async_work::run"
  )?;
  let mut promise = ptr::null_mut();
  let status = unsafe {
    sys::napi_call_function(
      env,
      undefined,
      wrapper,
      args.len(),
      args.as_ptr(),
      &mut promise,
    )
  };
  if status == sys::Status::napi_ok {
    // The promise exists, and its `then` job is queued.
    settler.then_queued = true;
    return Ok(Some((promise, settler)));
  }
  // Nothing was pending before the call, so a pending exception is what the call threw.
  if take_pending_exception(env).is_some() {
    return Ok(None);
  }
  // Refused: the env cannot run JavaScript any more, and would refuse a deferred too.
  Err(Error::new(
    Status::from(status),
    "Create promise failed in async_work::run".to_owned(),
  ))
}

/// Settles `deferred` right away with a thenable whose `then` hands the promise's resolving
/// functions to the returned settler. Only used without a promise wrapper (see the module docs).
fn create_thenable_settler(
  env: sys::napi_env,
  deferred: sys::napi_deferred,
  cached_then: Option<sys::napi_ref>,
) -> Result<ThenableSettler> {
  let handle = with_slots(|slots| {
    slots.insert(Slot {
      env,
      owned: true,
      state: SlotState::Waiting,
      extra: ptr::null_mut(),
    })
  });
  // Dropping the settler on an error below frees the slot.
  let mut settler = ThenableSettler {
    env,
    handle,
    then_queued: false,
  };
  let thenable = match handle {
    Some(handle) => create_thenable(env, handle, cached_then),
    None => Err(Error::new(
      Status::GenericFailure,
      "Promise state unavailable in async_work::run".to_owned(),
    )),
  };
  let status = match thenable {
    Ok(thenable) => unsafe { sys::napi_resolve_deferred(env, deferred, thenable) },
    Err(err) => {
      // The promise is never handed out; settling frees its deferred while the env allows.
      let mut undefined = ptr::null_mut();
      unsafe {
        if sys::napi_get_undefined(env, &mut undefined) == sys::Status::napi_ok {
          sys::napi_resolve_deferred(env, deferred, undefined);
        }
      }
      return Err(err);
    }
  };
  check_status!(
    status,
    "Resolve promise with thenable failed in async_work::run"
  )?;
  // Resolved with the thenable: its `then` job is queued.
  settler.then_queued = true;
  Ok(settler)
}

/// The promise of a `JsDeferred` (`#[napi] async fn`, `Env::spawn_future`,
/// `Env::create_deferred`) in a thenable-mode env, made by the env's promise wrapper, so no
/// `napi_deferred` exists. Its settle comes back through a threadsafe function, which env
/// teardown may cut off, so its slot is not owned: the env-teardown sweep frees it if the settle
/// never comes.
///
/// Plain data, so it may travel to any thread with the `JsDeferred`; only its env's JavaScript
/// thread uses it. A stale one (the sweep already freed its slot) matches nothing and does
/// nothing.
#[cfg(feature = "napi4")]
#[derive(Clone, Copy)]
pub(crate) struct DetachedPromise {
  handle: Handle,
}

/// The promise of a `JsDeferred` made in `env`, in thenable mode: `Ok(None)` when the caller
/// must use `napi_create_promise` as before, that is on wasm, in deferred mode, without a
/// registration record (no sweep would free the slot), or when the wrapper cannot be used for
/// this one promise (see [`create_wrapped`] and the module docs).
///
/// The first call in an env may pick its settle mode (see the module docs): until now only an
/// `AsyncTask` did that.
#[cfg(feature = "napi4")]
pub(crate) fn create_detached(
  env: sys::napi_env,
) -> Result<Option<(sys::napi_value, DetachedPromise)>> {
  if cfg!(target_family = "wasm") {
    return Ok(None);
  }
  let (mode, cache) = settle_mode_of(env);
  if mode != SettleMode::Thenable {
    return Ok(None);
  }
  if let Some((cache, wrapper)) =
    cache.and_then(|cache| promise_wrapper(env, cache.wrapper).map(|wrapper| (cache, wrapper)))
  {
    if let Some((promise, mut settler)) = create_wrapped(env, wrapper, cache.then, false)? {
      // The slot is not owned: dropping the settler must not free it.
      if let Some(handle) = settler.handle.take() {
        DETACHED_CREATED.fetch_add(1, Ordering::Relaxed);
        return Ok(Some((promise, DetachedPromise { handle })));
      }
    }
  }
  DETACHED_FALLBACKS.fetch_add(1, Ordering::Relaxed);
  Ok(None)
}

#[cfg(feature = "napi4")]
impl DetachedPromise {
  /// Settles the promise once, on its env's JavaScript thread: through its resolving functions,
  /// or kept for `then` when it has not run yet. Returns the raw status of the settling call.
  /// Call [`Self::release`] afterwards on every path.
  pub(crate) fn settle(
    self,
    env: sys::napi_env,
    fulfill: bool,
    value: sys::napi_value,
  ) -> sys::napi_status {
    let mut settler = ThenableSettler {
      env,
      handle: Some(self.handle),
      // A `DetachedPromise` only exists once its promise was made.
      then_queued: true,
    };
    let settlement = if fulfill {
      Settlement::Fulfill(value)
    } else {
      Settlement::Reject(value)
    };
    let status = settler.settle(&settlement);
    // Not owned: `release` frees the slot, not this drop.
    settler.handle = None;
    status
  }

  /// Frees the slot and what it holds, settled, refused or never settled. A kept outcome stays
  /// for `then` (or for the sweep). On its env's JavaScript thread only.
  pub(crate) fn release(self, env: sys::napi_env) {
    ThenableSettler {
      env,
      handle: Some(self.handle),
      // A `DetachedPromise` only exists once its promise was made.
      then_queued: true,
    }
    .release();
  }

  /// Keeps `reference` in the slot, so that the env-teardown sweep deletes it if nothing takes it
  /// back. `false` when the slot is gone or already keeps one: the caller still owns `reference`
  /// then.
  #[cfg_attr(not(feature = "deferred_trace"), allow(dead_code))]
  pub(crate) fn set_extra(self, env: sys::napi_env, reference: sys::napi_ref) -> bool {
    with_slots(|slots| match slots.get_mut(self.handle, env) {
      Some(slot) if slot.extra.is_null() => {
        slot.extra = reference;
        true
      }
      _ => false,
    })
    .unwrap_or(false)
  }

  /// Takes back what [`Self::set_extra`] kept, if the slot still has it.
  #[cfg_attr(not(feature = "deferred_trace"), allow(dead_code))]
  pub(crate) fn take_extra(self, env: sys::napi_env) -> Option<sys::napi_ref> {
    with_slots(|slots| {
      let slot = slots.get_mut(self.handle, env)?;
      let extra = std::mem::replace(&mut slot.extra, ptr::null_mut());
      (!extra.is_null()).then_some(extra)
    })
    .flatten()
  }
}

/// Frees the `napi_deferred` of a promise whose `JsDeferred` was dropped unsettled. On its env's
/// JavaScript thread, with the env live; `deferred` must never be settled again.
///
/// A `napi_deferred` is a strong handle to the promise, freed only by `napi_resolve_deferred` or
/// `napi_reject_deferred`, so it pins the promise and everything that awaits it until the process
/// exits. This resolves it with `{ then }`, `then` an own data property holding a native function
/// that does nothing: the engine reads `then` without a getter and queues a job that calls it,
/// which never calls the resolving functions. The promise stays pending (its awaiters never
/// resume or throw) and nothing holds it any more. No user code runs and no exception is
/// reported. When the env refuses (an exception pending, or teardown), nothing is freed, as
/// before.
#[cfg(all(feature = "napi4", not(target_family = "wasm")))]
pub(crate) fn release_deferred_pending(env: sys::napi_env, deferred: sys::napi_deferred) {
  // Never touch an exception that is not ours.
  if exception_pending(env) {
    return;
  }
  let mut then = ptr::null_mut();
  let mut thenable = ptr::null_mut();
  let made = unsafe {
    sys::napi_create_function(
      env,
      c"".as_ptr().cast(),
      0,
      Some(inert_then),
      ptr::null_mut(),
      &mut then,
    )
  } == sys::Status::napi_ok
    && unsafe { sys::napi_create_object(env, &mut thenable) } == sys::Status::napi_ok
    && define_own_data_property(env, thenable, c"then", then) == sys::Status::napi_ok;
  if made {
    // Exactly once, status ignored: the call frees the deferred even when it fails, and a refused
    // call frees nothing (as before).
    unsafe { sys::napi_resolve_deferred(env, deferred, thenable) };
  }
  // None was pending above: any exception now is from these calls.
  let _ = take_pending_exception(env);
}

/// The `then` of [`release_deferred_pending`]: reads nothing, calls nothing.
#[cfg(all(feature = "napi4", not(target_family = "wasm")))]
unsafe extern "C" fn inert_then(
  _env: sys::napi_env,
  _info: sys::napi_callback_info,
) -> sys::napi_value {
  ptr::null_mut()
}

/// Env-teardown sweep, called from the env's registration cleanup: frees the kept outcomes of
/// tasks whose `then` never came, and every [`DetachedPromise`] slot of the env, settled or not.
/// Nothing can call `then` for this env any more, and a `JsDeferred` settle that still comes
/// finds no slot. Slots still owned by a task are left to it: its completion callback runs
/// before the env is freed.
#[cfg(all(
  not(feature = "noop"),
  any(feature = "napi3", not(target_family = "wasm"))
))]
pub(crate) fn release_env_promise_states(env: sys::napi_env) {
  let references = with_slots(|slots| {
    let mut references = Vec::new();
    for index in 0..slots.entries.len() {
      let entry = &slots.entries[index];
      let Some(slot) = entry.slot.as_ref() else {
        continue;
      };
      if slot.env != env || slot.owned {
        continue;
      }
      let handle = Handle {
        index: index as u32,
        generation: entry.generation,
      };
      // No `then` job of this env runs any more.
      let slot = slots.remove(handle, false);
      if !slot.extra.is_null() {
        references.push(slot.extra);
      }
      match slot.state {
        SlotState::Kept { holder, .. } => references.push(holder),
        // Only a detached promise gets here with its resolving functions: its settle never came
        // back to this env.
        SlotState::Resolvers { resolve, reject } => {
          references.push(resolve);
          references.push(reject);
          RESOLVERS_RELEASED.fetch_add(1, Ordering::Relaxed);
        }
        SlotState::Waiting => {}
      }
    }
    slots.retire_env(env);
    references
  })
  .unwrap_or_default();
  // No `NAPI_PREAMBLE`: legal while the env refuses JavaScript.
  for reference in references {
    unsafe { sys::napi_delete_reference(env, reference) };
  }
}

/// Takes the exception pending on `env`, if any. Neither call has a `NAPI_PREAMBLE`.
pub(crate) fn take_pending_exception(env: sys::napi_env) -> Option<sys::napi_value> {
  let mut pending = false;
  if unsafe { sys::napi_is_exception_pending(env, &mut pending) } != sys::Status::napi_ok
    || !pending
  {
    return None;
  }
  let mut exception = ptr::null_mut();
  if unsafe { sys::napi_get_and_clear_last_exception(env, &mut exception) } != sys::Status::napi_ok
  {
    return None;
  }
  Some(exception)
}

/// Settles `settler` with `settlement`, reporting whether the promise was settled.
///
/// Node and emnapi refuse every settling call (`napi_resolve_deferred` /
/// `napi_reject_deferred` in deferred mode; `napi_call_function`, and the `napi_strict_equals`
/// probe before keeping an outcome, in thenable mode) in two unrelated states, with the same
/// status for module API < 10 (`napi_pending_exception`; API >= 10 says `napi_cannot_run_js`
/// for the first one):
///
/// * the env is tearing down and cannot run JavaScript. Nothing can settle the promise any
///   more, and nothing should run against the env, so `Ok(false)` is returned and the caller
///   skips `finally`. The settler still releases its references when it is dropped.
/// * the env is live but an exception is pending — the task's `resolve`/`reject`, a value
///   conversion, or a getter threw during this completion. Refusing here used to look like
///   teardown and left the promise pending forever. Since that exception is what the task
///   produced, it is taken and the promise is rejected with it, and `finally` runs as usual.
///
/// A pending exception is checked before settling, and again after a refusal, because the
/// settling call itself can throw (a `then` getter cannot: the resolving functions catch it).
/// It is retried once, so a callee that keeps throwing ends with the exception still pending,
/// where the completion callback's caller reports it as uncaught. A deferred settler retries
/// nothing: Node frees the deferred before it reports an exception the call caught, so the
/// exception stays pending and `finally` is skipped.
pub(super) fn conclude(
  env: sys::napi_env,
  settler: &mut PromiseSettler,
  settlement: Result<Settlement>,
) -> Result<bool> {
  let mut settlement = match take_pending_exception(env) {
    Some(exception) => Settlement::Reject(exception),
    // No JavaScript exception to reject with: a settlement that could not even be built goes to
    // the caller, which throws it.
    None => settlement?,
  };
  let mut retried = false;
  loop {
    match settler.settle(&settlement) {
      sys::Status::napi_ok => return Ok(true),
      sys::Status::napi_pending_exception | sys::Status::napi_cannot_run_js => {
        if !retried && settler.can_retry() {
          if let Some(exception) = take_pending_exception(env) {
            settlement = Settlement::Reject(exception);
            retried = true;
            continue;
          }
        }
        // Either the env refused because it cannot run JavaScript (no exception pending), or the
        // retried settlement threw again (only a tampered emnapi `napi_call_function` on WASI):
        // that exception stays pending for the completion callback's caller to report.
        return Ok(false);
      }
      status => {
        return Err(Error::new(
          Status::from(status),
          "Settle async task promise failed".to_owned(),
        ))
      }
    }
  }
}

/// The index rule of the slot table: an index is not reused while a queued `then` job can still
/// carry its handle.
#[cfg(test)]
mod slot_tests {
  use super::*;

  const ENV: usize = 0x1000;
  const OTHER_ENV: usize = 0x2000;

  fn waiting(env: usize) -> Slot {
    Slot {
      env: env as sys::napi_env,
      owned: false,
      state: SlotState::Waiting,
      extra: ptr::null_mut(),
    }
  }

  /// 2^20 slots made and freed before any `then` job ran wrap the generation counter. The job of
  /// the first one must not find the slot made after the wrap, which has its generation.
  #[test]
  fn a_stale_then_job_never_names_a_slot_made_after_the_generation_wrap() {
    let env = ENV as sys::napi_env;
    let mut slots = Slots::default();
    let first = slots.insert(waiting(ENV));
    slots.remove(first, true);
    for _ in 0..GENERATION_MASK {
      let handle = slots.insert(waiting(ENV));
      slots.remove(handle, true);
    }
    let after_wrap = slots.insert(waiting(ENV));
    assert_eq!(after_wrap.generation, first.generation);
    assert_ne!(after_wrap.index, first.index);
    assert!(slots.get_mut(first, env).is_none());
    assert!(slots.get_mut(after_wrap, env).is_some());

    // The job of `first` comes: it finds no slot, and only now is its index free.
    assert!(slots.retire(first, env));
    assert!(!slots.retire(first, env));
    let reuse = slots.insert(waiting(ENV));
    assert_eq!(reuse.index, first.index);
    assert_ne!(reuse.generation, first.generation);
  }

  /// No job was queued (the promise was never made), or the job already ran: the index is free at
  /// once.
  #[test]
  fn a_slot_no_then_job_can_name_frees_its_index_at_once() {
    let env = ENV as sys::napi_env;
    let mut slots = Slots::default();
    let never_queued = slots.insert(waiting(ENV));
    slots.remove(never_queued, false);
    let second = slots.insert(waiting(ENV));
    assert_eq!(second.index, never_queued.index);

    // `then` ran: the slot has the resolving functions.
    slots.get_mut(second, env).unwrap().state = SlotState::Resolvers {
      resolve: ptr::null_mut(),
      reject: ptr::null_mut(),
    };
    slots.remove(second, true);
    assert!(!slots.retire(second, env));
    let third = slots.insert(waiting(ENV));
    assert_eq!(third.index, second.index);
  }

  /// A job of another env, or with another generation, does not free a reserved index.
  #[test]
  fn only_the_job_of_the_freed_slot_frees_its_index() {
    let mut slots = Slots::default();
    let handle = slots.insert(waiting(ENV));
    slots.remove(handle, true);
    assert!(!slots.retire(handle, OTHER_ENV as sys::napi_env));
    let forged = Handle {
      index: handle.index,
      generation: handle.generation + 1,
    };
    assert!(!slots.retire(forged, ENV as sys::napi_env));
    let other = slots.insert(waiting(ENV));
    assert_ne!(other.index, handle.index);
    assert!(slots.retire(handle, ENV as sys::napi_env));
  }

  /// Env teardown frees the indexes its queued jobs reserved, and no other env's.
  #[cfg(all(
    not(feature = "noop"),
    any(feature = "napi3", not(target_family = "wasm"))
  ))]
  #[test]
  fn env_teardown_frees_the_indexes_its_jobs_reserved() {
    let mut slots = Slots::default();
    let mine = slots.insert(waiting(ENV));
    let theirs = slots.insert(waiting(OTHER_ENV));
    slots.remove(mine, true);
    slots.remove(theirs, true);
    slots.retire_env(ENV as sys::napi_env);
    assert_eq!(slots.free, vec![mine.index]);
    assert!(slots.retire(theirs, OTHER_ENV as sys::napi_env));
    assert_eq!(slots.free.len(), slots.entries.len());
  }
}
