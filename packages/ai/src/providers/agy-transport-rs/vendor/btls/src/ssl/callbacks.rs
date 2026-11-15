#![forbid(unsafe_op_in_unsafe_fn)]

use super::{
    AlpnError, CertificateCompressor, ClientHello, GetSessionPendingError, PrivateKeyMethod,
    PrivateKeyMethodError, SelectCertError, SniError, Ssl, SslAlert, SslContext, SslContextRef,
    SslInfoCallbackAlert, SslInfoCallbackMode, SslInfoCallbackValue, SslRef, SslSession,
    SslSessionRef, SslSignatureAlgorithm, SslVerifyError, SESSION_CTX_INDEX,
};
use crate::error::ErrorStack;
use crate::ffi;
use crate::hmac::HmacCtxRef;
use crate::ssl::TicketKeyCallbackResult;
use crate::symm::CipherCtxRef;
use crate::x509::{X509StoreContext, X509StoreContextRef};
use foreign_types::ForeignType;
use foreign_types::ForeignTypeRef;
use libc::{c_char, c_int, c_uchar, c_uint, c_void};
use std::ffi::CStr;
use std::mem::{self, MaybeUninit};
use std::ptr;
use std::slice;
use std::str;
use std::sync::Arc;

pub extern "C" fn raw_verify<F>(preverify_ok: c_int, x509_ctx: *mut ffi::X509_STORE_CTX) -> c_int
where
    F: Fn(bool, &mut X509StoreContextRef) -> bool + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ctx = unsafe { X509StoreContextRef::from_ptr_mut(x509_ctx) };

    let ssl_idx = X509StoreContext::ssl_idx().expect("BUG: store context ssl index missing");
    let verify_idx = SslContext::cached_ex_index::<F>();

    let verify = ctx
        .ex_data(ssl_idx)
        .expect("BUG: store context missing ssl")
        .ssl_context()
        .ex_data(verify_idx)
        .expect("BUG: verify callback missing");

    // SAFETY: The callback won't outlive the context it's associated with
    // because there is no `X509StoreContextRef::ssl_mut(&mut self)` method.
    let verify = unsafe { &*std::ptr::from_ref::<F>(verify) };

    c_int::from(verify(preverify_ok != 0, ctx))
}

pub(super) unsafe extern "C" fn raw_custom_verify<F>(
    ssl: *mut ffi::SSL,
    out_alert: *mut u8,
) -> ffi::ssl_verify_result_t
where
    F: Fn(&mut SslRef) -> Result<(), SslVerifyError> + 'static + Sync + Send,
{
    let callback = |ssl: &mut SslRef| {
        let custom_verify_idx = SslContext::cached_ex_index::<F>();

        let ssl_context = ssl.ssl_context().to_owned();
        let callback = ssl_context
            .ex_data(custom_verify_idx)
            .expect("BUG: custom verify callback missing");

        callback(ssl)
    };

    unsafe { raw_custom_verify_callback(ssl, out_alert, callback) }
}

pub(super) unsafe extern "C" fn raw_cert_verify<F>(
    x509_ctx: *mut ffi::X509_STORE_CTX,
    _arg: *mut c_void,
) -> c_int
where
    F: Fn(&mut X509StoreContextRef) -> bool + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ctx = unsafe { X509StoreContextRef::from_ptr_mut(x509_ctx) };

    let ssl_idx = X509StoreContext::ssl_idx().expect("BUG: store context ssl index missing");
    let verify_idx = SslContext::cached_ex_index::<F>();

    let verify = ctx
        .ex_data(ssl_idx)
        .expect("BUG: store context missing ssl")
        .ssl_context()
        .ex_data(verify_idx)
        .expect("BUG: verify callback missing");

    // SAFETY: The callback won't outlive the context it's associated with
    // because there is no way to get a mutable reference to the `SslContext`,
    // so the callback can't replace itself.
    let verify = unsafe { &*std::ptr::from_ref::<F>(verify) };

    c_int::from(verify(ctx))
}

pub(super) unsafe extern "C" fn ssl_raw_custom_verify<F>(
    ssl: *mut ffi::SSL,
    out_alert: *mut u8,
) -> ffi::ssl_verify_result_t
where
    F: Fn(&mut SslRef) -> Result<(), SslVerifyError> + 'static + Sync + Send,
{
    let callback = |ssl: &mut SslRef| {
        let callback = ssl
            .ex_data(Ssl::cached_ex_index::<Arc<F>>())
            .expect("BUG: ssl verify callback missing")
            .clone();

        callback(ssl)
    };

    unsafe { raw_custom_verify_callback(ssl, out_alert, callback) }
}

