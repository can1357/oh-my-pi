use std::cell::RefCell;
use std::collections::HashSet;
use std::ffi::c_void;
use std::marker::PhantomData;
use std::ptr;
use std::rc::Rc;
use std::sync::{LazyLock, Mutex};
use std::{cell::Cell, panic::UnwindSafe};

use crate::{
  async_work,
  bindgen_prelude::{FromNapiValue, JsObjectValue, ToNapiValue, TypeName, Unknown},
  check_status, sys, Env, Error, JsError, ScopedTask, Status, Value, ValueType,
};

use super::Object;

pub struct AsyncTask<T: for<'task> ScopedTask<'task>> {
  inner: T,
  abort_signal: Option<AbortSignal>,
}

impl<T: for<'task> ScopedTask<'task>> TypeName for T {
  fn type_name() -> &'static str {
    "AsyncTask"
  }

  fn value_type() -> crate::ValueType {
    crate::ValueType::Object
  }
}

impl<T: for<'task> ScopedTask<'task>> AsyncTask<T> {
  pub fn new(task: T) -> Self {
    Self {
      inner: task,
      abort_signal: None,
    }
  }

  pub fn with_signal(task: T, signal: AbortSignal) -> Self {
    Self {
      inner: task,
      abort_signal: Some(signal),
    }
  }

  pub fn with_optional_signal(task: T, signal: Option<AbortSignal>) -> Self {
    Self {
      inner: task,
      abort_signal: signal,
    }
  }
}

type AbortCallback = Rc<RefCell<Vec<Box<dyn Fn()>>>>;

/// <https://developer.mozilla.org/zh-CN/docs/Web/API/AbortController>
pub struct AbortSignal {
  raw_work: Rc<Cell<sys::napi_async_work>>,
  status: Rc<Cell<u8>>,
  abort: AbortCallback,
}

impl AbortSignal {
  pub fn on_abort<F: Fn() + 'static>(&self, cb: F) {
    self.abort.borrow_mut().push(Box::new(cb));
  }
}

impl UnwindSafe for AbortSignal {}
impl std::panic::RefUnwindSafe for AbortSignal {}

#[repr(transparent)]
struct AbortSignalStack(Vec<AbortSignal>);

/// Registry of live `AbortSignalStack` allocations. `napi_unwrap` and
/// `napi_remove_wrap` return an untyped payload pointer, so before casting a
/// wrapped object's payload to `AbortSignalStack` the pointer must be in this
/// set. Pure-JS code has no way to insert into it, which makes the check
/// unforgeable on every N-API version and on wasm, where object type tags are
/// unavailable (GHSA-qr54-xrr9-7575). Entries are inserted after a successful
/// `napi_wrap` and removed by the wrap finalizer.
static ABORT_SIGNAL_STACKS: LazyLock<Mutex<HashSet<usize>>> =
  LazyLock::new(|| Mutex::new(HashSet::new()));

fn register_stack(ptr: *mut AbortSignalStack) {
  ABORT_SIGNAL_STACKS.lock().unwrap().insert(ptr as usize);
}

fn unregister_stack(ptr: *mut AbortSignalStack) {
  ABORT_SIGNAL_STACKS.lock().unwrap().remove(&(ptr as usize));
}

fn is_registered_stack(ptr: *const AbortSignalStack) -> bool {
  ABORT_SIGNAL_STACKS
    .lock()
    .unwrap()
    .contains(&(ptr as usize))
}

