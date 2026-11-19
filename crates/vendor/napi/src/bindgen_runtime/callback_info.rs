use std::cell::Cell;
use std::ffi::c_void;
use std::ptr;
use std::sync::Arc;

use crate::{bindgen_prelude::*, check_status, iterator::ScopedGenerator};

thread_local! {
  #[doc(hidden)]
  /// Determined is `constructor` called from Class `factory`
  pub static ___CALL_FROM_FACTORY: Cell<bool> = const { Cell::new(false) };
}

#[repr(transparent)]
struct EmptyStructPlaceholder(u8);

#[doc(hidden)]
pub struct CallbackInfo<const N: usize> {
  env: sys::napi_env,
  pub this: sys::napi_value,
  pub args: [sys::napi_value; N],
  this_reference: sys::napi_ref,
}

impl<const N: usize> CallbackInfo<N> {
  #[allow(clippy::not_unsafe_ptr_arg_deref)]
  pub fn new(
    env: sys::napi_env,
    callback_info: sys::napi_callback_info,
    required_argc: Option<usize>,
    // for async class factory, the `this` will be used after the async call
    // so we must create reference for it and use it after async resolved
    use_after_async: bool,
  ) -> Result<Self> {
    let mut this = ptr::null_mut();
    let mut args = [ptr::null_mut(); N];
    let mut argc = N;

    unsafe {
      check_status!(
        sys::napi_get_cb_info(
          env,
          callback_info,
          &mut argc,
          args.as_mut_ptr(),
          &mut this,
          ptr::null_mut(),
        ),
        "Failed to initialize napi function call."
      )?;
    };

    if let Some(required_argc) = required_argc {
      if required_argc > argc {
        return Err(Error::new(
          Status::InvalidArg,
          format!("{} arguments required by received {}.", required_argc, argc),
        ));
      }
    }

    let mut this_reference = ptr::null_mut();

    if use_after_async {
      check_status!(
        unsafe { sys::napi_create_reference(env, this, 1, &mut this_reference) },
        "Failed to create reference for `this` in async class factory"
      )?;
    }

    Ok(Self {
      env,
      this,
      args,
      this_reference,
    })
  }

  pub fn get_arg(&self, index: usize) -> sys::napi_value {
    self.args[index]
  }

  pub fn this(&self) -> sys::napi_value {
    self.this
  }

  fn _construct<const IsEmptyStructHint: bool, T: ObjectFinalize + MaybeTypeTag + 'static>(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<(sys::napi_value, *mut T)> {
    let obj = Box::new(obj);
    let this = self.this();
    let mut value_ref = Box::into_raw(obj);
    // for empty struct like `#[napi] struct A;`, the `value_ref` will be `0x1`
    // and it will be overwritten by the others instance of the same class
    if IsEmptyStructHint || value_ref as usize == 0x1 {
      value_ref = Box::into_raw(Box::new(EmptyStructPlaceholder(0))).cast();
    }
    let mut object_ref = ptr::null_mut();
    let initial_finalize: Box<dyn FnOnce()> = Box::new(|| {});
    // `Reference` needs atomic ref-counting for its `unsafe impl Sync`, so the finalize
    // callbacks slot is an `Arc`. The inner `Cell` is only ever accessed on the JS thread
    // (see `Reference`), so the non-`Send`/`Sync` interior is sound here.
    #[allow(clippy::arc_with_non_send_sync)]
    let finalize_callbacks_ptr =
      Arc::into_raw(Arc::new(Cell::new(Box::into_raw(initial_finalize))));
    unsafe {
      check_status!(
        sys::napi_wrap(
          self.env,
          this,
          value_ref.cast(),
          Some(raw_finalize_unchecked::<T>),
          ptr::null_mut(),
          &mut object_ref
        ),
        "Failed to initialize class `{js_name}`",
      )?;
    };

    Reference::<T>::add_ref(
      self.env,
      value_ref.cast(),
      (value_ref.cast(), object_ref, finalize_callbacks_ptr),
    );