unsafe fn raw_custom_verify_callback(
    ssl: *mut ffi::SSL,
    out_alert: *mut u8,
    callback: impl FnOnce(&mut SslRef) -> Result<(), SslVerifyError>,
) -> ffi::ssl_verify_result_t {
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };
    let out_alert = unsafe { &mut *out_alert };

    match callback(ssl) {
        Ok(()) => ffi::ssl_verify_result_t::ssl_verify_ok,
        Err(SslVerifyError::Invalid(alert)) => {
            *out_alert = alert.0 as u8;

            ffi::ssl_verify_result_t::ssl_verify_invalid
        }
        Err(SslVerifyError::Retry) => ffi::ssl_verify_result_t::ssl_verify_retry,
    }
}

pub(super) unsafe extern "C" fn raw_client_psk<F>(
    ssl_ptr: *mut ffi::SSL,
    hint: *const c_char,
    identity: *mut c_char,
    max_identity_len: c_uint,
    psk: *mut c_uchar,
    max_psk_len: c_uint,
) -> c_uint
where
    F: Fn(&mut SslRef, Option<&[u8]>, &mut [u8], &mut [u8]) -> Result<usize, ErrorStack>
        + 'static
        + Sync
        + Send,
{
    // SAFETY: btls provides valid inputs.

    let ssl = unsafe { SslRef::from_ptr_mut(ssl_ptr) };

    let hint = if hint.is_null() {
        None
    } else {
        Some(unsafe { CStr::from_ptr(hint) }.to_bytes())
    };

    // Give the callback mutable slices into which it can write the identity and psk.
    let identity_sl =
        unsafe { slice::from_raw_parts_mut(identity.cast::<u8>(), max_identity_len as usize) };
    let psk_sl = unsafe { slice::from_raw_parts_mut(psk, max_psk_len as usize) };

    let ssl_context = ssl.ssl_context().to_owned();
    let callback = ssl_context
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: psk callback missing");

    match callback(ssl, hint, identity_sl, psk_sl) {
        Ok(psk_len) => psk_len as u32,
        Err(e) => {
            e.put();
            0
        }
    }
}

pub(super) unsafe extern "C" fn raw_server_psk<F>(
    ssl: *mut ffi::SSL,
    identity: *const c_char,
    psk: *mut c_uchar,
    max_psk_len: c_uint,
) -> c_uint
where
    F: Fn(&mut SslRef, Option<&[u8]>, &mut [u8]) -> Result<usize, ErrorStack>
        + 'static
        + Sync
        + Send,
{
    // SAFETY: btls provides valid inputs.

    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };

    let identity = if identity.is_null() {
        None
    } else {
        Some(unsafe { CStr::from_ptr(identity) }.to_bytes())
    };

    // Give the callback mutable slices into which it can write the psk.
    let psk_sl = unsafe { slice::from_raw_parts_mut(psk, max_psk_len as usize) };

    let ssl_context = ssl.ssl_context().to_owned();
    let callback = ssl_context
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: psk callback missing");

    match callback(ssl, identity, psk_sl) {
        Ok(psk_len) => psk_len as u32,
        Err(e) => {
            e.put();
            0
        }
    }
}

pub(super) unsafe extern "C" fn ssl_raw_verify<F>(
    preverify_ok: c_int,
    x509_ctx: *mut ffi::X509_STORE_CTX,
) -> c_int
where
    F: Fn(bool, &mut X509StoreContextRef) -> bool + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ctx = unsafe { X509StoreContextRef::from_ptr_mut(x509_ctx) };

    let ssl_idx = X509StoreContext::ssl_idx().expect("BUG: store context ssl index missing");

    // NOTE(nox): I'm pretty sure this Arc<F> is unnecessary here as there is
    // no way to get a `&mut SslRef` from a `&mut X509StoreContextRef`, and I
    // don't understand how this callback is different from `raw_verify` above.
    let callback = ctx
        .ex_data(ssl_idx)
        .expect("BUG: store context missing ssl")
        .ex_data(Ssl::cached_ex_index::<Arc<F>>())
        .expect("BUG: ssl verify callback missing")
        .clone();

    c_int::from(callback(preverify_ok != 0, ctx))
}

