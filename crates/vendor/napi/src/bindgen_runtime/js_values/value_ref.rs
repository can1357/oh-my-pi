use std::cell::{Cell, LazyCell};
use std::ffi::c_void;
use std::hash::BuildHasherDefault;
use std::ops::{Deref, DerefMut};
use std::ptr;
use std::sync::{Arc, Weak};

use nohash_hasher::NoHashHasher;

use crate::{
  bindgen_runtime::{FromNapiValue, MaybeTypeTag, PersistedPerInstanceHashMap, ToNapiValue},
  check_status, Env, Error, Result, Status,
};

pub(crate) type RefInformation = (
  /* wrapped_value */ *mut c_void,
  /* napi_ref */ crate::sys::napi_ref,
  /* finalize_callback */ *const Cell<*mut dyn FnOnce()>,
);

#[allow(clippy::not_unsafe_ptr_arg_deref)]
pub(crate) fn add_ref(env: crate::sys::napi_env, t: *mut c_void, value: RefInformation) {
  REFERENCE_MAP.with(|cell| {
    cell.borrow_mut(|map| {
      if let Some((_, previous_ref, previous_rc)) = map.insert(t, value) {
        unsafe { Arc::from_raw(previous_rc) };
        unsafe { crate::sys::napi_delete_reference(env, previous_ref) };
      }
    })
  });
}

thread_local! {
  pub(crate) static REFERENCE_MAP: LazyCell<
    PersistedPerInstanceHashMap<*mut c_void, RefInformation, BuildHasherDefault<NoHashHasher<usize>>>,
  > = LazyCell::new(Default::default);
}

/// Create a [`napi_ref`](https://nodejs.org/api/n-api.html#napi_ref) from `Class` instance.
///
/// Unref the [`napi_ref`](https://nodejs.org/api/n-api.html#napi_ref) when the `Reference` is dropped.
///
/// The `Reference` is `Sync` when the `T` is `Sync`.
/// It's not `Send` because of the `drop` of the `Reference` must be called in the same thread as the `Reference` is created.
pub struct Reference<T: 'static> {
  raw: *mut T,
  napi_ref: crate::sys::napi_ref,
  env: *mut c_void,
  // the finalize callbacks can only be written with the `Env` passed in
  // So we can use `Cell` rather than `AtomicPtr` here
  finalize_callbacks: Arc<Cell<*mut dyn FnOnce()>>,
}

unsafe impl<T: Sync> Sync for Reference<T> {}

impl<T> Drop for Reference<T> {
  fn drop(&mut self) {
    let rc_strong_count = Arc::strong_count(&self.finalize_callbacks);
    let mut ref_count = 0;
    // If Rc strong count == 1, then the referenced object is dropped on GC
    // It would happen when the process is exiting
    // In general, the `drop` of the `Reference` would happen first
    if rc_strong_count > 1 {
      let status = unsafe {
        crate::sys::napi_reference_unref(
          self.env as crate::sys::napi_env,
          self.napi_ref,
          &mut ref_count,
        )
      };
      debug_assert!(
        status == crate::sys::Status::napi_ok,
        "Reference unref failed, status code: {}",
        crate::Status::from(status)
      );
    };
  }
}

impl<T: 'static> Reference<T> {
  #[doc(hidden)]
  #[allow(clippy::not_unsafe_ptr_arg_deref)]
  pub fn add_ref(env: crate::sys::napi_env, t: *mut c_void, value: RefInformation) {
    add_ref(env, t, value);
  }

  #[doc(hidden)]
  pub unsafe fn from_value_ptr(t: *mut c_void, env: crate::sys::napi_env) -> Result<Self> {
    if let Some((wrapped_value, napi_ref, finalize_callbacks_ptr)) =
      REFERENCE_MAP.with(|cell| cell.borrow_mut(|map| map.get(&t).cloned()))
    {
      let mut ref_count = 0;
      check_status!(
        unsafe { crate::sys::napi_reference_ref(env, napi_ref, &mut ref_count) },
        "Failed to ref napi reference"
      )?;
      let finalize_callbacks_raw = unsafe { Arc::from_raw(finalize_callbacks_ptr) };
      let finalize_callbacks = finalize_callbacks_raw.clone();
      // Leak the raw finalize callbacks
      let _ = Arc::into_raw(finalize_callbacks_raw);
      Ok(Self {
        raw: wrapped_value.cast(),
        napi_ref,
        env: env.cast(),
        finalize_callbacks,
      })
    } else {
      Err(Error::new(
        Status::InvalidArg,
        format!("Class for Type {t:?} not found"),
      ))
    }
  }
}

