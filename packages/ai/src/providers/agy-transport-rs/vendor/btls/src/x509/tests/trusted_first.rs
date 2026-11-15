//! See https://github.com/google/boringssl/blob/cc696073cffe7978d489297fbdeac4c0030384aa/crypto/x509/x509_test.cc#L3977-L3980

use crate::stack::Stack;
use crate::x509::store::X509StoreBuilder;
use crate::x509::verify::{X509VerifyFlags, X509VerifyParamRef};
use crate::x509::{X509Ref, X509StoreContext, X509VerifyError, X509VerifyResult, X509};

#[test]
fn test_verify_cert() {
    let root2 = X509::from_pem(include_bytes!("../../../test/root-ca-2.pem")).unwrap();
    let root1 = X509::from_pem(include_bytes!("../../../test/root-ca.pem")).unwrap();
    let root1_cross = X509::from_pem(include_bytes!("../../../test/root-ca-cross.pem")).unwrap();
    let intermediate = X509::from_pem(include_bytes!("../../../test/intermediate-ca.pem")).unwrap();
    let leaf = X509::from_pem(include_bytes!("../../../test/cert-with-intermediate.pem")).unwrap();

    assert_eq!(Ok(()), verify(&leaf, &[&root1], &[&intermediate], |_| {}));

    #[cfg(not(feature = "legacy-compat-deprecated"))]
    assert_eq!(
        Ok(()),
        verify(
            &leaf,
            &[&root1, &root2],
            &[&intermediate, &root1_cross],
            |_| {}
        )
    );

    #[cfg(feature = "legacy-compat-deprecated")]
    assert_eq!(
        Err(X509VerifyError::CERT_HAS_EXPIRED),
        verify(
            &leaf,
            &[&root1, &root2],
            &[&intermediate, &root1_cross],
            |_| {}
        )
    );

    assert_eq!(
        Ok(()),
        verify(
            &leaf,
            &[&root1, &root2],
            &[&intermediate, &root1_cross],
            |param| param.set_flags(X509VerifyFlags::TRUSTED_FIRST),
        )
    );

    assert_eq!(
        Err(X509VerifyError::CERT_HAS_EXPIRED),
        verify(
            &leaf,
            &[&root1, &root2],
            &[&intermediate, &root1_cross],
            |param| param.clear_flags(X509VerifyFlags::TRUSTED_FIRST),
        )
    );

    assert_eq!(
        Ok(()),
        verify(&leaf, &[&root1], &[&intermediate, &root1_cross], |param| {
            param.clear_flags(X509VerifyFlags::TRUSTED_FIRST);
        })
    );
}

fn verify(
    cert: &X509Ref,
    trusted: &[&X509Ref],
    untrusted: &[&X509Ref],
    configure: impl FnOnce(&mut X509VerifyParamRef),
) -> X509VerifyResult {
    let trusted = {
        let mut builder = X509StoreBuilder::new().unwrap();

        for cert in trusted {
            builder.add_cert(cert).unwrap();
        }

        builder.build()
    };

    let untrusted = {
        let mut stack = Stack::new().unwrap();

        for cert in untrusted {
            stack.push((**cert).to_owned()).unwrap();
        }

        stack
    };

    let mut store_ctx = X509StoreContext::new().unwrap();

    store_ctx
        .init(&trusted, cert, &untrusted, |ctx| {
            configure(ctx.verify_param_mut());
            ctx.verify_cert().unwrap();

            Ok(ctx.verify_result())
        })
        .expect("failed to obtain X509VerifyResult")
}