pub(super) unsafe extern "C" fn raw_sni<F>(
    ssl: *mut ffi::SSL,
    al: *mut c_int,
    arg: *mut c_void,
) -> c_int
where
    F: Fn(&mut SslRef, &mut SslAlert) -> Result<(), SniError> + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };
    let al = unsafe { &mut *al };

    // SAFETY: We can make `callback` outlive `ssl` because it is a callback
    // stored in the original context with which `ssl` was built. That
    // original context is always stored as the session context in
    // `Ssl::new` so it is always guaranteed to outlive the lifetime of
    // this function's scope.
    let callback = unsafe { &*(arg as *const F) };

    let mut alert = SslAlert(*al);

    let r = callback(ssl, &mut alert);

    *al = alert.0;

    match r {
        Ok(()) => ffi::SSL_TLSEXT_ERR_OK,
        Err(e) => e.0,
    }
}

unsafe fn to_uninit<'a, T: 'a>(ptr: *mut T) -> &'a mut MaybeUninit<T> {
    assert!(!ptr.is_null());
    unsafe { &mut *ptr.cast::<MaybeUninit<T>>() }
}

pub(super) unsafe extern "C" fn raw_ticket_key<F>(
    ssl: *mut ffi::SSL,
    key_name: *mut u8,
    iv: *mut u8,
    evp_ctx: *mut ffi::EVP_CIPHER_CTX,
    hmac_ctx: *mut ffi::HMAC_CTX,
    encrypt: c_int,
) -> c_int
where
    F: Fn(
            &SslRef,
            &mut [u8; 16],
            &mut [u8; ffi::EVP_MAX_IV_LENGTH as usize],
            &mut CipherCtxRef,
            &mut HmacCtxRef,
            bool,
        ) -> TicketKeyCallbackResult
        + 'static
        + Sync
        + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };

    let ssl_context = ssl.ssl_context().to_owned();
    let callback = ssl_context
        .ex_data::<F>(SslContext::cached_ex_index::<F>())
        .expect("expected session resumption callback");

    // SAFETY: the callback guarantees that key_name is 16 bytes
    let key_name =
        unsafe { to_uninit(key_name.cast::<[u8; ffi::SSL_TICKET_KEY_NAME_LEN as usize]>()) };

    // SAFETY: the callback provides 16 bytes iv
    //
    // https://github.com/google/boringssl/blob/main/ssl/ssl_session.cc#L331
    let iv = unsafe { to_uninit(iv.cast::<[u8; ffi::EVP_MAX_IV_LENGTH as usize]>()) };

    // When encrypting a new ticket, encrypt will be one.
    let encrypt = encrypt == 1;

    // Zero-initialize the key_name and iv, since the application is expected to populate these
    // fields in the encrypt mode.
    if encrypt {
        *key_name = MaybeUninit::zeroed();
        *iv = MaybeUninit::zeroed();
    }
    let key_name = unsafe { key_name.assume_init_mut() };
    let iv = unsafe { iv.assume_init_mut() };

    // The EVP_CIPHER_CTX and HMAC_CTX are owned by boringSSL.
    let evp_ctx = unsafe { CipherCtxRef::from_ptr_mut(evp_ctx) };
    let hmac_ctx = unsafe { HmacCtxRef::from_ptr_mut(hmac_ctx) };

    callback(ssl, key_name, iv, evp_ctx, hmac_ctx, encrypt).into()
}

pub(super) unsafe extern "C" fn raw_alpn_select<F>(
    ssl: *mut ffi::SSL,
    out: *mut *const c_uchar,
    outlen: *mut c_uchar,
    inbuf: *const c_uchar,
    inlen: c_uint,
    _arg: *mut c_void,
) -> c_int
where
    F: for<'a> Fn(&mut SslRef, &'a [u8]) -> Result<&'a [u8], AlpnError> + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };
    let protos = unsafe { slice::from_raw_parts(inbuf, inlen as usize) };
    let out = unsafe { &mut *out };
    let outlen = unsafe { &mut *outlen };

    let ssl_context = ssl.ssl_context().to_owned();
    let callback = ssl_context
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: alpn callback missing");

    match callback(ssl, protos) {
        Ok(proto) => {
            *out = proto.as_ptr();
            *outlen = proto.len() as c_uchar;

            ffi::SSL_TLSEXT_ERR_OK
        }
        Err(e) => e.0,
    }
}

