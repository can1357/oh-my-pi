use super::server::Server;
use crate::ssl::{ErrorCode, HandshakeError, SslAlert, SslVerifyMode};
use crate::x509::X509StoreContext;
use crate::{hash::MessageDigest, ssl::SslVerifyError};
use hex;
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn untrusted_callback_override_bad() {
    let mut server = Server::builder();

    server.err_cb(|err| {
        let HandshakeError::Failure(handshake) = err else {
            panic!("expected failure error");
        };

        assert_eq!(
            handshake.error().to_string(),
            "[SSLV3_ALERT_CERTIFICATE_REVOKED]"
        );
    });

    let server = server.build();

    let mut client = server.client();
    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, |_| {
            Err(SslVerifyError::Invalid(SslAlert::CERTIFICATE_REVOKED))
        });

    client.connect_err();
}

#[test]
fn untrusted_callback_override_ok() {
    let server = Server::builder().build();
    let mut client = server.client();

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, |ssl| {
            assert!(ssl.peer_cert_chain().is_some());

            Ok(())
        });

    client.connect();
}

#[test]
fn untrusted_with_set_cert() {
    let mut server = Server::builder();

    server.should_error();

    let server = server.build();
    let mut client = server.client();

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, move |ssl| {
            let store = ssl.ssl_context().cert_store();
            let cert = ssl.peer_certificate().unwrap();
            let cert_chain = ssl.peer_cert_chain().unwrap();

            assert_eq!(store.objects_len(), 0);

            X509StoreContext::new()
                .unwrap()
                .init(store, &cert, cert_chain, |store_ctx| {
                    assert!(!store_ctx.verify_cert().unwrap());
                    assert!(store_ctx.verify_result().is_err());

                    Ok(())
                })
                .unwrap();

            Err(SslVerifyError::Invalid(SslAlert::CERTIFICATE_UNKNOWN))
        });

    client.connect_err();
}

#[test]
fn trusted_with_set_cert() {
    let server = Server::builder().build();
    let mut client = server.client_with_root_ca();

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, move |ssl| {
            let store = ssl.ssl_context().cert_store();
            let cert = ssl.peer_certificate().unwrap();
            let cert_chain = ssl.peer_cert_chain().unwrap();

            assert_eq!(store.objects_len(), 1);

            X509StoreContext::new()
                .unwrap()
                .init(store, &cert, cert_chain, |store_ctx| {
                    assert!(store_ctx.verify_cert().unwrap());
                    assert_eq!(store_ctx.verify_result(), Ok(()));

                    Ok(())
                })
                .unwrap();

            Ok(())
        });

    client.connect();
}

#[test]
fn trusted_callback_override_ok() {
    let server = Server::builder().build();
    let mut client = server.client_with_root_ca();

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, |ssl| {
            assert!(ssl.peer_certificate().is_some());

            Ok(())
        });

    client.connect();
}

#[test]
fn trusted_callback_override_bad() {
    let mut server = Server::builder();

    server.should_error();

    let server = server.build();
    let mut client = server.client_with_root_ca();

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, |_| {
            Err(SslVerifyError::Invalid(SslAlert::CERTIFICATE_UNKNOWN))
        });

    client.connect_err();
}

#[test]
fn callback() {
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);
    let server = Server::builder().build();
    let mut client = server.client();
    let expected = "59172d9313e84459bcff27f967e79e6e9217e584";

    client
        .ctx()
        .set_verify_callback(SslVerifyMode::PEER, |_, _| {
            panic!("verify callback should not be called");
        });

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, move |ssl| {
            CALLED_BACK.store(true, Ordering::SeqCst);

            let cert = ssl.peer_certificate().unwrap();
            let digest = cert.digest(MessageDigest::sha1()).unwrap();

            assert_eq!(hex::encode(digest), expected);

            Ok(())
        });

    client.connect();
    assert!(CALLED_BACK.load(Ordering::SeqCst));
}

#[test]
fn ssl_callback() {
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);
    let server = Server::builder().build();
    let mut client = server.client().build().builder();
    let expected = "59172d9313e84459bcff27f967e79e6e9217e584";

    client
        .ssl()
        .set_verify_callback(SslVerifyMode::PEER, |_, _| {
            panic!("verify callback should not be called");
        });

    client
        .ssl()
        .set_custom_verify_callback(SslVerifyMode::PEER, move |ssl| {
            CALLED_BACK.store(true, Ordering::SeqCst);

            let cert = ssl.peer_certificate().unwrap();
            let digest = cert.digest(MessageDigest::sha1()).unwrap();

            assert_eq!(hex::encode(digest), expected);

            Ok(())
        });

    client.connect();
    assert!(CALLED_BACK.load(Ordering::SeqCst));
}

#[test]
fn both_callback() {
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);
    let server = Server::builder().build();
    let mut client = server.client();

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, |_| {
            panic!("verify callback should not be called");
        });

    let mut client = client.build().builder();
    let expected = "59172d9313e84459bcff27f967e79e6e9217e584";

    client
        .ssl()
        .set_custom_verify_callback(SslVerifyMode::PEER, move |ssl| {
            CALLED_BACK.store(true, Ordering::SeqCst);

            let cert = ssl.peer_certificate().unwrap();
            let digest = cert.digest(MessageDigest::sha1()).unwrap();

            assert_eq!(hex::encode(digest), expected);

            Ok(())
        });

    client.connect();
    assert!(CALLED_BACK.load(Ordering::SeqCst));
}

#[test]
fn retry() {
    let mut server = Server::builder();

    server.err_cb(|err| {
        let HandshakeError::Failure(handshake) = err else {
            panic!("expected failure error");
        };

        assert_eq!(
            handshake.error().to_string(),
            "[SSLV3_ALERT_CERTIFICATE_REVOKED]"
        );
    });

    let server = server.build();
    let mut client = server.client();
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);

    client
        .ctx()
        .set_custom_verify_callback(SslVerifyMode::PEER, move |_| {
            if !CALLED_BACK.swap(true, Ordering::SeqCst) {
                return Err(SslVerifyError::Retry);
            }

            Err(SslVerifyError::Invalid(SslAlert::CERTIFICATE_REVOKED))
        });

    let HandshakeError::WouldBlock(handshake) = client.connect_err() else {
        panic!("should be WouldBlock");
    };

    assert!(CALLED_BACK.load(Ordering::SeqCst));
    assert!(handshake.error().would_block());
    assert_eq!(handshake.error().code(), ErrorCode::WANT_CERTIFICATE_VERIFY);
    handshake.handshake().unwrap_err();
}
