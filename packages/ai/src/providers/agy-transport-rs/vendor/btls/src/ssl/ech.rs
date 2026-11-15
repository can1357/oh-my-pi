use crate::ffi;
use foreign_types::ForeignType;
use libc::c_int;

use crate::error::ErrorStack;
use crate::hpke::HpkeKey;
use crate::{cvt_0i, cvt_p};

pub struct SslEchKeysBuilder {
    keys: SslEchKeys,
}

impl SslEchKeysBuilder {
    pub fn new() -> Result<SslEchKeysBuilder, ErrorStack> {
        unsafe {
            ffi::init();
            let keys = cvt_p(ffi::SSL_ECH_KEYS_new())?;

            Ok(SslEchKeysBuilder::from_ptr(keys))
        }
    }

    pub unsafe fn from_ptr(keys: *mut ffi::SSL_ECH_KEYS) -> Self {
        Self {
            keys: unsafe { SslEchKeys::from_ptr(keys) },
        }
    }

    pub fn add_key(
        &mut self,
        is_retry_config: bool,
        ech_config: &[u8],
        key: HpkeKey,
    ) -> Result<(), ErrorStack> {
        unsafe {
            cvt_0i(ffi::SSL_ECH_KEYS_add(
                self.keys.as_ptr(),
                c_int::from(is_retry_config),
                ech_config.as_ptr(),
                ech_config.len(),
                key.as_ptr(),
            ))
            .map(|_| ())
        }
    }

    pub fn build(self) -> SslEchKeys {
        self.keys
    }
}

foreign_type_and_impl_send_sync! {
    type CType = ffi::SSL_ECH_KEYS;
    fn drop = ffi::SSL_ECH_KEYS_free;

    pub struct SslEchKeys;
}

impl SslEchKeys {
    pub fn builder() -> Result<SslEchKeysBuilder, ErrorStack> {
        SslEchKeysBuilder::new()
    }
}
