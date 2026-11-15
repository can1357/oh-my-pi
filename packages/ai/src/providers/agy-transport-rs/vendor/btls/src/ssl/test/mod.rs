use foreign_types::{ForeignType, ForeignTypeRef};
use std::io;
use std::io::prelude::*;
use std::mem;
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;

use crate::error::ErrorStack;
use crate::hash::MessageDigest;
use crate::pkey::PKey;
use crate::srtp::SrtpProfileId;
use crate::ssl::test::server::Server;
use crate::ssl::{
    self, ExtensionType, ShutdownResult, ShutdownState, Ssl, SslAcceptor, SslAcceptorBuilder,
    SslConnector, SslContext, SslFiletype, SslMethod, SslOptions, SslStream, SslVerifyMode,
};
use crate::ssl::{HandshakeError, SslVersion};
use crate::x509::store::X509StoreBuilder;
use crate::x509::verify::X509CheckFlags;
use crate::x509::{X509Name, X509};

use super::CompliancePolicy;

mod cert_compressor;
mod cert_verify;
mod custom_verify;
mod ech;
mod private_key_method;
mod server;
mod session;
mod session_resumption;
mod verify;

static ROOT_CERT: &[u8] = include_bytes!("../../../test/root-ca.pem");
static CERT: &[u8] = include_bytes!("../../../test/cert.pem");
static KEY: &[u8] = include_bytes!("../../../test/key.pem");

fn certificate_with_san() -> X509 {
    let original = X509::from_pem(CERT).unwrap();
    let key = PKey::private_key_from_pem(KEY).unwrap();
    let ca_key = PKey::private_key_from_pem(include_bytes!("../../../test/root-ca.key")).unwrap();
    let mut builder = X509::builder().unwrap();
    builder.set_version(2).unwrap();
    builder.set_serial_number(original.serial_number()).unwrap();
    builder.set_subject_name(original.subject_name()).unwrap();
    builder.set_issuer_name(original.issuer_name()).unwrap();
    builder.set_not_before(original.not_before()).unwrap();
    builder.set_not_after(original.not_after()).unwrap();
    builder.set_pubkey(&key).unwrap();
    let san = crate::x509::extension::SubjectAlternativeName::new()
        .dns("foobar.com")
        .build(&builder.x509v3_context(None, None))
        .unwrap();
    builder.append_extension(&san).unwrap();
    builder.sign(&ca_key, MessageDigest::sha256()).unwrap();
    builder.build()
}

#[test]
fn get_ctx_options() {
    let ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let _ = ctx.options();
}

#[test]
fn set_ctx_options() {
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let opts = ctx.set_options(SslOptions::NO_TICKET);
    assert!(opts.contains(SslOptions::NO_TICKET));
}

#[test]
fn clear_ctx_options() {
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_options(SslOptions::NO_TICKET);
    let opts = ctx.clear_options(SslOptions::NO_TICKET);
    assert!(!opts.contains(SslOptions::NO_TICKET));
}

#[test]
fn zero_length_buffers() {
    let server = Server::builder().build();

    let mut s = server.client().connect();
    assert_eq!(s.write(&[]).unwrap(), 0);
    assert_eq!(s.read(&mut []).unwrap(), 0);
}

#[test]
fn peer_certificate() {
    let server = Server::builder().build();

    let s = server.client().connect();
    let cert = s.ssl().peer_certificate().unwrap();
    let fingerprint = cert.digest(MessageDigest::sha1()).unwrap();
    assert_eq!(
        hex::encode(fingerprint),
        "59172d9313e84459bcff27f967e79e6e9217e584"
    );
}

#[test]
fn pending() {
    let mut server = Server::builder();
    server.io_cb(|mut s| s.write_all(&[0; 10]).unwrap());
    let server = server.build();

    let mut s = server.client().connect();
    s.read_exact(&mut [0]).unwrap();

    assert_eq!(s.ssl().pending(), 9);
    assert_eq!(s.read(&mut [0; 10]).unwrap(), 9);
}

#[test]
fn state() {
    let server = Server::builder().build();

    let s = server.client().connect();
    // NOTE: Boring returs a placeholder string for state_string
    assert_eq!(s.ssl().state_string(), "!!!!!!");
    assert_eq!(
        s.ssl().state_string_long(),
        "SSL negotiation finished successfully"
    );
}

