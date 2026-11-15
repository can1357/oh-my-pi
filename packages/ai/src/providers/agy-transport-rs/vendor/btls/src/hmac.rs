use crate::cvt;
use crate::error::ErrorStack;
use crate::foreign_types::ForeignTypeRef;
use crate::hash::MessageDigest;
use openssl_macros::corresponds;

foreign_type_and_impl_send_sync! {
    type CType = ffi::HMAC_CTX;
    fn drop = ffi::HMAC_CTX_free;

    pub struct HmacCtx;
}

impl HmacCtxRef {
    /// Configures HmacCtx to use `md` as the hash function and `key` as the key.
    ///
    #[corresponds(HMAC_Init_ex)]
    pub fn init(&mut self, key: &[u8], md: &MessageDigest) -> Result<(), ErrorStack> {
        ffi::init();

        unsafe {
            cvt(ffi::HMAC_Init_ex(
                self.as_ptr(),
                key.as_ptr().cast(),
                key.len(),
                md.as_ptr(),
                // ENGINE api is deprecated
                core::ptr::null_mut(),
            ))
        }
    }
}

/// Provides an init-update-finalize API for HMAC.
pub struct Hmac(*mut ffi::HMAC_CTX);

impl Hmac {
    /// Creates a new HMAC object with the given key and hash algorithm.
    pub fn init(key: &[u8], md: &MessageDigest) -> Result<Hmac, ErrorStack> {
        ffi::init();

        let ctx = unsafe {
            let ctx = ffi::HMAC_CTX_new();
            cvt(ffi::HMAC_Init_ex(
                ctx,
                key.as_ptr().cast(),
                key.len(),
                md.as_ptr(),
                // ENGINE api is deprecated
                core::ptr::null_mut(),
            ))?;
            ctx
        };

        Ok(Hmac(ctx))
    }

    /// Updates the HMAC input.
    pub fn update(&mut self, data: &[u8]) -> Result<(), ErrorStack> {
        unsafe { cvt(ffi::HMAC_Update(self.0, data.as_ptr().cast(), data.len())) }
    }

    /// Finalizes the HMAC and returns the output.
    pub fn finalize(self) -> Result<Vec<u8>, ErrorStack> {
        let out_len = unsafe { ffi::HMAC_size(self.0) };
        let mut out = vec![0; out_len];
        unsafe {
            cvt(ffi::HMAC_Final(
                self.0,
                out.as_mut_ptr().cast(),
                // ENGINE api is deprecated
                core::ptr::null_mut(),
            ))?;
        }
        Ok(out)
    }
}

impl Drop for Hmac {
    fn drop(&mut self) {
        unsafe { ffi::HMAC_CTX_free(self.0) }
    }
}

#[cfg(test)]
mod tests {
    use crate::hash;

    use super::*;

    fn test<const N: usize>(md: MessageDigest) {
        assert_eq!(N, md.size());
        let key = vec![0; N];
        let message_parts = [
            b"hello".to_vec(),
            b"world!".to_vec(),
            b"".to_vec(),
            vec![0; 23],
            b"fella guy".to_vec(),
        ];
        let message = message_parts.concat();

        let mut hmac = Hmac::init(&key, &md).unwrap();
        for part in &message_parts {
            hmac.update(part).unwrap();
        }
        let res = hmac.finalize().unwrap();
        assert_eq!(res, hash::hmac::<N>(md, &key, &message).unwrap());
    }

    #[test]
    fn test_sha1() {
        test::<20>(MessageDigest::sha1());
    }

    #[test]
    fn test_sha256() {
        test::<32>(MessageDigest::sha256());
    }

    #[test]
    fn test_sha384() {
        test::<48>(MessageDigest::sha384());
    }

    #[test]
    fn test_sha512() {
        test::<64>(MessageDigest::sha512());
    }
}
