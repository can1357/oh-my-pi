use std::{
  cell::RefCell,
  collections::HashMap,
  ptr,
  sync::{LazyLock, Mutex},
  thread::{self, ThreadId},
};

use crate::{sys, Error, Result, Status};

#[derive(Clone, Copy)]
enum NativeBorrowKind {
  Shared,
  Exclusive,
}

#[derive(Default)]
struct NativeBorrowState {
  shared: usize,
  exclusive: bool,
}

static NATIVE_BORROWS: LazyLock<Mutex<HashMap<usize, NativeBorrowState>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));

thread_local! {
  static NATIVE_BORROW_SCOPES: RefCell<Vec<*mut NativeBorrowStorage>> =
    const { RefCell::new(Vec::new()) };
}

#[derive(Default)]
struct NativeBorrowStorage {
  guards: Vec<NativeBorrowGuard>,
  roots: Vec<NativeBorrowRoot>,
  root_values: bool,
  owner_thread: Option<ThreadId>,
}

struct NativeBorrowRoot {
  env: sys::napi_env,
  reference: sys::napi_ref,
}

impl NativeBorrowStorage {
  fn release(&mut self, expected_env: Option<sys::napi_env>) {
    // The Rust references captured by the future are already gone. Release the
    // alias guards before allowing JavaScript finalizers to reclaim the value.
    self.guards.clear();
    if self.roots.is_empty() {
      return;
    }
    if self.owner_thread != Some(thread::current().id()) {
      std::process::abort();
    }
    for root in self.roots.drain(..) {
      if expected_env.is_some_and(|expected_env| expected_env != root.env) {
        std::process::abort();
      }
      let mut ref_count = 0;
      let unref_status =
        unsafe { sys::napi_reference_unref(root.env, root.reference, &mut ref_count) };
      let delete_status = unsafe { sys::napi_delete_reference(root.env, root.reference) };
      if cfg!(debug_assertions)
        && (unref_status != sys::Status::napi_ok || delete_status != sys::Status::napi_ok)
      {
        crate::bindgen_runtime::catch_unwind_safely(|| {
          eprintln!(
            "Failed to release generated native borrow root: unref={}, delete={}",
            Status::from(unref_status),
            Status::from(delete_status)
          );
        });
      }
    }
  }
}

/// Prevents a reentrant callback from registering native references in an outer conversion scope.
#[doc(hidden)]
pub struct NativeBorrowBarrier {
  _not_send: std::marker::PhantomData<std::rc::Rc<()>>,
}

impl NativeBorrowBarrier {
  #[doc(hidden)]
  pub fn new() -> Self {
    NATIVE_BORROW_SCOPES.with(|scopes| scopes.borrow_mut().push(std::ptr::null_mut()));
    Self {
      _not_send: std::marker::PhantomData,
    }
  }
}

impl Drop for NativeBorrowBarrier {
  fn drop(&mut self) {
    NATIVE_BORROW_SCOPES.with(|scopes| {
      let barrier = scopes
        .borrow_mut()
        .pop()
        .expect("native borrow barriers must be dropped in stack order");
      assert!(
        barrier.is_null(),
        "native borrow barriers must not overlap conversion scopes"
      );
    });
  }
}

/// Holds native borrows created while generated code converts callback arguments.
///
/// Generated async callbacks move this scope into their terminal finalizer so references remain
/// protected until the future and its captured arguments have been dropped.
#[doc(hidden)]
pub struct NativeBorrowScope {
  storage: Box<NativeBorrowStorage>,
  collecting: bool,
}

impl NativeBorrowScope {
  /// Starts collecting native borrows created by generated callback argument conversion.
  ///
  /// # Safety
  ///
  /// The scope must only be created by callback glue that owns every reference produced while the
  /// scope is collecting. It must remain alive until those references have been dropped.
  #[doc(hidden)]
  pub unsafe fn new() -> Self {
    unsafe { Self::new_inner(false) }
  }

  /// Starts collecting native borrows and exact JavaScript roots for an async callback.
  ///
  /// # Safety
  ///
  /// The scope must be released on the JavaScript owner thread after the generated future has
  /// destroyed every reference produced while the scope is collecting.
  #[doc(hidden)]
  pub unsafe fn new_async() -> Self {
    unsafe { Self::new_inner(true) }
  }

  unsafe fn new_inner(root_values: bool) -> Self {
    let mut storage = Box::<NativeBorrowStorage>::default();
    storage.root_values = root_values;
    storage.owner_thread = root_values.then(|| thread::current().id());
    let storage_ptr = (&mut *storage) as *mut NativeBorrowStorage;
    NATIVE_BORROW_SCOPES.with(|scopes| scopes.borrow_mut().push(storage_ptr));
    Self {
      storage,
      collecting: true,
    }
  }

  /// Stops argument conversion from adding guards while retaining all acquired borrows.
  #[doc(hidden)]
  pub fn finish(&mut self) {
    if !self.collecting {
      return;
    }
    let expected = (&mut *self.storage) as *mut NativeBorrowStorage;
    NATIVE_BORROW_SCOPES.with(|scopes| {
      let actual = scopes
        .borrow_mut()
        .pop()
        .expect("native borrow scopes must be finished in stack order");
      assert_eq!(actual, expected, "native borrow scopes must not overlap");
    });
    self.collecting = false;
  }