pub(super) unsafe extern "C" fn raw_select_cert<F>(
    client_hello: *const ffi::SSL_CLIENT_HELLO,
) -> ffi::ssl_select_cert_result_t
where
    F: Fn(ClientHello<'_>) -> Result<(), SelectCertError> + Sync + Send + 'static,
{
    // SAFETY: btls provides valid inputs.
    let client_hello = ClientHello(unsafe { &*client_hello });

    let ssl_context = client_hello.ssl().ssl_context().to_owned();
    let callback = ssl_context
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: select cert callback missing");

    match callback(client_hello) {
        Ok(()) => ffi::ssl_select_cert_result_t::ssl_select_cert_success,
        Err(e) => e.0,
    }
}

pub(super) unsafe extern "C" fn raw_tlsext_status<F>(ssl: *mut ffi::SSL, _: *mut c_void) -> c_int
where
    F: Fn(&mut SslRef) -> Result<bool, ErrorStack> + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };

    let ssl_context = ssl.ssl_context().to_owned();
    let callback = ssl_context
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: ocsp callback missing");

    let ret = callback(ssl);

    if ssl.is_server() {
        match ret {
            Ok(true) => ffi::SSL_TLSEXT_ERR_OK,
            Ok(false) => ffi::SSL_TLSEXT_ERR_NOACK,
            Err(e) => {
                e.put();
                ffi::SSL_TLSEXT_ERR_ALERT_FATAL
            }
        }
    } else {
        match ret {
            Ok(true) => 1,
            Ok(false) => 0,
            Err(e) => {
                e.put();
                -1
            }
        }
    }
}

pub(super) unsafe extern "C" fn raw_new_session<F>(
    ssl: *mut ffi::SSL,
    session: *mut ffi::SSL_SESSION,
) -> c_int
where
    F: Fn(&mut SslRef, SslSession) + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };
    let session = unsafe { SslSession::from_ptr(session) };

    let callback = ssl
        .ex_data(*SESSION_CTX_INDEX)
        .expect("BUG: session context missing")
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: new session callback missing");

    // SAFETY: We can make `callback` outlive `ssl` because it is a callback
    // stored in the session context set in `Ssl::new` so it is always
    // guaranteed to outlive the lifetime of this function's scope.
    let callback = unsafe { &*std::ptr::from_ref::<F>(callback) };

    callback(ssl, session);

    // the return code doesn't indicate error vs success, but whether or not we consumed the session
    1
}

pub(super) unsafe extern "C" fn raw_remove_session<F>(
    ctx: *mut ffi::SSL_CTX,
    session: *mut ffi::SSL_SESSION,
) where
    F: Fn(&SslContextRef, &SslSessionRef) + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ctx = unsafe { SslContextRef::from_ptr(ctx) };
    let session = unsafe { SslSessionRef::from_ptr(session) };

    let callback = ctx
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: remove session callback missing");

    callback(ctx, session);
}

type DataPtr = *const c_uchar;

pub(super) unsafe extern "C" fn raw_get_session<F>(
    ssl: *mut ffi::SSL,
    data: DataPtr,
    len: c_int,
    copy: *mut c_int,
) -> *mut ffi::SSL_SESSION
where
    F: Fn(&mut SslRef, &[u8]) -> Result<Option<SslSession>, GetSessionPendingError>
        + 'static
        + Sync
        + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };
    let data = unsafe { slice::from_raw_parts(data, len as usize) };
    let copy = unsafe { &mut *copy };

    let callback = ssl
        .ex_data(*SESSION_CTX_INDEX)
        .expect("BUG: session context missing")
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: get session callback missing");

    // SAFETY: We can make `callback` outlive `ssl` because it is a callback
    // stored in the session context set in `Ssl::new` so it is always
    // guaranteed to outlive the lifetime of this function's scope.
    let callback = unsafe { &*std::ptr::from_ref::<F>(callback) };

    match callback(ssl, data) {
        Ok(Some(session)) => {
            let p = session.into_ptr();

            *copy = 0;

            p
        }
        Ok(None) => ptr::null_mut(),
        Err(GetSessionPendingError) => unsafe { ffi::SSL_magic_pending_session_ptr() },
    }
}