/// Tests that when both the client as well as the server use SRTP and their
/// lists of supported protocols have an overlap -- with only ONE protocol
/// being valid for both.
#[test]
fn test_connect_with_srtp_ctx() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let guard = thread::spawn(move || {
        let stream = listener.accept().unwrap().0;
        let mut ctx = SslContext::builder(SslMethod::dtls()).unwrap();
        ctx.set_tlsext_use_srtp("SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32")
            .unwrap();
        ctx.set_certificate_file(Path::new("test/cert.pem"), SslFiletype::PEM)
            .unwrap();
        ctx.set_private_key_file(Path::new("test/key.pem"), SslFiletype::PEM)
            .unwrap();
        let mut ssl = Ssl::new(&ctx.build()).unwrap();
        ssl.set_mtu(1500).unwrap();
        let mut stream = ssl.accept(stream).unwrap();

        let mut buf = [0; 60];
        stream
            .ssl()
            .export_keying_material(&mut buf, "EXTRACTOR-dtls_srtp", None)
            .unwrap();

        stream.write_all(&[0]).unwrap();

        buf
    });

    let stream = TcpStream::connect(addr).unwrap();
    let mut ctx = SslContext::builder(SslMethod::dtls()).unwrap();
    ctx.set_tlsext_use_srtp("SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32")
        .unwrap();
    let mut ssl = Ssl::new(&ctx.build()).unwrap();
    ssl.set_mtu(1500).unwrap();
    let mut stream = ssl.connect(stream).unwrap();

    let mut buf = [1; 60];
    {
        let srtp_profile = stream.ssl().selected_srtp_profile().unwrap();
        assert_eq!("SRTP_AES128_CM_SHA1_80", srtp_profile.name());
        assert_eq!(SrtpProfileId::SRTP_AES128_CM_SHA1_80, srtp_profile.id());
    }
    stream
        .ssl()
        .export_keying_material(&mut buf, "EXTRACTOR-dtls_srtp", None)
        .expect("extract");

    stream.read_exact(&mut [0]).unwrap();

    let buf2 = guard.join().unwrap();

    assert_eq!(buf[..], buf2[..]);
}

/// Tests that when both the client as well as the server use SRTP and their
/// lists of supported protocols have an overlap -- with only ONE protocol
/// being valid for both.
#[test]
fn test_connect_with_srtp_ssl() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let guard = thread::spawn(move || {
        let stream = listener.accept().unwrap().0;
        let mut ctx = SslContext::builder(SslMethod::dtls()).unwrap();
        ctx.set_certificate_file(Path::new("test/cert.pem"), SslFiletype::PEM)
            .unwrap();
        ctx.set_private_key_file(Path::new("test/key.pem"), SslFiletype::PEM)
            .unwrap();
        let mut ssl = Ssl::new(&ctx.build()).unwrap();
        ssl.set_tlsext_use_srtp("SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32")
            .unwrap();
        let mut profilenames = String::new();
        for profile in ssl.srtp_profiles().unwrap() {
            if !profilenames.is_empty() {
                profilenames.push(':');
            }
            profilenames += profile.name();
        }
        assert_eq!(
            "SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32",
            profilenames
        );
        ssl.set_mtu(1500).unwrap();
        let mut stream = ssl.accept(stream).unwrap();

        let mut buf = [0; 60];
        stream
            .ssl()
            .export_keying_material(&mut buf, "EXTRACTOR-dtls_srtp", None)
            .unwrap();

        stream.write_all(&[0]).unwrap();

        buf
    });

    let stream = TcpStream::connect(addr).unwrap();
    let ctx = SslContext::builder(SslMethod::dtls()).unwrap();
    let mut ssl = Ssl::new(&ctx.build()).unwrap();
    ssl.set_tlsext_use_srtp("SRTP_AES128_CM_SHA1_80:SRTP_AES128_CM_SHA1_32")
        .unwrap();
    ssl.set_mtu(1500).unwrap();
    let mut stream = ssl.connect(stream).unwrap();

    let mut buf = [1; 60];
    {
        let srtp_profile = stream.ssl().selected_srtp_profile().unwrap();
        assert_eq!("SRTP_AES128_CM_SHA1_80", srtp_profile.name());
        assert_eq!(SrtpProfileId::SRTP_AES128_CM_SHA1_80, srtp_profile.id());
    }
    stream
        .ssl()
        .export_keying_material(&mut buf, "EXTRACTOR-dtls_srtp", None)
        .expect("extract");

    stream.read_exact(&mut [0]).unwrap();

    let buf2 = guard.join().unwrap();

    assert_eq!(buf[..], buf2[..]);
}

/// Tests that when the `SslStream` is created as a server stream, the protocols
/// are correctly advertised to the client.
#[test]
fn test_alpn_server_advertise_multiple() {
    let mut server = Server::builder();
    server.ctx().set_alpn_select_callback(|_, client| {
        ssl::select_next_proto(b"\x08http/1.1\x08spdy/3.1", client).ok_or(ssl::AlpnError::NOACK)
    });
    let server = server.build();

    let mut client = server.client();
    client.ctx().set_alpn_protos(b"\x08spdy/3.1").unwrap();
    let s = client.connect();
    assert_eq!(s.ssl().selected_alpn_protocol(), Some(&b"spdy/3.1"[..]));
}

#[test]
fn test_alpn_server_select_none_fatal() {
    let mut server = Server::builder();
    server.ctx().set_alpn_select_callback(|_, client| {
        ssl::select_next_proto(b"\x08http/1.1\x08spdy/3.1", client)
            .ok_or(ssl::AlpnError::ALERT_FATAL)
    });
    server.should_error();
    let server = server.build();

    let mut client = server.client();
    client.ctx().set_alpn_protos(b"\x06http/2").unwrap();
    client.connect_err();
}