  /// Releases collected alias guards and exact JavaScript roots on their owner thread.
  #[doc(hidden)]
  pub fn release(mut self, env: sys::napi_env) {
    self.finish();
    self.storage.release(Some(env));
  }
}

impl Drop for NativeBorrowScope {
  fn drop(&mut self) {
    self.finish();
    self.storage.release(None);
  }
}

#[doc(hidden)]
pub struct NativeBorrowGuard {
  key: usize,
  kind: NativeBorrowKind,
}

impl NativeBorrowGuard {
  fn acquire<T>(value: *mut T, kind: NativeBorrowKind) -> Result<Self> {
    if value.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "Cannot borrow a null native value".to_owned(),
      ));
    }
    let key = value as usize;
    let mut borrows = NATIVE_BORROWS
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    let state = borrows.entry(key).or_default();
    let conflict = match kind {
      NativeBorrowKind::Shared => state.exclusive,
      NativeBorrowKind::Exclusive => state.exclusive || state.shared != 0,
    };
    if conflict {
      return Err(Error::new(
        Status::InvalidArg,
        "The same native value cannot be borrowed mutably while another borrow is active"
          .to_owned(),
      ));
    }
    match kind {
      NativeBorrowKind::Shared => {
        state.shared = state
          .shared
          .checked_add(1)
          .expect("native shared borrow count overflow");
      }
      NativeBorrowKind::Exclusive => state.exclusive = true,
    }
    Ok(Self { key, kind })
  }
}

impl Drop for NativeBorrowGuard {
  fn drop(&mut self) {
    let mut borrows = NATIVE_BORROWS
      .lock()
      .unwrap_or_else(std::sync::PoisonError::into_inner);
    let state = borrows
      .get_mut(&self.key)
      .expect("native borrow guard must have a registered state");
    match self.kind {
      NativeBorrowKind::Shared => {
        state.shared = state
          .shared
          .checked_sub(1)
          .expect("native shared borrow count underflow");
      }
      NativeBorrowKind::Exclusive => state.exclusive = false,
    }
    if state.shared == 0 && !state.exclusive {
      borrows.remove(&self.key);
    }
  }
}

/// Registers a generated callback argument borrow in the current conversion scope.
#[doc(hidden)]
pub fn register_native_borrow<T>(value: *mut T, mutable: bool) -> Result<()> {
  let scope = current_native_borrow_scope()?;
  let guard = NativeBorrowGuard::acquire(value, native_borrow_kind(mutable))?;
  unsafe {
    (&mut *scope).guards.push(guard);
  }
  Ok(())
}

/// Registers a generated callback argument borrow and roots its exact source JavaScript value.
///
/// # Safety
///
/// `env` and `napi_val` must be a valid same-environment Node-API value for the active callback,
/// and `value` must point to the native allocation represented by that JavaScript value for the
/// full generated borrow scope.
#[doc(hidden)]
pub unsafe fn register_native_borrow_with_value<T>(
  env: sys::napi_env,
  napi_val: sys::napi_value,
  value: *mut T,
  mutable: bool,
) -> Result<()> {
  let scope = current_native_borrow_scope()?;
  unsafe { register_native_borrow_with_value_in_scope(scope, env, napi_val, value, mutable) }
}

/// Preserves reference conversion for callbacks generated by previously released `napi-derive`.
///
/// Legacy callback glue does not install a native borrow scope. An explicit barrier still rejects
/// conversion so a reentrant legacy callback cannot attach its references to an outer callback's
/// scope. Current generated callbacks always take the scoped path.
///
/// # Safety
///
/// `env` and `napi_val` must be a valid same-environment Node-API value, and `value` must point to
/// the native allocation represented by that JavaScript value for the callback invocation.
// Runtime call sites (`External` reference conversion, compat-mode `CallContext` barriers) arrive
// with their own reworks; kept so barrier semantics stay covered by the unit tests below.
#[allow(dead_code)]
pub(crate) unsafe fn register_legacy_native_borrow_with_value<T>(
  env: sys::napi_env,
  napi_val: sys::napi_value,
  value: *mut T,
  mutable: bool,
) -> Result<()> {
  match current_native_borrow_scope_entry() {
    None => Ok(()),
    Some(scope) if scope.is_null() => Err(missing_native_borrow_scope_error()),
    Some(scope) => unsafe {
      register_native_borrow_with_value_in_scope(scope, env, napi_val, value, mutable)
    },
  }
}

