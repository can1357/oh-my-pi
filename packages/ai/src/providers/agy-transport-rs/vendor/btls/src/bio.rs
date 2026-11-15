use std::marker::PhantomData;
use std::ptr;
use std::slice;

use crate::cvt_p;
use crate::error::ErrorStack;
use crate::ffi;
use crate::ffi::BIO_new_mem_buf;
use crate::try_int;

pub struct MemBioSlice<'a>(*mut ffi::BIO, PhantomData<&'a [u8]>);

impl Drop for MemBioSlice<'_> {
    fn drop(&mut self) {
        unsafe {
            ffi::BIO_free_all(self.0);
        }
    }
}

impl<'a> MemBioSlice<'a> {
    pub fn new(buf: &'a [u8]) -> Result<MemBioSlice<'a>, ErrorStack> {
        ffi::init();

        let bio = unsafe { cvt_p(BIO_new_mem_buf(buf.as_ptr().cast(), try_int(buf.len())?))? };

        Ok(MemBioSlice(bio, PhantomData))
    }

    pub fn as_ptr(&self) -> *mut ffi::BIO {
        self.0
    }
}

pub struct MemBio(*mut ffi::BIO);

impl Drop for MemBio {
    fn drop(&mut self) {
        unsafe {
            ffi::BIO_free_all(self.0);
        }
    }
}

impl MemBio {
    pub fn new() -> Result<MemBio, ErrorStack> {
        ffi::init();

        let bio = unsafe { cvt_p(ffi::BIO_new(ffi::BIO_s_mem()))? };
        Ok(MemBio(bio))
    }

    pub fn as_ptr(&self) -> *mut ffi::BIO {
        self.0
    }

    pub fn get_buf(&self) -> &[u8] {
        unsafe {
            let mut ptr = ptr::null_mut();
            let len = ffi::BIO_get_mem_data(self.0, &mut ptr);
            if ptr.is_null() || len < 0 {
                return &[];
            }
            slice::from_raw_parts(ptr.cast_const().cast(), len as usize)
        }
    }
}