#[test]
fn test_alpn_server_select_none() {
    let mut server = Server::builder();
    server.ctx().set_alpn_select_callback(|_, client| {
        ssl::select_next_proto(b"\x08http/1.1\x08spdy/3.1", client).ok_or(ssl::AlpnError::NOACK)
    });
    let server = server.build();

    let mut client = server.client();
    client.ctx().set_alpn_protos(b"\x06http/2").unwrap();
    let s = client.connect();
    assert_eq!(None, s.ssl().selected_alpn_protocol());
}

#[test]
fn test_empty_alpn() {
    assert_eq!(ssl::select_next_proto(b"", b""), None);
    assert_eq!(ssl::select_next_proto(b"", b"\x08http/1.1"), None);
    assert_eq!(ssl::select_next_proto(b"\x08http/1.1", b""), None);
}

#[test]
fn test_alpn_server_unilateral() {
    let server = Server::builder().build();

    let mut client = server.client();
    client.ctx().set_alpn_protos(b"\x06http/2").unwrap();
    let s = client.connect();
    assert_eq!(None, s.ssl().selected_alpn_protocol());
}

#[test]
fn test_select_cert_ok() {
    let mut server = Server::builder();
    server
        .ctx()
        .set_select_certificate_callback(|_client_hello| Ok(()));
    let server = server.build();

    let client = server.client();
    client.connect();
}

#[test]
fn test_mutable_store() {
    #![allow(deprecated)]

    let cert = include_bytes!("../../../test/cert.pem");
    let cert = X509::from_pem(cert).unwrap();
    let cert2 = include_bytes!("../../../test/root-ca.pem");
    let cert2 = X509::from_pem(cert2).unwrap();

    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.cert_store_mut().add_cert(cert.clone()).unwrap();
    assert_eq!(1, ctx.cert_store().objects_len());

    ctx.set_cert_store_builder(X509StoreBuilder::new().unwrap());
    assert_eq!(0, ctx.cert_store().objects_len());

    ctx.cert_store_mut().add_cert(cert.clone()).unwrap();
    assert_eq!(1, ctx.cert_store().objects_len());

    let mut new_store = X509StoreBuilder::new().unwrap();
    new_store.add_cert(&cert).unwrap();
    new_store.add_cert(&cert2).unwrap();
    let new_store = new_store.build();
    assert_eq!(2, new_store.objects_len());

    ctx.set_cert_store_ref(&new_store);
    assert_eq!(2, ctx.cert_store().objects_len());
    assert!(std::ptr::eq(new_store.as_ptr(), ctx.cert_store().as_ptr()));

    let ctx = ctx.build();
    assert!(std::ptr::eq(new_store.as_ptr(), ctx.cert_store().as_ptr()));

    drop(new_store);
    assert_eq!(2, ctx.cert_store().objects_len());
}

#[test]
#[should_panic(expected = "mutated")]
fn shared_store_must_not_be_mutated() {
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();

    let shared = X509StoreBuilder::new().unwrap().build();
    ctx.set_cert_store_ref(&shared);
    ctx.cert_store_mut();
}

#[test]
fn test_select_cert_error() {
    let mut server = Server::builder();
    server.should_error();
    server
        .ctx()
        .set_select_certificate_callback(|_client_hello| Err(ssl::SelectCertError::ERROR));
    let server = server.build();

    let client = server.client();
    client.connect_err();
}

#[test]
fn test_select_cert_unknown_extension() {
    let mut server = Server::builder();
    let unknown_extension = std::sync::Arc::new(std::sync::Mutex::new(Some(vec![])));

    server.ctx().set_select_certificate_callback({
        let unknown = unknown_extension.clone();
        move |client_hello| {
            let ext = client_hello
                .get_extension(ExtensionType::SERVER_NAME)
                .map(ToOwned::to_owned);
            assert!(ext.is_none());
            *unknown.lock().unwrap() = ext;
            Ok(())
        }
    });

    let server = server.build();
    let client = server.client();

    client.connect();
    assert_eq!(unknown_extension.lock().unwrap().as_deref(), None);
}

#[test]
fn test_select_cert_alpn_extension() {
    let mut server = Server::builder();
    let alpn_extension = std::sync::Arc::new(std::sync::Mutex::new(None));
    server.ctx().set_select_certificate_callback({
        let alpn = alpn_extension.clone();
        move |client_hello| {
            *alpn.lock().unwrap() = Some(
                client_hello
                    .get_extension(ExtensionType::APPLICATION_LAYER_PROTOCOL_NEGOTIATION)
                    .unwrap()
                    .to_owned(),
            );
            Ok(())
        }
    });
    let server = server.build();

    let mut client = server.client();
    client.ctx().set_alpn_protos(b"\x06http/2").unwrap();
    client.connect();
    assert_eq!(
        alpn_extension.lock().unwrap().as_deref(),
        Some(&b"\x00\x07\x06http/2"[..]),
    );
}