pub(super) unsafe extern "C" fn raw_keylog<F>(ssl: *const ffi::SSL, line: *const c_char)
where
    F: Fn(&SslRef, &str) + 'static + Sync + Send,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr(ssl.cast_mut()) };
    let line = unsafe { CStr::from_ptr(line).to_string_lossy() };

    let callback = ssl
        .ssl_context()
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: get session callback missing");

    callback(ssl, &line);
}

pub(super) unsafe extern "C" fn raw_sign<M>(
    ssl: *mut ffi::SSL,
    out: *mut u8,
    out_len: *mut usize,
    max_out: usize,
    signature_algorithm: u16,
    in_: *const u8,
    in_len: usize,
) -> ffi::ssl_private_key_result_t
where
    M: PrivateKeyMethod,
{
    // SAFETY: btls provides valid inputs.
    let input = unsafe { slice::from_raw_parts(in_, in_len) };

    let signature_algorithm = SslSignatureAlgorithm(signature_algorithm);

    let callback = |method: &M, ssl: &mut _, output: &mut _| {
        method.sign(ssl, input, signature_algorithm, output)
    };

    // SAFETY: btls provides valid inputs.
    unsafe { raw_private_key_callback(ssl, out, out_len, max_out, callback) }
}

pub(super) unsafe extern "C" fn raw_decrypt<M>(
    ssl: *mut ffi::SSL,
    out: *mut u8,
    out_len: *mut usize,
    max_out: usize,
    in_: *const u8,
    in_len: usize,
) -> ffi::ssl_private_key_result_t
where
    M: PrivateKeyMethod,
{
    // SAFETY: btls provides valid inputs.
    let input = unsafe { slice::from_raw_parts(in_, in_len) };

    let callback = |method: &M, ssl: &mut _, output: &mut _| method.decrypt(ssl, input, output);

    // SAFETY: btls provides valid inputs.
    unsafe { raw_private_key_callback(ssl, out, out_len, max_out, callback) }
}

pub(super) unsafe extern "C" fn raw_complete<M>(
    ssl: *mut ffi::SSL,
    out: *mut u8,
    out_len: *mut usize,
    max_out: usize,
) -> ffi::ssl_private_key_result_t
where
    M: PrivateKeyMethod,
{
    // SAFETY: btls provides valid inputs.
    unsafe { raw_private_key_callback::<M>(ssl, out, out_len, max_out, M::complete) }
}

unsafe fn raw_private_key_callback<M>(
    ssl: *mut ffi::SSL,
    out: *mut u8,
    out_len: *mut usize,
    max_out: usize,
    callback: impl FnOnce(&M, &mut SslRef, &mut [u8]) -> Result<usize, PrivateKeyMethodError>,
) -> ffi::ssl_private_key_result_t
where
    M: PrivateKeyMethod,
{
    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };
    let output = unsafe { slice::from_raw_parts_mut(out, max_out) };
    let out_len = unsafe { &mut *out_len };

    let ssl_context = ssl.ssl_context().to_owned();
    let method = ssl_context
        .ex_data(SslContext::cached_ex_index::<M>())
        .expect("BUG: private key method missing");

    match callback(method, ssl, output) {
        Ok(written) => {
            assert!(written <= max_out);

            *out_len = written;

            ffi::ssl_private_key_result_t::ssl_private_key_success
        }
        Err(err) => err.0,
    }
}

pub(super) unsafe extern "C" fn raw_info_callback<F>(
    ssl: *const ffi::SSL,
    mode: c_int,
    value: c_int,
) where
    F: Fn(&SslRef, SslInfoCallbackMode, SslInfoCallbackValue) + Send + Sync + 'static,
{
    // Due to FFI signature requirements we have to pass a *const SSL into this function, but
    // foreign-types requires a *mut SSL to get the Rust SslRef
    let mut_ref = ssl.cast_mut();

    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr(mut_ref) };
    let ssl_context = ssl.ssl_context();

    let callback = ssl_context
        .ex_data(SslContext::cached_ex_index::<F>())
        .expect("BUG: info callback missing");

    let value = match mode {
        ffi::SSL_CB_READ_ALERT | ffi::SSL_CB_WRITE_ALERT => {
            SslInfoCallbackValue::Alert(SslInfoCallbackAlert(value))
        }
        _ => SslInfoCallbackValue::Unit,
    };

    callback(ssl, SslInfoCallbackMode(mode), value);
}

