//! Interface for processing OpenSSL configuration files.
use crate::ffi;
use foreign_types::ForeignType;
use libc::c_void;

use crate::cvt_p;
use crate::error::ErrorStack;

pub struct ConfMethod(*mut c_void);

impl ConfMethod {
    /// Construct from raw pointer.
    ///
    /// # Safety
    ///
    /// The caller must ensure that the pointer is valid.
    pub unsafe fn from_ptr(ptr: *mut c_void) -> ConfMethod {
        ConfMethod(ptr)
    }

    /// Convert to raw pointer.
    #[must_use]
    pub fn as_ptr(&self) -> *mut c_void {
        self.0
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::CONF;
    fn drop = ffi::NCONF_free;

    pub struct Conf;
}

impl Conf {
    /// Create a configuration parser.
    pub fn new(method: ConfMethod) -> Result<Conf, ErrorStack> {
        unsafe { cvt_p(ffi::NCONF_new(method.as_ptr())).map(|p| Conf::from_ptr(p)) }
    }
}