#[test]
fn test_io_retry() {
    #[derive(Debug)]
    struct RetryStream {
        inner: TcpStream,
        first_read: bool,
        first_write: bool,
        first_flush: bool,
    }

    impl Read for RetryStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            if mem::replace(&mut self.first_read, false) {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "first read"))
            } else {
                self.inner.read(buf)
            }
        }
    }

    impl Write for RetryStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            if mem::replace(&mut self.first_write, false) {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "first write"))
            } else {
                self.inner.write(buf)
            }
        }

        fn flush(&mut self) -> io::Result<()> {
            if mem::replace(&mut self.first_flush, false) {
                Err(io::Error::new(io::ErrorKind::WouldBlock, "first flush"))
            } else {
                self.inner.flush()
            }
        }
    }

    let server = Server::builder().build();

    let stream = RetryStream {
        inner: server.connect_tcp(),
        first_read: true,
        first_write: true,
        first_flush: true,
    };

    let ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let mut s = match Ssl::new(&ctx.build()).unwrap().connect(stream) {
        Ok(mut s) => return s.read_exact(&mut [0]).unwrap(),
        Err(HandshakeError::WouldBlock(s)) => s,
        Err(_) => panic!("should not fail on setup"),
    };
    loop {
        match s.handshake() {
            Ok(mut s) => return s.read_exact(&mut [0]).unwrap(),
            Err(HandshakeError::WouldBlock(mid_s)) => s = mid_s,
            Err(_) => panic!("should not fail on handshake"),
        }
    }
}

#[test]
#[should_panic(expected = "blammo")]
fn write_panic() {
    struct ExplodingStream(TcpStream);

    impl Read for ExplodingStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for ExplodingStream {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            panic!("blammo");
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let stream = ExplodingStream(server.connect_tcp());

    let ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let _ = Ssl::new(&ctx.build()).unwrap().connect(stream);
}

#[test]
#[should_panic(expected = "blammo")]
fn read_panic() {
    struct ExplodingStream(TcpStream);

    impl Read for ExplodingStream {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            panic!("blammo");
        }
    }

    impl Write for ExplodingStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let stream = ExplodingStream(server.connect_tcp());

    let ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let _ = Ssl::new(&ctx.build()).unwrap().connect(stream);
}

#[test]
#[should_panic(expected = "blammo")]
fn flush_panic() {
    struct ExplodingStream(TcpStream);

    impl Read for ExplodingStream {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            self.0.read(buf)
        }
    }

    impl Write for ExplodingStream {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }

        fn flush(&mut self) -> io::Result<()> {
            panic!("blammo");
        }
    }

    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let stream = ExplodingStream(server.connect_tcp());

    let ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let _ = Ssl::new(&ctx.build()).unwrap().connect(stream);
}

#[test]
fn refcount_ssl_context() {
    let mut ssl = {
        let ctx = SslContext::builder(SslMethod::tls()).unwrap();
        ssl::Ssl::new(&ctx.build()).unwrap()
    };

    {
        let new_ctx_a = SslContext::builder(SslMethod::tls()).unwrap().build();
        let _new_ctx_b = ssl.set_ssl_context(&new_ctx_a);
    }
}

#[test]
#[cfg_attr(target_os = "windows", ignore)]
#[cfg_attr(all(target_os = "macos"), ignore)]
fn default_verify_paths() {
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_default_verify_paths().unwrap();
    ctx.set_verify(SslVerifyMode::PEER);
    let ctx = ctx.build();
    let s = match TcpStream::connect("google.com:443") {
        Ok(s) => s,
        Err(_) => return,
    };
    let mut ssl = Ssl::new(&ctx).unwrap();
    ssl.set_hostname("google.com").unwrap();
    let mut socket = ssl.connect(s).unwrap();

    socket.write_all(b"GET / HTTP/1.0\r\n\r\n").unwrap();
    let mut result = vec![];
    socket.read_to_end(&mut result).unwrap();

    println!("{}", String::from_utf8_lossy(&result));
    assert!(result.starts_with(b"HTTP/1.0"));
    assert!(result.ends_with(b"</HTML>\r\n") || result.ends_with(b"</html>"));
}

#[test]
fn add_extra_chain_cert() {
    let cert = X509::from_pem(CERT).unwrap();
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.add_extra_chain_cert(cert).unwrap();
}

#[test]
fn verify_valid_hostname() {
    let server = Server::builder().build();
    let mut client = server.client_with_root_ca();

    client.ctx().set_verify(SslVerifyMode::PEER);

    let mut client = client.build().builder();

    client.ssl().param_mut().set_host("foobar.com").unwrap();
    client.connect();
}

#[test]
fn verify_valid_hostname_with_wildcard() {
    let mut server = Server::builder();

    server
        .ctx()
        .set_certificate_chain_file("test/cert-wildcard.pem")
        .unwrap();

    let server = server.build();
    let mut client = server.client_with_root_ca();

    client.ctx().set_verify(SslVerifyMode::PEER);

    let mut client = client.build().builder();
    client.ssl().param_mut().set_host("yes.foobar.com").unwrap();
    client.connect();
}