pub(super) unsafe extern "C" fn raw_ssl_cert_compress<C>(
    ssl: *mut ffi::SSL,
    out: *mut ffi::CBB,
    input: *const u8,
    input_len: usize,
) -> ::std::os::raw::c_int
where
    C: CertificateCompressor,
{
    const {
        assert!(C::CAN_COMPRESS);
    }

    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };

    let ssl_context = ssl.ssl_context();
    let compressor = ssl_context
        .ex_data(SslContext::cached_ex_index::<C>())
        .expect("BUG: certificate compression missed");

    let input_slice = unsafe { std::slice::from_raw_parts(input, input_len) };
    let mut writer = CryptoByteBuilder::from_ptr(out);
    if compressor.compress(input_slice, &mut writer).is_err() {
        return 0;
    }

    1
}

pub(super) unsafe extern "C" fn raw_ssl_cert_decompress<C>(
    ssl: *mut ffi::SSL,
    out: *mut *mut ffi::CRYPTO_BUFFER,
    uncompressed_len: usize,
    input: *const u8,
    input_len: usize,
) -> ::std::os::raw::c_int
where
    C: CertificateCompressor,
{
    const {
        assert!(C::CAN_DECOMPRESS);
    }

    // SAFETY: btls provides valid inputs.
    let ssl = unsafe { SslRef::from_ptr_mut(ssl) };

    let ssl_context = ssl.ssl_context();
    let compressor = ssl_context
        .ex_data(SslContext::cached_ex_index::<C>())
        .expect("BUG: certificate compression missed");

    let Ok(mut decompression_buffer) = CryptoBufferBuilder::with_capacity(uncompressed_len) else {
        return 0;
    };

    let input_slice = unsafe { std::slice::from_raw_parts(input, input_len) };

    if compressor
        .decompress(input_slice, decompression_buffer.as_writer())
        .is_err()
    {
        return 0;
    }

    let Ok(crypto_buffer) = decompression_buffer.build() else {
        return 0;
    };

    unsafe { *out = crypto_buffer };
    1
}

struct CryptoByteBuilder<'a>(*mut ffi::CBB, std::marker::PhantomData<&'a [u8]>);

impl CryptoByteBuilder<'_> {
    fn from_ptr(ptr: *mut ffi::CBB) -> Self {
        Self(ptr, Default::default())
    }
}

impl std::io::Write for CryptoByteBuilder<'_> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let success = unsafe { ffi::CBB_add_bytes(self.0, buf.as_ptr(), buf.len()) == 1 };
        if !success {
            return Err(std::io::Error::other("CBB_add_bytes failed"));
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        let success = unsafe { ffi::CBB_flush(self.0) == 1 };
        if !success {
            return Err(std::io::Error::other("CBB_flush failed"));
        }
        Ok(())
    }
}

struct CryptoBufferBuilder<'a> {
    buffer: *mut ffi::CRYPTO_BUFFER,
    cursor: std::io::Cursor<&'a mut [u8]>,
}

impl<'a> CryptoBufferBuilder<'a> {
    fn with_capacity(capacity: usize) -> Result<CryptoBufferBuilder<'a>, ErrorStack> {
        let mut data: *mut u8 = std::ptr::null_mut();
        let buffer = unsafe { crate::cvt_p(ffi::CRYPTO_BUFFER_alloc(&mut data, capacity))? };
        Ok(CryptoBufferBuilder {
            buffer,
            cursor: std::io::Cursor::new(unsafe { std::slice::from_raw_parts_mut(data, capacity) }),
        })
    }

    fn as_writer(&mut self) -> &mut (impl std::io::Write + 'a) {
        &mut self.cursor
    }

    fn build(mut self) -> Result<*mut ffi::CRYPTO_BUFFER, ErrorStack> {
        let buffer_capacity = unsafe { ffi::CRYPTO_BUFFER_len(self.buffer) };
        if self.cursor.position() != buffer_capacity as u64 {
            // Make sure all bytes in buffer initialized as required by Boring SSL.
            return Err(ErrorStack::internal_error_str("invalid len"));
        }
        // Drop is no-op if the buffer is null
        Ok(mem::replace(&mut self.buffer, ptr::null_mut()))
    }
}

impl Drop for CryptoBufferBuilder<'_> {
    fn drop(&mut self) {
        if !self.buffer.is_null() {
            unsafe {
                btls_sys::CRYPTO_BUFFER_free(self.buffer);
            }
        }
    }
}
