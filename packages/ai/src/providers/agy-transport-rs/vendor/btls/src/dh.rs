use crate::error::ErrorStack;
use crate::ffi;
use foreign_types::{ForeignType, ForeignTypeRef};
use openssl_macros::corresponds;
use std::mem;
use std::ptr;

use crate::bn::BigNum;
use crate::pkey::{HasParams, Params};
use crate::{cvt, cvt_p};

generic_foreign_type_and_impl_send_sync! {
    type CType = ffi::DH;
    fn drop = ffi::DH_free;

    pub struct Dh<T>;

    pub struct DhRef<T>;
}

impl<T> DhRef<T>
where
    T: HasParams,
{
    to_pem! {
        /// Serializes the parameters into a PEM-encoded PKCS#3 DHparameter structure.
        ///
        /// The output will have a header of `-----BEGIN DH PARAMETERS-----`.
        #[corresponds(PEM_write_bio_DHparams)]
        params_to_pem,
        ffi::PEM_write_bio_DHparams
    }

    to_der! {
        /// Serializes the parameters into a DER-encoded PKCS#3 `DHparameter` structure.
        #[corresponds(i2d_DHparams)]
        params_to_der,
        ffi::i2d_DHparams
    }
}

impl Dh<Params> {
    pub fn from_params(p: BigNum, g: BigNum, q: BigNum) -> Result<Dh<Params>, ErrorStack> {
        unsafe {
            let dh = Dh::from_ptr(cvt_p(ffi::DH_new())?);
            cvt(DH_set0_pqg(dh.0, p.as_ptr(), q.as_ptr(), g.as_ptr()))?;
            mem::forget((p, g, q));
            Ok(dh)
        }
    }

    from_pem! {
        /// Deserializes a PEM-encoded PKCS#3 DHpararameters structure.
        ///
        /// The input should have a header of `-----BEGIN DH PARAMETERS-----`.
        #[corresponds(PEM_read_bio_DHparams)]
        params_from_pem,
        Dh<Params>,
        ffi::PEM_read_bio_DHparams
    }

    from_der! {
        /// Deserializes a DER-encoded PKCS#3 DHparameters structure.
        #[corresponds(d2i_DHparams)]
        params_from_der,
        Dh<Params>,
        ffi::d2i_DHparams,
        ::libc::c_long
    }
}

use crate::ffi::DH_set0_pqg;

#[cfg(test)]
mod tests {
    use crate::bn::BigNum;
    use crate::dh::Dh;
    use crate::ssl::{SslContext, SslMethod};

    #[test]
    fn test_dh() {
        let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
        let p = BigNum::from_hex_str(
            "87A8E61DB4B6663CFFBBD19C651959998CEEF608660DD0F25D2CEED4435E3B00E00DF8F1D61957D4FAF7DF\
             4561B2AA3016C3D91134096FAA3BF4296D830E9A7C209E0C6497517ABD5A8A9D306BCF67ED91F9E6725B47\
             58C022E0B1EF4275BF7B6C5BFC11D45F9088B941F54EB1E59BB8BC39A0BF12307F5C4FDB70C581B23F76B6\
             3ACAE1CAA6B7902D52526735488A0EF13C6D9A51BFA4AB3AD8347796524D8EF6A167B5A41825D967E144E5\
             140564251CCACB83E6B486F6B3CA3F7971506026C0B857F689962856DED4010ABD0BE621C3A3960A54E710\
             C375F26375D7014103A4B54330C198AF126116D2276E11715F693877FAD7EF09CADB094AE91E1A1597",
        ).unwrap();
        let g = BigNum::from_hex_str(
            "3FB32C9B73134D0B2E77506660EDBD484CA7B18F21EF205407F4793A1A0BA12510DBC15077BE463FFF4FED\
             4AAC0BB555BE3A6C1B0C6B47B1BC3773BF7E8C6F62901228F8C28CBB18A55AE31341000A650196F931C77A\
             57F2DDF463E5E9EC144B777DE62AAAB8A8628AC376D282D6ED3864E67982428EBC831D14348F6F2F9193B5\
             045AF2767164E1DFC967C1FB3F2E55A4BD1BFFE83B9C80D052B985D182EA0ADB2A3B7313D3FE14C8484B1E\
             052588B9B7D2BBD2DF016199ECD06E1557CD0915B3353BBB64E0EC377FD028370DF92B52C7891428CDC67E\
             B6184B523D1DB246C32F63078490F00EF8D647D148D47954515E2327CFEF98C582664B4C0F6CC41659",
        ).unwrap();
        let q = BigNum::from_hex_str(
            "8CF83642A709A097B447997640129DA299B1A47D1EB3750BA308B0FE64F5FBD3",
        )
        .unwrap();
        let dh = Dh::from_params(p, g, q).unwrap();
        ctx.set_tmp_dh(&dh).unwrap();
    }

    #[test]
    fn test_dh_from_pem() {
        let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
        let params = include_bytes!("../test/dhparams.pem");
        let dh = Dh::params_from_pem(params).unwrap();
        ctx.set_tmp_dh(&dh).unwrap();
    }

    #[test]
    fn test_dh_from_der() {
        let params = include_bytes!("../test/dhparams.pem");
        let dh = Dh::params_from_pem(params).unwrap();
        let der = dh.params_to_der().unwrap();
        Dh::params_from_der(&der).unwrap();
    }
}