#[test]
fn verify_reject_underscore_hostname_with_wildcard() {
    let mut server = Server::builder();

    server.should_error();
    server
        .ctx()
        .set_certificate_chain_file("test/cert-wildcard.pem")
        .unwrap();

    let server = server.build();
    let mut client = server.client_with_root_ca();

    client.ctx().set_verify(SslVerifyMode::PEER);

    let mut client = client.build().builder();
    client
        .ssl()
        .param_mut()
        .set_host("not_allowed.foobar.com")
        .unwrap();
    client.connect_err();
}

#[cfg(feature = "underscore-wildcards")]
#[test]
fn verify_allow_underscore_hostname_with_wildcard() {
    let mut server = Server::builder();

    server
        .ctx()
        .set_certificate_chain_file("test/cert-wildcard.pem")
        .unwrap();

    let server = server.build();
    let mut client = server.client_with_root_ca();

    client.ctx().set_verify(SslVerifyMode::PEER);

    let mut client = client.build().builder();

    client
        .ssl()
        .param_mut()
        .set_hostflags(X509CheckFlags::UNDERSCORE_WILDCARDS);
    client
        .ssl()
        .param_mut()
        .set_host("now_allowed.foobar.com")
        .unwrap();
    client.connect();
}

#[test]
fn verify_invalid_hostname() {
    let mut server = Server::builder();

    server.should_error();

    let server = server.build();
    let mut client = server.client_with_root_ca();

    client.ctx().set_verify(SslVerifyMode::PEER);

    let mut client = client.build().builder();
    client
        .ssl()
        .param_mut()
        .set_hostflags(X509CheckFlags::NO_PARTIAL_WILDCARDS);
    client.ssl().param_mut().set_host("bogus.com").unwrap();
    client.connect_err();
}

#[test]
fn connector_valid_hostname() {
    let mut server = Server::builder();
    server.ctx().set_certificate(&certificate_with_san()).unwrap();
    let server = server.build();

    let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
    connector.set_ca_file("test/root-ca.pem").unwrap();

    let s = server.connect_tcp();
    let mut s = connector.build().connect("foobar.com", s).unwrap();
    s.read_exact(&mut [0]).unwrap();
}

#[test]
fn connector_rejects_common_name_without_san() {
    let mut server = Server::builder();
    server.should_error();
    let server = server.build();
    let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
    connector.set_ca_file("test/root-ca.pem").unwrap();
    connector
        .build()
        .connect("foobar.com", server.connect_tcp())
        .unwrap_err();
}

#[test]
fn connector_invalid_hostname() {
    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
    connector.set_ca_file("test/root-ca.pem").unwrap();

    let s = server.connect_tcp();
    connector.build().connect("bogus.com", s).unwrap_err();
}

#[test]
fn connector_invalid_no_hostname_verification() {
    let server = Server::builder().build();

    let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
    connector.set_ca_file("test/root-ca.pem").unwrap();

    let s = server.connect_tcp();
    let mut s = connector
        .build()
        .configure()
        .unwrap()
        .verify_hostname(false)
        .connect("bogus.com", s)
        .unwrap();
    s.read_exact(&mut [0]).unwrap();
}

#[test]
fn connector_no_hostname_still_verifies() {
    let mut server = Server::builder();
    server.should_error();
    let server = server.build();

    let connector = SslConnector::builder(SslMethod::tls()).unwrap().build();

    let s = server.connect_tcp();
    assert!(connector
        .configure()
        .unwrap()
        .verify_hostname(false)
        .connect("fizzbuzz.com", s)
        .is_err());
}

#[test]
fn connector_no_hostname_can_disable_verify() {
    let server = Server::builder().build();

    let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
    connector.set_verify(SslVerifyMode::NONE);
    let connector = connector.build();

    let s = server.connect_tcp();
    let mut s = connector
        .configure()
        .unwrap()
        .verify_hostname(false)
        .connect("foobar.com", s)
        .unwrap();
    s.read_exact(&mut [0]).unwrap();
}

fn test_mozilla_server(new: fn(SslMethod) -> Result<SslAcceptorBuilder, ErrorStack>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();

    let t = thread::spawn(move || {
        let key = PKey::private_key_from_pem(KEY).unwrap();
        let cert = certificate_with_san();
        let mut acceptor = new(SslMethod::tls()).unwrap();
        acceptor.set_private_key(&key).unwrap();
        acceptor.set_certificate(&cert).unwrap();
        let acceptor = acceptor.build();
        let stream = listener.accept().unwrap().0;
        let mut stream = acceptor.accept(stream).unwrap();

        stream.write_all(b"hello").unwrap();
    });

    let mut connector = SslConnector::builder(SslMethod::tls()).unwrap();
    connector.set_ca_file("test/root-ca.pem").unwrap();
    let connector = connector.build();

    let stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
    let mut stream = connector.connect("foobar.com", stream).unwrap();

    let mut buf = [0; 5];
    stream.read_exact(&mut buf).unwrap();
    assert_eq!(b"hello", &buf);

    t.join().unwrap();
}

#[test]
fn connector_client_server_mozilla_intermediate() {
    test_mozilla_server(SslAcceptor::mozilla_intermediate);
}

