use std::mem;

use crate::{sys, Status};

/// Notice
/// The hook will be removed if `AsyncCleanupHook` was `dropped`.
/// If you want keep the hook until node process exited, call the `AsyncCleanupHook::forget`.
#[repr(transparent)]
pub struct AsyncCleanupHook(pub(crate) sys::napi_async_cleanup_hook_handle);

impl AsyncCleanupHook {
  /// Safe to forget it.
  /// Things will be cleanup before process exited.
  pub fn forget(self) {
    mem::forget(self);
  }
}

impl Drop for AsyncCleanupHook {
  fn drop(&mut self) {
    let status = unsafe { sys::napi_remove_async_cleanup_hook(self.0) };
    assert!(
      status == sys::Status::napi_ok,
      "Delete async cleanup hook failed: {}",
      Status::from(status)
    );
  }
}
