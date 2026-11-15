use crate::error::ErrorStack;
use crate::ex_data::Index;
use crate::pkey::{PKeyRef, Private};
use crate::ssl::callbacks;
use crate::ssl::PrivateKeyMethod;
use crate::{cvt_0i, cvt_n};
use crate::{ffi, free_data_box};
use foreign_types::{ForeignType, ForeignTypeRef};
use openssl_macros::corresponds;
use std::any::TypeId;
use std::collections::HashMap;
use std::ffi::{c_int, c_void};
use std::mem;
use std::ptr;
use std::sync::{LazyLock, Mutex};

static SSL_CREDENTIAL_INDEXES: LazyLock<Mutex<HashMap<TypeId, c_int>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

foreign_type_and_impl_send_sync! {
    type CType = ffi::SSL_CREDENTIAL;
    fn drop = ffi::SSL_CREDENTIAL_free;

    /// A credential.
    pub struct SslCredential;
}

impl SslCredential {
    /// Returns a new extra data index.
    ///
    /// Each invocation of this function is guaranteed to return a distinct index. These can be used
    /// to store data in the context that can be retrieved later by callbacks, for example.
    #[corresponds(SSL_C_get_ex_new_index)]
    pub fn new_ex_index<T>() -> Result<Index<Self, T>, ErrorStack>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            ffi::init();
            let idx = cvt_n(get_new_ssl_credential_idx(Some(free_data_box::<T>)))?;
            Ok(Index::from_raw(idx))
        }
    }

    // FIXME should return a result?
    pub(crate) fn cached_ex_index<T>() -> Index<Self, T>
    where
        T: 'static + Sync + Send,
    {
        unsafe {
            let idx = *SSL_CREDENTIAL_INDEXES
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .entry(TypeId::of::<T>())
                .or_insert_with(|| Self::new_ex_index::<T>().unwrap().as_raw());
            Index::from_raw(idx)
        }
    }
}

impl SslCredentialRef {
    /// Returns a reference to the extra data at the specified index.
    #[corresponds(SSL_CREDENTIAL_get_ex_data)]
    #[must_use]
    pub fn ex_data<T>(&self, index: Index<SslCredential, T>) -> Option<&T> {
        unsafe {
            let data = ffi::SSL_CREDENTIAL_get_ex_data(self.as_ptr(), index.as_raw());
            if data.is_null() {
                None
            } else {
                Some(&*(data as *const T))
            }
        }
    }

    // Unsafe because SSL contexts are not guaranteed to be unique, we call
    // this only from SslCredentialBuilder.
    #[corresponds(SSL_CREDENTIAL_get_ex_data)]
    pub(crate) unsafe fn ex_data_mut<T>(
        &mut self,
        index: Index<SslCredential, T>,
    ) -> Option<&mut T> {
        let data = ffi::SSL_CREDENTIAL_get_ex_data(self.as_ptr(), index.as_raw());
        if data.is_null() {
            None
        } else {
            Some(&mut *(data as *mut T))
        }
    }

    // Unsafe because SSL contexts are not guaranteed to be unique, we call
    // this only from SslCredentialBuilder.
    #[corresponds(SSL_CREDENTIAL_set_ex_data)]
    pub(crate) unsafe fn replace_ex_data<T>(
        &mut self,
        index: Index<SslCredential, T>,
        data: T,
    ) -> Option<T> {
        if let Some(old) = self.ex_data_mut(index) {
            return Some(mem::replace(old, data));
        }

        unsafe {
            let data = Box::into_raw(Box::new(data)) as *mut c_void;
            ffi::SSL_CREDENTIAL_set_ex_data(self.as_ptr(), index.as_raw(), data);
        }

        None
    }
}

/// A builder for [`SslCredential`]
pub struct SslCredentialBuilder(SslCredential);

impl SslCredentialBuilder {
    /// Sets or overwrites the extra data at the specified index.
    ///
    /// This can be used to provide data to callbacks registered with the context. Use the
    /// `SslCredential::new_ex_index` method to create an `Index`.
    ///
    /// Any previous value will be returned and replaced by the new one.
    #[corresponds(SSL_CREDENTIAL_set_ex_data)]
    pub fn replace_ex_data<T>(&mut self, index: Index<SslCredential, T>, data: T) -> Option<T> {
        unsafe { self.0.replace_ex_data(index, data) }
    }

    // Sets the private key of the credential.
    #[corresponds(SSL_CREDENTIAL_set1_private_key)]
    pub fn set_private_key(&mut self, private_key: &PKeyRef<Private>) -> Result<(), ErrorStack> {
        unsafe {
            cvt_0i(ffi::SSL_CREDENTIAL_set1_private_key(
                self.0.as_ptr(),
                private_key.as_ptr(),
            ))
            .map(|_| ())
        }
    }

    /// Configures a custom private key method on the credential.
    ///
    /// See [`PrivateKeyMethod`] for more details.
    #[corresponds(SSL_CREDENTIAL_set_private_key_method)]
    pub fn set_private_key_method<M>(&mut self, method: M) -> Result<(), ErrorStack>
    where
        M: PrivateKeyMethod,
    {
        unsafe {
            self.replace_ex_data(SslCredential::cached_ex_index::<M>(), method);

            cvt_0i(ffi::SSL_CREDENTIAL_set_private_key_method(
                self.0.as_ptr(),
                &ffi::SSL_PRIVATE_KEY_METHOD {
                    sign: Some(callbacks::raw_sign::<M>),
                    decrypt: Some(callbacks::raw_decrypt::<M>),
                    complete: Some(callbacks::raw_complete::<M>),
                },
            ))
            .map(|_| ())
        }
    }

    #[must_use]
    pub fn build(self) -> SslCredential {
        self.0
    }
}

unsafe fn get_new_ssl_credential_idx(f: ffi::CRYPTO_EX_free) -> c_int {
    ffi::SSL_CREDENTIAL_get_ex_new_index(0, ptr::null_mut(), ptr::null_mut(), None, f)
}