#[test]
fn connector_client_server_mozilla_modern() {
    test_mozilla_server(SslAcceptor::mozilla_modern);
}

#[test]
fn connector_client_server_mozilla_intermediate_v5() {
    test_mozilla_server(SslAcceptor::mozilla_intermediate_v5);
}

#[test]
fn shutdown() {
    let mut server = Server::builder();
    server.io_cb(|mut s| {
        assert_eq!(s.read(&mut [0]).unwrap(), 0);
        assert_eq!(s.shutdown().unwrap(), ShutdownResult::Received);
    });
    let server = server.build();

    let mut s = server.client().connect();

    assert_eq!(s.get_shutdown(), ShutdownState::empty());
    assert_eq!(s.shutdown().unwrap(), ShutdownResult::Sent);
    assert_eq!(s.get_shutdown(), ShutdownState::SENT);
    assert_eq!(s.shutdown().unwrap(), ShutdownResult::Received);
    assert_eq!(
        s.get_shutdown(),
        ShutdownState::SENT | ShutdownState::RECEIVED
    );
}

#[test]
fn client_ca_list() {
    let names = X509Name::load_client_ca_file("test/root-ca.pem").unwrap();
    assert_eq!(names.len(), 1);

    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_client_ca_list(names);
}

#[test]
fn keying_export() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let addr = listener.local_addr().unwrap();

    let label = "EXPERIMENTAL test";
    let context = b"my context";

    let guard = thread::spawn(move || {
        let stream = listener.accept().unwrap().0;
        let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
        ctx.set_certificate_file(Path::new("test/cert.pem"), SslFiletype::PEM)
            .unwrap();
        ctx.set_private_key_file(Path::new("test/key.pem"), SslFiletype::PEM)
            .unwrap();
        let ssl = Ssl::new(&ctx.build()).unwrap();
        let mut stream = ssl.accept(stream).unwrap();

        let mut buf = [0; 32];
        stream
            .ssl()
            .export_keying_material(&mut buf, label, Some(context))
            .unwrap();

        stream.write_all(&[0]).unwrap();

        buf
    });

    let stream = TcpStream::connect(addr).unwrap();
    let ctx = SslContext::builder(SslMethod::tls()).unwrap();
    let ssl = Ssl::new(&ctx.build()).unwrap();
    let mut stream = ssl.connect(stream).unwrap();

    let mut buf = [1; 32];
    stream
        .ssl()
        .export_keying_material(&mut buf, label, Some(context))
        .unwrap();

    stream.read_exact(&mut [0]).unwrap();

    let buf2 = guard.join().unwrap();

    assert_eq!(buf, buf2);
}

#[test]
fn no_version_overlap() {
    let mut server = Server::builder();
    server.ctx().set_min_proto_version(None).unwrap();
    server
        .ctx()
        .set_max_proto_version(Some(SslVersion::TLS1_1))
        .unwrap();
    assert_eq!(server.ctx().max_proto_version(), Some(SslVersion::TLS1_1));
    server.should_error();
    let server = server.build();

    let mut client = server.client();
    client
        .ctx()
        .set_min_proto_version(Some(SslVersion::TLS1_2))
        .unwrap();
    assert_eq!(client.ctx().min_proto_version(), Some(SslVersion::TLS1_2));
    client.ctx().set_max_proto_version(None).unwrap();

    client.connect_err();
}

fn _check_kinds() {
    fn is_send<T: Send>() {}
    fn is_sync<T: Sync>() {}

    is_send::<SslStream<TcpStream>>();
    is_sync::<SslStream<TcpStream>>();
}

#[test]
fn psk_ciphers() {
    const CIPHER: &str = "PSK-AES128-CBC-SHA";
    const PSK: &[u8] = b"thisisaverysecurekey";
    const CLIENT_IDENT: &[u8] = b"thisisaclient";
    static CLIENT_CALLED: AtomicBool = AtomicBool::new(false);
    static SERVER_CALLED: AtomicBool = AtomicBool::new(false);

    let mut server = Server::builder();
    server.ctx().set_cipher_list(CIPHER).unwrap();
    server.ctx().set_psk_server_callback(|_, identity, psk| {
        assert!(identity.unwrap_or(&[]) == CLIENT_IDENT);
        psk[..PSK.len()].copy_from_slice(PSK);
        SERVER_CALLED.store(true, Ordering::SeqCst);
        Ok(PSK.len())
    });

    let server = server.build();

    let mut client = server.client();
    // This test relies on TLS 1.2 suites
    client.ctx().set_options(super::SslOptions::NO_TLSV1_3);
    client.ctx().set_cipher_list(CIPHER).unwrap();
    client
        .ctx()
        .set_psk_client_callback(move |_, _, identity, psk| {
            identity[..CLIENT_IDENT.len()].copy_from_slice(CLIENT_IDENT);
            identity[CLIENT_IDENT.len()] = 0;
            psk[..PSK.len()].copy_from_slice(PSK);
            CLIENT_CALLED.store(true, Ordering::SeqCst);
            Ok(PSK.len())
        });

    client.connect();

    assert!(CLIENT_CALLED.load(Ordering::SeqCst) && SERVER_CALLED.load(Ordering::SeqCst));
}

