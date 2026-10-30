use std::any::{type_name, TypeId};
use std::collections::{HashMap, HashSet};
use std::ffi::c_void;
use std::ptr;
use std::sync::{LazyLock, Mutex};

use crate::{check_status, sys, Error, Result, Status};

#[repr(C)]
pub struct TaggedObject<T> {
  type_id: TypeId,
  pub(crate) object: Option<T>,
}

impl<T: 'static> TaggedObject<T> {
  pub fn new(object: T) -> Self {
    TaggedObject {
      type_id: TypeId::of::<T>(),
      object: Some(object),
    }
  }
}

/// Live payloads wrapped by `Object::wrap`/`Env::wrap`. `napi_unwrap` and
/// `napi_remove_wrap` hand back an untyped payload pointer, so before reading
/// a wrapped object's payload as `TaggedObject<T>` the pointer must be in this
/// set: `#[napi]` class instances wrap a bare `*mut T` instead, and their
/// first bytes are not a `TaggedObject` header. Pure-JS code has no way to
/// insert into the set, so the check holds on every N-API version and on wasm.
/// Entries are inserted after a successful `napi_wrap` and removed by
/// `remove_wrapped`/`drop_wrapped` and by the wrap finalizer.
static WRAPPED_OBJECT_PAYLOADS: LazyLock<Mutex<HashSet<usize>>> =
  LazyLock::new(|| Mutex::new(HashSet::new()));

pub(crate) fn register_payload(ptr: *mut c_void) {
  WRAPPED_OBJECT_PAYLOADS.lock().unwrap().insert(ptr as usize);
}

pub(crate) fn unregister_payload(ptr: *mut c_void) {
  WRAPPED_OBJECT_PAYLOADS
    .lock()
    .unwrap()
    .remove(&(ptr as usize));
}

fn is_registered_payload(ptr: *const c_void) -> bool {
  WRAPPED_OBJECT_PAYLOADS
    .lock()
    .unwrap()
    .contains(&(ptr as usize))
}

/// Live payloads this binary handed to napi as untyped `data` pointers through
/// `napi_create_external` or `napi_set_instance_data`. `napi_get_value_external`
/// and `napi_get_instance_data` hand such a pointer back untyped, and the value
/// it hangs off can come from foreign native code — another addon, or a sibling
/// copy of this crate — carrying an arbitrary `data` pointer that may be
/// misaligned, dangling, or point into an allocation too small for the expected
/// payload header. Before a returned pointer may be cast to `Payload`, an entry
/// for it must exist here carrying `TypeId::of::<Payload>()`; pure-JS code has
/// no way to insert into the map, so a hit proves the pointer is a live
/// allocation of exactly `Payload` owned by this binary, and no in-memory
/// header read is needed. Entries are inserted after the napi call succeeds and
/// removed by the payload's finalizer (`finalize_external_payload` /
/// `set_instance_finalize_callback`), so the registry never outlives the
/// allocation; instance-data payloads overwritten by a later
/// `napi_set_instance_data` stay registered, mirroring the leaked payload box.
static NATIVE_PAYLOADS: LazyLock<Mutex<HashMap<usize, TypeId>>> =
  LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn register_native_payload<Payload: 'static>(ptr: *mut c_void) {
  NATIVE_PAYLOADS
    .lock()
    .unwrap()
    .insert(ptr as usize, TypeId::of::<Payload>());
}

pub(crate) fn unregister_native_payload(ptr: *mut c_void) {
  NATIVE_PAYLOADS.lock().unwrap().remove(&(ptr as usize));
}

/// `true` only while `ptr` is a live payload this binary registered as
/// `Payload` — so casting it to `*mut Payload` stays inside a live allocation.
pub(crate) fn is_registered_native_payload<Payload: 'static>(ptr: *const c_void) -> bool {
  NATIVE_PAYLOADS
    .lock()
    .unwrap()
    .get(&(ptr as usize))
    .is_some_and(|type_id| *type_id == TypeId::of::<Payload>())
}

/// `napi_create_external` finalizer for payloads registered in
/// `NATIVE_PAYLOADS`: deregisters the payload before freeing it, so the
/// registry never outlives the allocation.
pub(crate) unsafe extern "C" fn finalize_external_payload<Payload>(
  env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  unregister_native_payload(finalize_data);
  unsafe { crate::raw_finalize::<Payload>(env, finalize_data, finalize_hint) }
}

/// Wrap finalizer for `Object::wrap`/`Env::wrap` payloads: deregister the
/// payload before freeing it, so the registry never outlives the allocation.
pub(crate) unsafe extern "C" fn finalize_tagged_object<T>(
  env: sys::napi_env,
  finalize_data: *mut c_void,
  finalize_hint: *mut c_void,
) {
  unregister_payload(finalize_data);
  unsafe { crate::raw_finalize::<TaggedObject<T>>(env, finalize_data, finalize_hint) }
}

/// Shared validation for `Object::unwrap`/`remove_wrapped` and their
/// compat-mode `Env` twins: peek the payload wrapped in `obj` and confirm it
/// is a live `TaggedObject<T>` produced by `Object::wrap`/`Env::wrap` before
/// any in-memory `TypeId` read on the payload pointer.
///
/// Registry membership proves this binary wrapped the payload and that it was
/// not detached or finalized since, so the header read below stays within the
/// allocation. The `TypeId` comparison then pins down `T`: the registry keys
/// on the pointer alone, which cannot tell apart payloads of different types;
/// `TypeId` can (including same-named types from different crate versions).
///
/// Returns the validated payload pointer. Callers either borrow it (`unwrap`)
/// or detach it with `napi_remove_wrap` and free it (`remove_wrapped`).
///
/// # Safety
///
/// `env` must be a valid napi env pointer and `obj` a valid js object. The
/// returned pointer is owned by the wrap; it must not be freed except after a
/// successful `napi_remove_wrap`.
pub(crate) unsafe fn unwrap_tagged_object<T: 'static>(
  env: sys::napi_env,
  obj: sys::napi_value,
) -> Result<*mut TaggedObject<T>> {
  let mut payload: *mut c_void = ptr::null_mut();
  check_status!(
    unsafe { sys::napi_unwrap(env, obj, &mut payload) },
    "Failed to unwrap value of the Object"
  )?;
  let invalid_arg = || {
    Error::new(
      Status::InvalidArg,
      format!(
        "Invalid argument, {} on unwrap is not the type of wrapped object",
        type_name::<T>()
      ),
    )
  };
  if payload.is_null() {
    return Err(invalid_arg());
  }
  if !is_registered_payload(payload) {
    return Err(invalid_arg());
  }
  let type_id = payload as *const TypeId;
  if unsafe { *type_id } == TypeId::of::<T>() {
    Ok(payload as *mut TaggedObject<T>)
  } else {
    Err(invalid_arg())
  }
}
