use super::server::{Builder, Server};
use super::KEY;
use crate::hash::MessageDigest;
use crate::pkey::PKey;
use crate::rsa::Padding;
use crate::sign::{RsaPssSaltlen, Signer};
use crate::ssl::{
    ErrorCode, HandshakeError, PrivateKeyMethod, PrivateKeyMethodError, SslRef,
    SslSignatureAlgorithm,
};
use std::io::Write;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

#[allow(clippy::type_complexity)]
pub(super) struct Method {
    sign: Box<
        dyn Fn(
                &mut SslRef,
                &[u8],
                SslSignatureAlgorithm,
                &mut [u8],
            ) -> Result<usize, PrivateKeyMethodError>
            + Send
            + Sync
            + 'static,
    >,
    decrypt: Box<
        dyn Fn(&mut SslRef, &[u8], &mut [u8]) -> Result<usize, PrivateKeyMethodError>
            + Send
            + Sync
            + 'static,
    >,
    complete: Box<
        dyn Fn(&mut SslRef, &mut [u8]) -> Result<usize, PrivateKeyMethodError>
            + Send
            + Sync
            + 'static,
    >,
}

impl Method {
    pub(super) fn new() -> Self {
        Self {
            sign: Box::new(|_, _, _, _| unreachable!("called sign")),
            decrypt: Box::new(|_, _, _| unreachable!("called decrypt")),
            complete: Box::new(|_, _| unreachable!("called complete")),
        }
    }

    pub(super) fn sign(
        mut self,
        sign: impl Fn(
                &mut SslRef,
                &[u8],
                SslSignatureAlgorithm,
                &mut [u8],
            ) -> Result<usize, PrivateKeyMethodError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.sign = Box::new(sign);

        self
    }

    #[allow(dead_code)]
    pub(super) fn decrypt(
        mut self,
        decrypt: impl Fn(&mut SslRef, &[u8], &mut [u8]) -> Result<usize, PrivateKeyMethodError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.decrypt = Box::new(decrypt);

        self
    }

    pub(super) fn complete(
        mut self,
        complete: impl Fn(&mut SslRef, &mut [u8]) -> Result<usize, PrivateKeyMethodError>
            + Send
            + Sync
            + 'static,
    ) -> Self {
        self.complete = Box::new(complete);

        self
    }
}

impl PrivateKeyMethod for Method {
    fn sign(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        signature_algorithm: SslSignatureAlgorithm,
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError> {
        (self.sign)(ssl, input, signature_algorithm, output)
    }

    fn decrypt(
        &self,
        ssl: &mut SslRef,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError> {
        (self.decrypt)(ssl, input, output)
    }

    fn complete(
        &self,
        ssl: &mut SslRef,
        output: &mut [u8],
    ) -> Result<usize, PrivateKeyMethodError> {
        (self.complete)(ssl, output)
    }
}

fn builder_with_private_key_method(method: Method) -> Builder {
    let mut builder = Server::builder();

    builder.ctx().set_private_key_method(method);

    builder
}

#[test]
fn test_sign_failure() {
    let called_sign = Arc::new(AtomicBool::new(false));
    let called_sign_clone = called_sign.clone();

    let mut builder = builder_with_private_key_method(Method::new().sign(move |_, _, _, _| {
        called_sign_clone.store(true, Ordering::SeqCst);

        Err(PrivateKeyMethodError::FAILURE)
    }));

    builder.err_cb(|error| {
        let HandshakeError::Failure(mid_handshake) = error else {
            panic!("should be Failure");
        };

        assert_eq!(mid_handshake.error().code(), ErrorCode::SSL);
    });

    let server = builder.build();
    let client = server.client_with_root_ca();

    client.connect_err();

    assert!(called_sign.load(Ordering::SeqCst));
}

#[test]
fn test_sign_retry_complete_failure() {
    let called_complete = Arc::new(AtomicUsize::new(0));
    let called_complete_clone = called_complete.clone();

    let mut builder = builder_with_private_key_method(
        Method::new()
            .sign(|_, _, _, _| Err(PrivateKeyMethodError::RETRY))
            .complete(move |_, _| {
                let old = called_complete_clone.fetch_add(1, Ordering::SeqCst);

                Err(if old == 0 {
                    PrivateKeyMethodError::RETRY
                } else {
                    PrivateKeyMethodError::FAILURE
                })
            }),
    );

    builder.err_cb(|error| {
        let HandshakeError::WouldBlock(mid_handshake) = error else {
            panic!("should be WouldBlock");
        };

        assert!(mid_handshake.error().would_block());
        assert_eq!(
            mid_handshake.error().code(),
            ErrorCode::WANT_PRIVATE_KEY_OPERATION
        );

        let HandshakeError::WouldBlock(mid_handshake) = mid_handshake.handshake().unwrap_err()
        else {
            panic!("should be WouldBlock");
        };

        assert_eq!(
            mid_handshake.error().code(),
            ErrorCode::WANT_PRIVATE_KEY_OPERATION
        );

        let HandshakeError::Failure(mid_handshake) = mid_handshake.handshake().unwrap_err() else {
            panic!("should be Failure");
        };

        assert_eq!(mid_handshake.error().code(), ErrorCode::SSL);
    });

    let server = builder.build();
    let client = server.client_with_root_ca();

    client.connect_err();

    assert_eq!(called_complete.load(Ordering::SeqCst), 2);
}

#[test]
fn test_sign_ok() {
    let server = builder_with_private_key_method(Method::new().sign(
        |_, input, signature_algorithm, output| {
            assert_eq!(
                signature_algorithm,
                SslSignatureAlgorithm::RSA_PSS_RSAE_SHA256,
            );

            Ok(sign_with_default_config(input, output))
        },
    ))
    .build();

    let client = server.client_with_root_ca();

    client.connect();
}

#[test]
fn test_sign_retry_complete_ok() {
    let input_cell = Arc::new(OnceLock::new());
    let input_cell_clone = input_cell.clone();

    let mut builder = builder_with_private_key_method(
        Method::new()
            .sign(move |_, input, _, _| {
                input_cell.set(input.to_owned()).unwrap();

                Err(PrivateKeyMethodError::RETRY)
            })
            .complete(move |_, output| {
                let input = input_cell_clone.get().unwrap();

                Ok(sign_with_default_config(input, output))
            }),
    );

    builder.err_cb(|error| {
        let HandshakeError::WouldBlock(mid_handshake) = error else {
            panic!("should be WouldBlock");
        };

        let mut socket = mid_handshake.handshake().unwrap();

        socket.write_all(&[0]).unwrap();
    });

    let server = builder.build();
    let client = server.client_with_root_ca();

    client.connect();
}

fn sign_with_default_config(input: &[u8], output: &mut [u8]) -> usize {
    let pkey = PKey::private_key_from_pem(KEY).unwrap();
    let mut signer = Signer::new(MessageDigest::sha256(), &pkey).unwrap();

    signer.set_rsa_padding(Padding::PKCS1_PSS).unwrap();
    signer
        .set_rsa_pss_saltlen(RsaPssSaltlen::DIGEST_LENGTH)
        .unwrap();

    signer.update(input).unwrap();

    signer.sign(output).unwrap()
}