impl<T: 'static> ToNapiValue for Reference<T> {
  unsafe fn to_napi_value(env: crate::sys::napi_env, val: Self) -> Result<crate::sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { crate::sys::napi_get_reference_value(env, val.napi_ref, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}

impl<T: 'static + MaybeTypeTag> FromNapiValue for Reference<T> {
  unsafe fn from_napi_value(
    env: crate::sys::napi_env,
    napi_val: crate::sys::napi_value,
  ) -> Result<Self> {
    let mut value = ptr::null_mut();
    check_status!(
      unsafe { crate::sys::napi_unwrap(env, napi_val, &mut value) },
      "Unwrap value [{}] from class Reference failed",
      std::any::type_name::<T>(),
    )?;

    // Reject a wrong-class / prototype-spoofed object before adopting it as a
    // `Reference<T>`. Compiled only on napi8 NATIVE targets (the `T: MaybeTypeTag`
    // bound provides `T::type_tag()` only there; elsewhere this is the pre-tag
    // path).
    #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
    unsafe {
      crate::bindgen_runtime::validate_type_tag(
        env,
        napi_val,
        &T::type_tag(),
        std::any::type_name::<T>(),
      )?
    };

    unsafe { Reference::from_value_ptr(value.cast(), env) }
  }
}

impl<T: 'static> Reference<T> {
  pub fn clone(&self, env: Env) -> Result<Self> {
    let mut ref_count = 0;
    check_status!(
      unsafe { crate::sys::napi_reference_ref(env.0, self.napi_ref, &mut ref_count) },
      "Failed to ref napi reference"
    )?;
    Ok(Self {
      raw: self.raw,
      napi_ref: self.napi_ref,
      env: env.0.cast(),
      finalize_callbacks: self.finalize_callbacks.clone(),
    })
  }

  pub fn downgrade(&self) -> WeakReference<T> {
    WeakReference {
      raw: self.raw,
      napi_ref: self.napi_ref,
      finalize_callbacks: Arc::downgrade(&self.finalize_callbacks),
    }
  }

  /// Safety to share because caller can provide `Env`
  pub fn share_with<S: 'static, F: FnOnce(&'static mut T) -> Result<S>>(
    self,
    #[allow(unused_variables)] env: Env,
    f: F,
  ) -> Result<SharedReference<T, S>> {
    let s = f(Box::leak(unsafe { Box::from_raw(self.raw) }))?;
    let s_ptr = Box::into_raw(Box::new(s));
    let prev_drop_fn = unsafe { Box::from_raw(self.finalize_callbacks.get()) };
    let drop_fn = Box::new(move || {
      drop(unsafe { Box::from_raw(s_ptr) });
      prev_drop_fn();
    });
    self.finalize_callbacks.set(Box::into_raw(drop_fn));
    Ok(SharedReference {
      raw: s_ptr,
      owner: self,
    })
  }
}

impl<T: 'static> Deref for Reference<T> {
  type Target = T;

  fn deref(&self) -> &Self::Target {
    unsafe { Box::leak(Box::from_raw(self.raw)) }
  }
}

impl<T: 'static> DerefMut for Reference<T> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    unsafe { Box::leak(Box::from_raw(self.raw)) }
  }
}

pub struct WeakReference<T: 'static> {
  raw: *mut T,
  napi_ref: crate::sys::napi_ref,
  finalize_callbacks: Weak<Cell<*mut dyn FnOnce()>>,
}

impl<T> Clone for WeakReference<T> {
  fn clone(&self) -> Self {
    Self {
      raw: self.raw,
      napi_ref: self.napi_ref,
      finalize_callbacks: self.finalize_callbacks.clone(),
    }
  }
}

