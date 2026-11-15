use super::server::Server;
use crate::hash::MessageDigest;
use crate::ssl::SslVerifyMode;
use crate::x509::store::X509StoreBuilder;
use crate::x509::X509;
use hex;
use std::sync::atomic::{AtomicBool, Ordering};

#[test]
fn untrusted() {
    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let mut client = server.client();
    client.ctx().set_verify(SslVerifyMode::PEER);

    client.connect_err();
}

#[test]
fn trusted() {
    let server = Server::builder().build();
    let client = server.client_with_root_ca();

    client.connect();
}

#[test]
fn trusted_with_set_cert() {
    let server = Server::builder().build();

    let mut store = X509StoreBuilder::new().unwrap();
    let x509 = X509::from_pem(super::ROOT_CERT).unwrap();
    store.add_cert(&x509).unwrap();

    let mut client = server.client();
    client.ctx().set_verify(SslVerifyMode::PEER);
    client.ctx().set_verify_cert_store(store.build()).unwrap();

    client.connect();
}

#[test]
fn untrusted_callback_override_ok() {
    let server = Server::builder().build();

    let mut client = server.client();
    client
        .ctx()
        .set_verify_callback(SslVerifyMode::PEER, |_, x509| {
            assert!(x509.current_cert().is_some());
            assert!(x509.verify_result().is_err());

            true
        });

    client.connect();
}

#[test]
fn untrusted_callback_override_bad() {
    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let mut client = server.client();
    client
        .ctx()
        .set_verify_callback(SslVerifyMode::PEER, |_, _| false);

    client.connect_err();
}

#[test]
fn trusted_callback_override_ok() {
    let server = Server::builder().build();
    let mut client = server.client_with_root_ca();

    client
        .ctx()
        .set_verify_callback(SslVerifyMode::PEER, |_, x509| {
            assert!(x509.current_cert().is_some());
            assert_eq!(x509.verify_result(), Ok(()));

            true
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
        .set_verify_callback(SslVerifyMode::PEER, |_, _| false);

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
        .set_verify_callback(SslVerifyMode::PEER, move |_, x509| {
            CALLED_BACK.store(true, Ordering::SeqCst);
            let cert = x509.current_cert().unwrap();
            let digest = cert.digest(MessageDigest::sha1()).unwrap();
            assert_eq!(hex::encode(digest), expected);
            true
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
        .set_verify_callback(SslVerifyMode::PEER, move |_, x509| {
            CALLED_BACK.store(true, Ordering::SeqCst);
            let cert = x509.current_cert().unwrap();
            let digest = cert.digest(MessageDigest::sha1()).unwrap();
            assert_eq!(hex::encode(digest), expected);
            true
        });

    client.connect();
    assert!(CALLED_BACK.load(Ordering::SeqCst));
}