    // Stamp the object's type tag AFTER `add_ref` has adopted the Arc + napi_ref
    // into `REFERENCE_MAP`, so a tag failure cannot leak them: the object is
    // fully registered and GC reclaims value_ref + object_ref + Arc.
    // Compiled only on napi8 NATIVE targets: elsewhere there is no tag to stamp,
    // and the `T: MaybeTypeTag` bound provides `T::type_tag()` only there (it is
    // vacuous without napi8 and on all wasm targets).
    #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
    unsafe {
      tag_object(self.env, this, &T::type_tag())?;
    }

    Ok((this, value_ref))
  }

  pub fn construct<const IsEmptyStructHint: bool, T: ObjectFinalize + MaybeTypeTag + 'static>(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<sys::napi_value> {
    self
      ._construct::<IsEmptyStructHint, T>(js_name, obj)
      .map(|(v, _)| v)
  }

  pub fn construct_generator<
    'a,
    const IsEmptyStructHint: bool,
    T: ScopedGenerator<'a> + ObjectFinalize + MaybeTypeTag + 'static,
  >(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<sys::napi_value> {
    let (instance, generator_ptr) = self._construct::<IsEmptyStructHint, T>(js_name, obj)?;
    unsafe { crate::__private::create_iterator(self.env, instance, generator_ptr) };
    Ok(instance)
  }

  pub fn factory<T: ObjectFinalize + MaybeTypeTag + 'static>(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<sys::napi_value> {
    self._factory(js_name, obj).map(|(value, _)| value)
  }

  pub fn generator_factory<'a, T: ObjectFinalize + ScopedGenerator<'a> + MaybeTypeTag + 'static>(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<sys::napi_value> {
    let (instance, generator_ptr) = self._factory(js_name, obj)?;
    unsafe { crate::__private::create_iterator(self.env, instance, generator_ptr) };
    Ok(instance)
  }

  #[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
  pub fn construct_async_generator<
    const IsEmptyStructHint: bool,
    T: crate::bindgen_runtime::AsyncGenerator + ObjectFinalize + MaybeTypeTag + 'static,
  >(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<sys::napi_value> {
    let (instance, generator_ptr) = self._construct::<IsEmptyStructHint, T>(js_name, obj)?;
    crate::__private::create_async_iterator(self.env, instance, generator_ptr);
    Ok(instance)
  }

  #[cfg(any(feature = "tokio_rt", feature = "async-runtime"))]
  pub fn async_generator_factory<
    T: ObjectFinalize + crate::bindgen_runtime::AsyncGenerator + MaybeTypeTag + 'static,
  >(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<sys::napi_value> {
    let (instance, generator_ptr) = self._factory(js_name, obj)?;
    crate::__private::create_async_iterator(self.env, instance, generator_ptr);
    Ok(instance)
  }

  fn _factory<T: ObjectFinalize + MaybeTypeTag + 'static>(
    &self,
    js_name: &str,
    obj: T,
  ) -> Result<(sys::napi_value, *mut T)> {
    let mut this = self.this();
    let mut instance = ptr::null_mut();
    if !self.this_reference.is_null() {
      check_status!(
        unsafe { sys::napi_get_reference_value(self.env, self.this_reference, &mut this) },
        "Failed to get reference value for `this` in async class factory"
      )?;
      check_status!(
        unsafe { sys::napi_delete_reference(self.env, self.this_reference) },
        "Failed to delete reference for `this` in async class factory"
      )?;
    }
    ___CALL_FROM_FACTORY.with(|s| s.set(true));
    let status =
      unsafe { sys::napi_new_instance(self.env, this, 0, ptr::null_mut(), &mut instance) };
    ___CALL_FROM_FACTORY.with(|s| s.set(false));
    // Error thrown in `constructor`
    if status == sys::Status::napi_pending_exception {
      let mut exception = ptr::null_mut();
      unsafe { sys::napi_get_and_clear_last_exception(self.env, &mut exception) };
      unsafe { sys::napi_throw(self.env, exception) };
      return Ok((ptr::null_mut(), ptr::null_mut()));
    }
    check_status!(status, "Failed to create instance of class `{}`", js_name)?;
    let obj = Box::new(obj);
    let initial_finalize: Box<dyn FnOnce()> = Box::new(|| {});
    // See `_construct`: `Arc` is required for `Reference`'s `Sync` impl; the `Cell` is
    // only touched on the JS thread.
    #[allow(clippy::arc_with_non_send_sync)]
    let finalize_callbacks_ptr =
      Arc::into_raw(Arc::new(Cell::new(Box::into_raw(initial_finalize))));
    let mut object_ref = ptr::null_mut();
    let mut value_ref = Box::into_raw(obj);

    // for empty struct like `#[napi] struct A;`, the `value_ref` will be `0x1`
    // and it will be overwritten by the others instance of the same class
    if value_ref as usize == 0x1 {
      value_ref = Box::into_raw(Box::new(EmptyStructPlaceholder(0))).cast();
    }
    check_status!(
      unsafe {
        sys::napi_wrap(
          self.env,
          instance,
          value_ref.cast(),
          Some(raw_finalize_unchecked::<T>),
          ptr::null_mut(),
          &mut object_ref,
        )
      },
      "Failed to initialize class `{}`",
      js_name,
    )?;

    Reference::<T>::add_ref(
      self.env,
      value_ref.cast(),
      (value_ref.cast(), object_ref, finalize_callbacks_ptr),
    );

    // Stamp the type tag AFTER `add_ref` so a tag failure cannot leak the Arc +
    // napi_ref (see `_construct`). Compiled only on napi8 NATIVE targets (the
    // `T: MaybeTypeTag` bound provides `T::type_tag()` only there).
    #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
    unsafe {
      tag_object(self.env, instance, &T::type_tag())?;
    }

    Ok((instance, value_ref))
  }

  pub fn unwrap_borrow_mut<T>(&mut self) -> Result<&'static mut T>
  where
    T: FromNapiMutRef + TypeName + MaybeTypeTag,
  {
    unsafe { self.unwrap_raw::<T>() }.map(|raw| Box::leak(unsafe { Box::from_raw(raw) }))
  }

  pub fn unwrap_borrow<T>(&mut self) -> Result<&'static T>
  where
    T: FromNapiRef + TypeName + MaybeTypeTag,
  {
    unsafe { self.unwrap_raw::<T>() }
      .map(|raw| Box::leak(unsafe { Box::from_raw(raw) }) as &'static T)
  }

  #[doc(hidden)]
  #[inline]
  pub unsafe fn unwrap_raw<T>(&mut self) -> Result<*mut T>
  where
    T: TypeName + MaybeTypeTag,
  {
    let mut wrapped_val: *mut c_void = std::ptr::null_mut();

    unsafe {
      check_status!(
        sys::napi_unwrap(self.env, self.this, &mut wrapped_val),
        "Failed to unwrap exclusive reference of `{}` type from napi value",
        T::type_name(),
      )?;

      // Reject a spoofed receiver (`ClassA.prototype.method.call(new ClassB())`)
      // before the blind cast below. On Node this wrong receiver is *also*
      // rejected by the V8 FunctionTemplate signature that `napi_define_class`
      // installs on instance methods ("Illegal invocation", before the callback
      // runs) — but that signature is NOT enforced by every supported Node-API
      // runtime: Bun (exercised by CI's `test-latest-bun` job) invokes the
      // callback with a wrong-class receiver where Node throws. Without this tag
      // check `napi_unwrap` hands back the other class's pointer and the cast
      // below is type-confused (UB). Compiled only on napi8 NATIVE targets (the
      // `T: MaybeTypeTag` bound provides `T::type_tag()` only there; elsewhere
      // this is the pre-tag unchecked cast).
      #[cfg(all(feature = "napi8", not(target_family = "wasm")))]
      validate_type_tag(self.env, self.this, &T::type_tag(), T::type_name())?;

      Ok(wrapped_val.cast())
    }
  }
}