#[test]
fn sni_callback_swapped_ctx() {
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);

    let mut server = Server::builder();

    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_servername_callback(|_, _| {
        CALLED_BACK.store(true, Ordering::SeqCst);
        Ok(())
    });

    let keyed_ctx = mem::replace(server.ctx(), ctx).build();
    server.ssl_cb(move |ssl| ssl.set_ssl_context(&keyed_ctx).unwrap());

    let server = server.build();

    server.client().connect();

    assert!(CALLED_BACK.load(Ordering::SeqCst));
}

#[test]
fn get_curve() {
    let server = Server::builder().build();
    let client = server.client_with_root_ca();
    let client_stream = client.connect();
    let curve = client_stream.ssl().curve();
    assert!(curve.is_some());
    let curve_name = client_stream.ssl().curve_name();
    assert!(curve_name.is_some());
}

#[test]
fn used_hello_retry_request_true() {
    let mut server_builder = Server::builder();
    // Configures the server to prefer it's options over the client
    server_builder
        .ctx()
        .set_options(SslOptions::CIPHER_SERVER_PREFERENCE);
    server_builder
        .ctx()
        .set_curves_list("P-256:X25519")
        .unwrap();
    let server = server_builder.build();
    let mut client_builder = server.client_with_root_ca();
    // configures the client to send this supported groups
    client_builder
        .ctx()
        .set_curves_list("X25519:P-256")
        .unwrap();

    let client_stream = client_builder.connect();
    let ssl = client_stream.ssl();
    assert!(ssl.used_hello_retry_request());
}

#[test]
fn used_hello_retry_request_false() {
    let mut server_builder = Server::builder();
    // Server doesn't configure CIPHER_SERVER_PREFERENCE, so it will use the preference of the client
    server_builder
        .ctx()
        .set_curves_list("P-256:X25519")
        .unwrap();
    let server = server_builder.build();
    let mut client_builder = server.client_with_root_ca();
    // configures the client to send this supported groups
    client_builder
        .ctx()
        .set_curves_list("X25519:P-256")
        .unwrap();

    let client_stream = client_builder.connect();
    let ssl = client_stream.ssl();
    assert!(!ssl.used_hello_retry_request());
}

#[test]
fn test_get_ciphers() {
    let ctx_builder = SslContext::builder(SslMethod::tls()).unwrap();
    let ctx_builder_ciphers: Vec<&str> = ctx_builder
        .ciphers()
        .unwrap()
        .into_iter()
        .map(|v| v.name())
        .collect();
    assert!(!(ctx_builder_ciphers.is_empty()));

    let ctx = ctx_builder.build();
    let ctx_ciphers: Vec<&str> = ctx
        .ciphers()
        .unwrap()
        .into_iter()
        .map(|v| v.name())
        .collect();
    assert!(!(ctx_ciphers.is_empty()));

    assert_eq!(ctx_builder_ciphers.len(), ctx_ciphers.len());

    for (ctx_builder_cipher, ctx_cipher) in ctx_builder_ciphers.into_iter().zip(ctx_ciphers) {
        assert_eq!(ctx_builder_cipher, ctx_cipher);
    }
}

#[test]
fn test_set_compliance() {
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_compliance_policy(CompliancePolicy::FIPS_202205)
        .unwrap();

    assert_eq!(ctx.max_proto_version().unwrap(), SslVersion::TLS1_3);
    assert_eq!(ctx.min_proto_version().unwrap(), SslVersion::TLS1_2);

    const FIPS_CIPHERS: [&str; 4] = [
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
    ];

    let ciphers = ctx.ciphers().unwrap();
    assert_eq!(ciphers.len(), FIPS_CIPHERS.len());

    for cipher in ciphers.into_iter().zip(FIPS_CIPHERS) {
        assert_eq!(cipher.0.name(), cipher.1);
    }

    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_compliance_policy(CompliancePolicy::WPA3_192_202304)
        .unwrap();

    assert_eq!(ctx.max_proto_version().unwrap(), SslVersion::TLS1_3);
    assert_eq!(ctx.min_proto_version().unwrap(), SslVersion::TLS1_2);

    const WPA3_192_CIPHERS: [&str; 2] = [
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
    ];

    let ciphers = ctx.ciphers().unwrap();
    assert_eq!(ciphers.len(), WPA3_192_CIPHERS.len());

    for cipher in ciphers.into_iter().zip(WPA3_192_CIPHERS) {
        assert_eq!(cipher.0.name(), cipher.1);
    }

    ctx.set_compliance_policy(CompliancePolicy::NONE)
        .expect_err("Testing expect err if set compliance policy to NONE");
}

#[test]
fn drop_ex_data_in_context() {
    let index = SslContext::new_ex_index::<&'static str>().unwrap();
    let mut ctx = SslContext::builder(SslMethod::dtls()).unwrap();

    assert_eq!(ctx.replace_ex_data(index, "comté"), None);
    assert_eq!(ctx.replace_ex_data(index, "camembert"), Some("comté"));
    assert_eq!(ctx.replace_ex_data(index, "raclette"), Some("camembert"));
}

