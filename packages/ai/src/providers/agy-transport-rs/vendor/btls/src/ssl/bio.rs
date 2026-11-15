use crate::ffi::{
    self, BIO_clear_retry_flags, BIO_new, BIO_set_retry_read, BIO_set_retry_write, BIO,
    BIO_CTRL_DGRAM_QUERY_MTU, BIO_CTRL_FLUSH,
};
use libc::{c_char, c_int, c_long, c_void, strlen};
use std::any::Any;
use std::io;
use std::io::prelude::*;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr;
use std::slice;

use crate::cvt_p;
use crate::error::ErrorStack;

pub struct StreamState<S> {
    pub stream: S,
    pub error: Option<io::Error>,
    pub panic: Option<Box<dyn Any + Send>>,
    pub dtls_mtu_size: c_long,
}

/// Safe wrapper for BIO_METHOD
pub struct BioMethod(BIO_METHOD);

impl BioMethod {
    fn new<S: Read + Write>() -> BioMethod {
        BioMethod(BIO_METHOD::new::<S>())
    }
}

unsafe impl Sync for BioMethod {}
unsafe impl Send for BioMethod {}

pub fn new<S: Read + Write>(stream: S) -> Result<(*mut BIO, BioMethod), ErrorStack> {
    let method = BioMethod::new::<S>();

    let state = Box::new(StreamState {
        stream,
        error: None,
        panic: None,
        dtls_mtu_size: 0,
    });

    unsafe {
        let bio = cvt_p(BIO_new(method.0.get()))?;
        BIO_set_data(bio, Box::into_raw(state).cast());
        BIO_set_init(bio, 1);

        Ok((bio, method))
    }
}

pub unsafe fn take_error<S>(bio: *mut BIO) -> Option<io::Error> {
    unsafe {
        let state = state::<S>(bio);
        state.error.take()
    }
}

pub unsafe fn take_panic<S>(bio: *mut BIO) -> Option<Box<dyn Any + Send>> {
    unsafe {
        let state = state::<S>(bio);
        state.panic.take()
    }
}

pub unsafe fn get_ref<'a, S: 'a>(bio: *mut BIO) -> &'a S {
    unsafe { &state(bio).stream }
}

pub unsafe fn get_mut<'a, S: 'a>(bio: *mut BIO) -> &'a mut S {
    unsafe { &mut state(bio).stream }
}

pub unsafe extern "C" fn take_stream<S>(bio: *mut BIO) -> S {
    assert!(!bio.is_null());
    unsafe {
        let data = BIO_get_data(bio);

        assert!(!data.is_null());

        let state = Box::<StreamState<S>>::from_raw(data.cast());

        BIO_set_data(bio, ptr::null_mut());

        state.stream
    }
}

pub unsafe fn set_dtls_mtu_size<S>(bio: *mut BIO, mtu_size: usize) {
    unsafe {
        if mtu_size as u64 > c_long::MAX as u64 {
            panic!("Given MTU size {mtu_size} can't be represented in a positive `c_long` range")
        }
        state::<S>(bio).dtls_mtu_size = mtu_size as c_long;
    }
}

unsafe fn state<'a, S: 'a>(bio: *mut BIO) -> &'a mut StreamState<S> {
    unsafe {
        let data = BIO_get_data(bio).cast::<StreamState<S>>();

        assert!(!data.is_null());

        &mut *data
    }
}

unsafe extern "C" fn bwrite<S: Write>(bio: *mut BIO, buf: *const c_char, len: c_int) -> c_int {
    unsafe {
        BIO_clear_retry_flags(bio);

        let Ok(len) = usize::try_from(len) else {
            return -1;
        };

        let state = state::<S>(bio);
        let buf = slice::from_raw_parts(buf.cast(), len);

        match catch_unwind(AssertUnwindSafe(|| state.stream.write(buf))) {
            Ok(Ok(len)) => len as c_int,
            Ok(Err(err)) => {
                if retriable_error(&err) {
                    BIO_set_retry_write(bio);
                }
                state.error = Some(err);
                -1
            }
            Err(err) => {
                state.panic = Some(err);
                -1
            }
        }
    }
}