unsafe fn register_native_borrow_with_value_in_scope<T>(
  scope: *mut NativeBorrowStorage,
  env: sys::napi_env,
  napi_val: sys::napi_value,
  value: *mut T,
  mutable: bool,
) -> Result<()> {
  let guard = NativeBorrowGuard::acquire(value, native_borrow_kind(mutable))?;
  let storage = unsafe { &mut *scope };
  if storage.root_values {
    if napi_val.is_null() {
      return Err(Error::new(
        Status::InvalidArg,
        "Cannot root a null JavaScript value for a native borrow".to_owned(),
      ));
    }
    let mut reference = ptr::null_mut();
    let status = unsafe { sys::napi_create_reference(env, napi_val, 1, &mut reference) };
    if status != sys::Status::napi_ok {
      return Err(Error::new(
        Status::from(status),
        "Failed to root JavaScript value for a native borrow".to_owned(),
      ));
    }
    storage.roots.push(NativeBorrowRoot { env, reference });
  }
  storage.guards.push(guard);
  Ok(())
}

fn current_native_borrow_scope() -> Result<*mut NativeBorrowStorage> {
  current_native_borrow_scope_entry()
    .filter(|scope| !scope.is_null())
    .ok_or_else(missing_native_borrow_scope_error)
}

fn current_native_borrow_scope_entry() -> Option<*mut NativeBorrowStorage> {
  NATIVE_BORROW_SCOPES.with(|scopes| scopes.borrow().last().copied())
}

fn missing_native_borrow_scope_error() -> Error {
  Error::new(
    Status::InvalidArg,
    "Native references can only be created by generated callback argument conversion".to_owned(),
  )
}

fn native_borrow_kind(mutable: bool) -> NativeBorrowKind {
  if mutable {
    NativeBorrowKind::Exclusive
  } else {
    NativeBorrowKind::Shared
  }
}

/// Acquires a native borrow for a closure-based public API.
#[doc(hidden)]
pub fn acquire_native_borrow<T>(value: *mut T, mutable: bool) -> Result<NativeBorrowGuard> {
  NativeBorrowGuard::acquire(
    value,
    if mutable {
      NativeBorrowKind::Exclusive
    } else {
      NativeBorrowKind::Shared
    },
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn native_borrows_reject_aliasing_and_release_on_drop() {
    let mut value = 1u32;
    let value_ptr = &mut value as *mut u32;
    let shared = acquire_native_borrow(value_ptr, false).unwrap();
    let second_shared = acquire_native_borrow(value_ptr, false).unwrap();
    assert!(acquire_native_borrow(value_ptr, true).is_err());
    drop(second_shared);
    drop(shared);

    let exclusive = acquire_native_borrow(value_ptr, true).unwrap();
    assert!(acquire_native_borrow(value_ptr, false).is_err());
    assert!(acquire_native_borrow(value_ptr, true).is_err());
    drop(exclusive);

    assert!(acquire_native_borrow(value_ptr, true).is_ok());
  }

  #[test]
  fn generated_native_borrows_require_a_scope() {
    let mut value = 1u32;
    let error = register_native_borrow(&mut value, false).unwrap_err();
    assert_eq!(error.status, Status::InvalidArg);
    assert!(error
      .reason
      .contains("generated callback argument conversion"));
  }

  #[test]
  fn legacy_native_borrows_allow_an_absent_scope() {
    let mut value = 1u32;
    unsafe {
      register_legacy_native_borrow_with_value(ptr::null_mut(), ptr::null_mut(), &mut value, false)
    }
    .unwrap();

    assert!(acquire_native_borrow(&mut value, true).is_ok());
  }

  #[test]
  fn legacy_native_borrows_join_an_active_scope() {
    let mut value = 1u32;
    let scope = unsafe { NativeBorrowScope::new() };
    unsafe {
      register_legacy_native_borrow_with_value(ptr::null_mut(), ptr::null_mut(), &mut value, false)
    }
    .unwrap();

    assert!(acquire_native_borrow(&mut value, true).is_err());
    drop(scope);
    assert!(acquire_native_borrow(&mut value, true).is_ok());
  }

  #[test]
  fn legacy_native_borrows_respect_callback_barriers() {
    let mut outer_value = 1u32;
    let mut reentrant_value = 2u32;
    let outer_scope = unsafe { NativeBorrowScope::new() };
    register_native_borrow(&mut outer_value, false).unwrap();

    {
      let _barrier = NativeBorrowBarrier::new();
      let error = unsafe {
        register_legacy_native_borrow_with_value(
          ptr::null_mut(),
          ptr::null_mut(),
          &mut reentrant_value,
          false,
        )
      }
      .unwrap_err();

      assert_eq!(error.status, Status::InvalidArg);
      assert!(error
        .reason
        .contains("generated callback argument conversion"));
    }

    assert!(register_native_borrow(&mut outer_value, false).is_ok());
    drop(outer_scope);
  }

  #[test]
  fn callback_barrier_hides_outer_conversion_scope() {
    let mut outer_value = 1u32;
    let mut inner_value = 2u32;
    let mut outer_scope = unsafe { NativeBorrowScope::new() };
    register_native_borrow(&mut outer_value, false).unwrap();

    {
      let _barrier = NativeBorrowBarrier::new();
      assert!(register_native_borrow(&mut inner_value, false).is_err());

      let mut inner_scope = unsafe { NativeBorrowScope::new() };
      register_native_borrow(&mut inner_value, false).unwrap();
      inner_scope.finish();
    }

    register_native_borrow(&mut outer_value, false).unwrap();
    outer_scope.finish();
  }
}