#[test]
fn drop_ex_data_in_ssl() {
    let index = Ssl::new_ex_index::<&'static str>().unwrap();
    let ctx = SslContext::builder(SslMethod::dtls()).unwrap().build();
    let mut ssl = Ssl::new(&ctx).unwrap();

    assert_eq!(ssl.replace_ex_data(index, "comté"), None);
    assert_eq!(ssl.replace_ex_data(index, "camembert"), Some("comté"));
    assert_eq!(ssl.replace_ex_data(index, "raclette"), Some("camembert"));
}

#[test]
fn test_info_callback() {
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);

    let server = Server::builder().build();
    let mut client = server.client();
    client.ctx().set_info_callback(move |_, _, _| {
        CALLED_BACK.store(true, Ordering::Relaxed);
    });

    client.connect();
    assert!(CALLED_BACK.load(Ordering::Relaxed));
}

#[test]
fn test_ssl_set_compliance() {
    let ctx = SslContext::builder(SslMethod::tls()).unwrap().build();
    let mut ssl = Ssl::new(&ctx).unwrap();
    ssl.set_compliance_policy(CompliancePolicy::FIPS_202205)
        .unwrap();

    assert_eq!(ssl.max_proto_version().unwrap(), SslVersion::TLS1_3);
    assert_eq!(ssl.min_proto_version().unwrap(), SslVersion::TLS1_2);

    const FIPS_CIPHERS: [&str; 4] = [
        "ECDHE-ECDSA-AES128-GCM-SHA256",
        "ECDHE-RSA-AES128-GCM-SHA256",
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
    ];

    let ciphers = ssl.ciphers();
    assert_eq!(ciphers.len(), FIPS_CIPHERS.len());

    for cipher in ciphers.into_iter().zip(FIPS_CIPHERS) {
        assert_eq!(cipher.0.name(), cipher.1);
    }

    let ctx = SslContext::builder(SslMethod::tls()).unwrap().build();
    let mut ssl = Ssl::new(&ctx).unwrap();
    ssl.set_compliance_policy(CompliancePolicy::WPA3_192_202304)
        .unwrap();

    assert_eq!(ssl.max_proto_version().unwrap(), SslVersion::TLS1_3);
    assert_eq!(ssl.min_proto_version().unwrap(), SslVersion::TLS1_2);

    const WPA3_192_CIPHERS: [&str; 2] = [
        "ECDHE-ECDSA-AES256-GCM-SHA384",
        "ECDHE-RSA-AES256-GCM-SHA384",
    ];

    let ciphers = ssl.ciphers();
    assert_eq!(ciphers.len(), WPA3_192_CIPHERS.len());

    for cipher in ciphers.into_iter().zip(WPA3_192_CIPHERS) {
        assert_eq!(cipher.0.name(), cipher.1);
    }

    ssl.set_compliance_policy(CompliancePolicy::NONE)
        .expect_err("Testing expect err if set compliance policy to NONE");
}

#[test]
fn ex_data_drop() {
    use crate::ssl::SslContextBuilder;
    use std::sync::atomic::AtomicU32;
    use std::sync::atomic::Ordering::Relaxed;
    use std::sync::Arc;

    struct TrackDrop(Arc<AtomicU32>);
    impl Drop for TrackDrop {
        fn drop(&mut self) {
            self.0.fetch_add(1, Relaxed);
        }
    }

    let mut ctx = SslContextBuilder::new(SslMethod::tls()).unwrap();
    let index = SslContext::new_ex_index().unwrap();
    let d1 = Arc::new(AtomicU32::new(100));
    let d2 = Arc::new(AtomicU32::new(200));
    let d3 = Arc::new(AtomicU32::new(300));
    ctx.set_ex_data(index, TrackDrop(d1.clone()));
    assert_eq!(100, d1.load(Relaxed));
    assert_eq!(200, d2.load(Relaxed));
    ctx.replace_ex_data(index, TrackDrop(d2.clone()));
    assert_eq!(101, d1.load(Relaxed));
    assert_eq!(200, d2.load(Relaxed));
    ctx.replace_ex_data(index, TrackDrop(d3.clone()));
    assert_eq!(101, d1.load(Relaxed));
    assert_eq!(201, d2.load(Relaxed));
    assert_eq!(300, d3.load(Relaxed));
    drop(ctx);
    assert_eq!(101, d1.load(Relaxed));
    assert_eq!(201, d2.load(Relaxed));
    assert_eq!(301, d3.load(Relaxed));

    let mut ctx2 = SslContextBuilder::new(SslMethod::tls()).unwrap();

    ctx2.set_ex_data(index, TrackDrop(d1.clone()));
    ctx2.set_ex_data(index, TrackDrop(d2.clone()));
    drop(ctx2);
    assert_eq!(102, d1.load(Relaxed));
    assert_eq!(202, d2.load(Relaxed));
}