unsafe extern "C" fn bread<S: Read>(bio: *mut BIO, buf: *mut c_char, len: c_int) -> c_int {
    unsafe {
        BIO_clear_retry_flags(bio);

        let Ok(len) = usize::try_from(len) else {
            return -1;
        };

        let state = state::<S>(bio);
        let buf = slice::from_raw_parts_mut(buf.cast(), len);

        match catch_unwind(AssertUnwindSafe(|| state.stream.read(buf))) {
            Ok(Ok(len)) => len as c_int,
            Ok(Err(err)) => {
                if retriable_error(&err) {
                    BIO_set_retry_read(bio);
                }
                state.error = Some(err);
                -1
            }
            Err(err) => {
                state.panic = Some(err);
                -1
            }
        }
    }
}

#[allow(clippy::match_like_matches_macro)] // matches macro requires rust 1.42.0
fn retriable_error(err: &io::Error) -> bool {
    match err.kind() {
        io::ErrorKind::WouldBlock | io::ErrorKind::NotConnected => true,
        _ => false,
    }
}

unsafe extern "C" fn bputs<S: Write>(bio: *mut BIO, s: *const c_char) -> c_int {
    unsafe { bwrite::<S>(bio, s, strlen(s) as c_int) }
}

unsafe extern "C" fn ctrl<S: Write>(
    bio: *mut BIO,
    cmd: c_int,
    _num: c_long,
    _ptr: *mut c_void,
) -> c_long {
    unsafe {
        let state = state::<S>(bio);

        if cmd == BIO_CTRL_FLUSH {
            BIO_clear_retry_flags(bio);
            match catch_unwind(AssertUnwindSafe(|| state.stream.flush())) {
                Ok(Ok(())) => 1,
                Ok(Err(err)) => {
                    if retriable_error(&err) {
                        BIO_set_retry_write(bio);
                    }
                    state.error = Some(err);
                    0
                }
                Err(err) => {
                    state.panic = Some(err);
                    0
                }
            }
        } else if cmd == BIO_CTRL_DGRAM_QUERY_MTU {
            state.dtls_mtu_size
        } else {
            0
        }
    }
}

unsafe extern "C" fn create(bio: *mut BIO) -> c_int {
    unsafe {
        BIO_set_init(bio, 0);
        BIO_set_num(bio, 0);
        BIO_set_data(bio, ptr::null_mut());
        BIO_set_flags(bio, 0);
        1
    }
}

unsafe extern "C" fn destroy<S>(bio: *mut BIO) -> c_int {
    if bio.is_null() {
        return 0;
    }

    unsafe {
        let data = BIO_get_data(bio);

        if !data.is_null() {
            drop(Box::<StreamState<S>>::from_raw(data.cast()));
            BIO_set_data(bio, ptr::null_mut());
        }

        BIO_set_init(bio, 0);
        1
    }
}

use crate::ffi::{BIO_get_data, BIO_set_data, BIO_set_flags, BIO_set_init};

#[allow(bad_style)]
unsafe fn BIO_set_num(_bio: *mut ffi::BIO, _num: c_int) {}

#[allow(bad_style, clippy::upper_case_acronyms)]
struct BIO_METHOD(*mut ffi::BIO_METHOD);

impl BIO_METHOD {
    fn new<S: Read + Write>() -> BIO_METHOD {
        unsafe {
            let ptr = ffi::BIO_meth_new(ffi::BIO_TYPE_NONE, c"rust".as_ptr().cast());
            assert!(!ptr.is_null());
            let ret = BIO_METHOD(ptr);
            assert!(ffi::BIO_meth_set_write(ptr, Some(bwrite::<S>)) != 0);
            assert!(ffi::BIO_meth_set_read(ptr, Some(bread::<S>)) != 0);
            assert!(ffi::BIO_meth_set_puts(ptr, Some(bputs::<S>)) != 0);
            assert!(ffi::BIO_meth_set_ctrl(ptr, Some(ctrl::<S>)) != 0);
            assert!(ffi::BIO_meth_set_create(ptr, Some(create)) != 0);
            assert!(ffi::BIO_meth_set_destroy(ptr, Some(destroy::<S>)) != 0);
            ret
        }
    }

    fn get(&self) -> *mut ffi::BIO_METHOD {
        self.0
    }
}

impl Drop for BIO_METHOD {
    fn drop(&mut self) {
        unsafe {
            ffi::BIO_meth_free(self.0);
        }
    }
}
