use crate::hash::MessageDigest;
use crate::ssl::test::Server;
use crate::ssl::SslVerifyMode;

#[test]
fn error_when_trusted_but_callback_returns_false() {
    let mut server = Server::builder();
    server.should_error();
    let server = server.build();
    let mut client = server.client_with_root_ca();
    client.ctx().set_verify(SslVerifyMode::PEER);
    client.ctx().set_cert_verify_callback(|x509| {
        // The cert is OK
        assert!(x509.verify_cert().unwrap());
        assert!(x509.current_cert().is_some());
        assert!(x509.verify_result().is_ok());
        // But we return false
        false
    });

    client.connect_err();
}

#[test]
fn no_error_when_untrusted_but_callback_returns_true() {
    let server = Server::builder().build();
    let mut client = server.client();
    client.ctx().set_verify(SslVerifyMode::PEER);
    client.ctx().set_cert_verify_callback(|x509| {
        // The cert is not OK
        assert!(!x509.verify_cert().unwrap());
        assert!(x509.current_cert().is_some());
        assert!(x509.verify_result().is_err());
        // But we return true
        true
    });

    client.connect();
}

#[test]
fn no_error_when_trusted_and_callback_returns_true() {
    let server = Server::builder().build();
    let mut client = server.client_with_root_ca();
    client.ctx().set_verify(SslVerifyMode::PEER);
    client.ctx().set_cert_verify_callback(|x509| {
        // The cert is OK
        assert!(x509.verify_cert().unwrap());
        assert!(x509.current_cert().is_some());
        assert!(x509.verify_result().is_ok());
        // And we return true
        true
    });
    client.connect();
}

#[test]
fn callback_receives_correct_certificate() {
    // Server sends the full chain (leaf + root)...
    let server = Server::builder_full_chain().build();
    // but client doesn't load the root as trusted.
    // So we expect an error.
    let mut client = server.client();
    let leaf_sha1 = "59172d9313e84459bcff27f967e79e6e9217e584";
    let root_sha1 = "c0cbdf7cdd03c9773e5468e1f6d2da7d5cbb1875";
    client.ctx().set_verify(SslVerifyMode::PEER);
    client.ctx().set_cert_verify_callback(move |x509| {
        assert!(!x509.verify_cert().unwrap());
        // This is set to the root, since that's the problematic cert.
        assert!(x509.current_cert().is_some());
        // This is set to the leaf, since that's the cert we're verifying.
        assert!(x509.cert().is_some());
        assert!(x509.verify_result().is_err());

        let root = x509
            .current_cert()
            .unwrap()
            .digest(MessageDigest::sha1())
            .unwrap();
        assert_eq!(hex::encode(root), root_sha1);

        let leaf = x509.cert().unwrap().digest(MessageDigest::sha1()).unwrap();
        assert_eq!(hex::encode(leaf), leaf_sha1);

        // Test that `untrusted` is set to the original chain.
        assert_eq!(x509.untrusted().unwrap().len(), 2);
        let leaf = x509
            .untrusted()
            .unwrap()
            .get(0)
            .unwrap()
            .digest(MessageDigest::sha1())
            .unwrap();
        assert_eq!(hex::encode(leaf), leaf_sha1);
        let root = x509
            .untrusted()
            .unwrap()
            .get(1)
            .unwrap()
            .digest(MessageDigest::sha1())
            .unwrap();
        assert_eq!(hex::encode(root), root_sha1);
        true
    });

    client.connect();
}

#[test]
fn callback_receives_correct_chain() {
    let server = Server::builder().build();
    let mut client = server.client_with_root_ca();
    let leaf_sha1 = "59172d9313e84459bcff27f967e79e6e9217e584";
    let root_sha1 = "c0cbdf7cdd03c9773e5468e1f6d2da7d5cbb1875";
    client.ctx().set_verify(SslVerifyMode::PEER);
    client.ctx().set_cert_verify_callback(move |x509| {
        assert!(x509.verify_cert().unwrap());
        assert!(x509.current_cert().is_some());
        assert!(x509.verify_result().is_ok());
        let chain = x509.chain().unwrap();
        assert!(chain.len() == 2);
        let leaf_cert = chain.get(0).unwrap();
        let leaf_digest = leaf_cert.digest(MessageDigest::sha1()).unwrap();
        assert_eq!(hex::encode(leaf_digest), leaf_sha1);
        let root_cert = chain.get(1).unwrap();
        let root_digest = root_cert.digest(MessageDigest::sha1()).unwrap();
        assert_eq!(hex::encode(root_digest), root_sha1);
        true
    });

    client.connect();
}