impl FromNapiValue for AbortSignal {
  unsafe fn from_napi_value(env: sys::napi_env, napi_val: sys::napi_value) -> crate::Result<Self> {
    let mut signal = Object(
      Value {
        env,
        value: napi_val,
        value_type: ValueType::Object,
      },
      PhantomData,
    );
    let async_work_inner: Rc<Cell<sys::napi_async_work>> = Rc::new(Cell::new(ptr::null_mut()));
    let task_status = Rc::new(Cell::new(0));
    let abort_cbs = Rc::new(RefCell::new(vec![]));
    let abort_signal = AbortSignal {
      raw_work: async_work_inner.clone(),
      status: task_status.clone(),
      abort: abort_cbs.clone(),
    };
    let js_env = Env::from_raw(env);

    // If the object is already wrapped, its payload may only be read as an
    // `AbortSignalStack` when a conversion by THIS addon binary registered
    // it. A `#[napi]` class instance wraps a bare `*mut T`; casting that is a
    // type confusion.
    //
    // Two deliberate consequences:
    // - A recognized stack is only BORROWED to push onto it: ownership,
    //   finalizer, and registry entry stay with the wrap's installer.
    //   Detaching and re-wrapping would leave the installer's registry entry
    //   stale after the new owner's finalizer frees the stack.
    // - A wrap made by a SIBLING addon binary is rejected too: mutating
    //   another binary's Rust `Vec` (or dropping its `Rc` contents) crosses
    //   allocator and ABI boundaries that Rust does not stabilize.
    let mut maybe_stack = ptr::null_mut();
    let unwrap_status = unsafe { sys::napi_unwrap(env, signal.0.value, &mut maybe_stack) };
    if unwrap_status == sys::Status::napi_ok {
      if !is_registered_stack(maybe_stack.cast()) {
        return Err(Error::new(
          Status::InvalidArg,
          "Value is not an AbortSignal".to_owned(),
        ));
      }
      let stack = unsafe { &mut *maybe_stack.cast::<AbortSignalStack>() };
      stack.0.push(abort_signal);
    } else {
      let stack_ptr = Box::into_raw(Box::new(AbortSignalStack(vec![abort_signal])));
      let mut signal_ref = ptr::null_mut();
      let wrap_status = unsafe {
        sys::napi_wrap(
          env,
          signal.0.value,
          stack_ptr.cast(),
          Some(async_task_abort_controller_finalize),
          ptr::null_mut(),
          &mut signal_ref,
        )
      };
      if wrap_status != sys::Status::napi_ok {
        // The finalizer will never run; reclaim the box here.
        drop(unsafe { Box::from_raw(stack_ptr) });
      }
      check_status!(wrap_status, "Wrap AbortSignal failed")?;
      register_stack(stack_ptr);
    }
    signal.set_named_property(
      "onabort",
      js_env.create_function::<(), Unknown>("onabort", on_abort)?,
    )?;

    Ok(AbortSignal {
      raw_work: async_work_inner,
      status: task_status,
      abort: abort_cbs,
    })
  }
}

extern "C" fn on_abort(
  env: sys::napi_env,
  callback_info: sys::napi_callback_info,
) -> sys::napi_value {
  match on_abort_impl(env, callback_info) {
    Err(err) => {
      let js_err = JsError::from(err);
      unsafe { js_err.throw_into(env) };
      ptr::null_mut()
    }
    Ok(undefined) => undefined,
  }
}

fn on_abort_impl(
  env: sys::napi_env,
  callback_info: sys::napi_callback_info,
) -> Result<sys::napi_value, Error> {
  let mut this = ptr::null_mut();
  unsafe {
    check_status!(
      sys::napi_get_cb_info(
        env,
        callback_info,
        &mut 0,
        ptr::null_mut(),
        &mut this,
        ptr::null_mut(),
      ),
      "Get callback info in AbortController abort callback failed"
    )?;
    let mut async_task = ptr::null_mut();
    check_status!(
      sys::napi_unwrap(env, this, &mut async_task),
      "Unwrap async_task from AbortSignal failed"
    )?;
    // `onabort` is an ordinary extractable function value: it can be stolen
    // and called with an arbitrary receiver. Only receivers whose payload this
    // addon binary registered are genuine AbortSignal stacks.
    if !is_registered_stack(async_task.cast()) {
      return Err(Error::new(
        Status::InvalidArg,
        "Value is not an AbortSignal".to_owned(),
      ));
    }
    let abort_controller_stack = &*(async_task as *const AbortSignalStack);
    for abort_controller in abort_controller_stack.0.iter() {
      // call abort callback
      for cb in abort_controller.abort.borrow().iter() {
        cb();
      }

      // Task Completed, return now
      if abort_controller.status.get() == 1 {
        return Ok(ptr::null_mut());
      }
      let raw_async_work = abort_controller.raw_work.get();
      let status = sys::napi_cancel_async_work(env, raw_async_work);
      // async work is already started, so we can't cancel it
      if status != sys::Status::napi_ok {
        abort_controller.status.set(0);
      } else {
        // abort function must be called from JavaScript main thread, so Relaxed Ordering is ok.
        abort_controller.status.set(2);
      }
    }
    let mut undefined = ptr::null_mut();
    check_status!(
      sys::napi_get_undefined(env, &mut undefined),
      "Get undefined in AbortSignal::on_abort callback failed"
    )?;
    Ok(undefined)
  }
}

impl<T: for<'task> ScopedTask<'task>> ToNapiValue for AsyncTask<T> {
  unsafe fn to_napi_value(env: sys::napi_env, val: Self) -> crate::Result<sys::napi_value> {
    if let Some(abort_signal) = val.abort_signal {
      let async_promise = async_work::run(env, val.inner, Some(abort_signal.status.clone()))?;
      abort_signal.raw_work.set(async_promise.napi_async_work);
      Ok(async_promise.promise_object().inner)
    } else {
      let async_promise = async_work::run(env, val.inner, None)?;
      Ok(async_promise.promise_object().inner)
    }
  }
}

unsafe extern "C" fn async_task_abort_controller_finalize(
  _env: sys::napi_env,
  finalize_data: *mut c_void,
  _finalize_hint: *mut c_void,
) {
  unregister_stack(finalize_data.cast());
  drop(unsafe { Box::from_raw(finalize_data as *mut AbortSignalStack) });
}