impl<T: 'static> ToNapiValue for WeakReference<T> {
  unsafe fn to_napi_value(env: crate::sys::napi_env, val: Self) -> Result<crate::sys::napi_value> {
    if Weak::strong_count(&val.finalize_callbacks) == 0 {
      return Err(Error::new(
        Status::GenericFailure,
        format!(
          "The original reference that WeakReference<{}> is pointing to is dropped",
          std::any::type_name::<T>()
        ),
      ));
    };
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { crate::sys::napi_get_reference_value(env, val.napi_ref, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}

impl<T: 'static> WeakReference<T> {
  pub fn upgrade(&self, env: Env) -> Result<Option<Reference<T>>> {
    if let Some(finalize_callbacks) = self.finalize_callbacks.upgrade() {
      let mut ref_count = 0;
      check_status!(
        unsafe { crate::sys::napi_reference_ref(env.0, self.napi_ref, &mut ref_count) },
        "Failed to ref napi reference"
      )?;
      Ok(Some(Reference {
        raw: self.raw,
        napi_ref: self.napi_ref,
        env: env.0 as *mut c_void,
        finalize_callbacks,
      }))
    } else {
      Ok(None)
    }
  }

  pub fn get(&self) -> Option<&T> {
    if Weak::strong_count(&self.finalize_callbacks) == 0 {
      None
    } else {
      Some(unsafe { Box::leak(Box::from_raw(self.raw)) })
    }
  }

  pub fn get_mut(&mut self) -> Option<&mut T> {
    if Weak::strong_count(&self.finalize_callbacks) == 0 {
      None
    } else {
      Some(unsafe { Box::leak(Box::from_raw(self.raw)) })
    }
  }
}

/// ### Experimental feature
///
/// Create a `SharedReference` from an existed `Reference`.
pub struct SharedReference<T: 'static, S: 'static> {
  raw: *mut S,
  owner: Reference<T>,
}

unsafe impl<T, S: Sync> Sync for SharedReference<T, S> {}

impl<T: 'static, S: 'static> SharedReference<T, S> {
  pub fn clone(&self, env: Env) -> Result<Self> {
    Ok(SharedReference {
      raw: self.raw,
      owner: self.owner.clone(env)?,
    })
  }

  pub fn clone_owner(&self, env: Env) -> Result<Reference<T>> {
    self.owner.clone(env)
  }

  /// Safety to share because caller can provide `Env`
  pub fn share_with<U: 'static, F: FnOnce(&'static mut S) -> Result<U>>(
    self,
    #[allow(unused_variables)] env: Env,
    f: F,
  ) -> Result<SharedReference<T, U>> {
    let s = f(Box::leak(unsafe { Box::from_raw(self.raw) }))?;
    let raw = Box::into_raw(Box::new(s));
    let prev_drop_fn = unsafe { Box::from_raw(self.owner.finalize_callbacks.get()) };
    let drop_fn = Box::new(move || {
      drop(unsafe { Box::from_raw(raw) });
      prev_drop_fn();
    });
    self.owner.finalize_callbacks.set(Box::into_raw(drop_fn));
    Ok(SharedReference {
      raw,
      owner: self.owner,
    })
  }
}

impl<T: 'static, S: 'static> ToNapiValue for SharedReference<T, S> {
  unsafe fn to_napi_value(env: crate::sys::napi_env, val: Self) -> Result<crate::sys::napi_value> {
    let mut result = ptr::null_mut();
    check_status!(
      unsafe { crate::sys::napi_get_reference_value(env, val.owner.napi_ref, &mut result) },
      "Failed to get reference value"
    )?;
    Ok(result)
  }
}

impl<T: 'static, S: 'static> Deref for SharedReference<T, S> {
  type Target = S;

  fn deref(&self) -> &Self::Target {
    unsafe { Box::leak(Box::from_raw(self.raw)) }
  }
}

impl<T: 'static, S: 'static> DerefMut for SharedReference<T, S> {
  fn deref_mut(&mut self) -> &mut Self::Target {
    unsafe { Box::leak(Box::from_raw(self.raw)) }
  }
}
