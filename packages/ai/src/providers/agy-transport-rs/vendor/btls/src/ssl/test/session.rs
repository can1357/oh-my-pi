use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

use crate::ssl::test::server::Server;
use crate::ssl::{
    ErrorCode, GetSessionPendingError, HandshakeError, Ssl, SslContext, SslContextBuilder,
    SslMethod, SslOptions, SslSession, SslSessionCacheMode, SslVersion,
};

#[test]
fn idle_session() {
    let ctx = SslContext::builder(SslMethod::tls()).unwrap().build();
    let ssl = Ssl::new(&ctx).unwrap();
    assert!(ssl.session().is_none());
}

#[test]
fn active_session() {
    let server = Server::builder().build();

    let s = server.client().connect();

    let session = s.ssl().session().unwrap();
    let len = session.master_key_len();
    let mut buf = vec![0; len - 1];
    let copied = session.master_key(&mut buf);
    assert_eq!(copied, buf.len());
    let mut buf = vec![0; len + 1];
    let copied = session.master_key(&mut buf);
    assert_eq!(copied, len);
}

#[test]
fn new_get_session_callback() {
    static FOUND_SESSION: AtomicBool = AtomicBool::new(false);
    static SERVER_SESSION_DER: OnceLock<Vec<u8>> = OnceLock::new();
    static CLIENT_SESSION_DER: OnceLock<Vec<u8>> = OnceLock::new();

    let mut server = Server::builder();

    server.expected_connections_count(2);
    server
        .ctx()
        .set_max_proto_version(Some(SslVersion::TLS1_2))
        .unwrap();
    server.ctx().set_options(SslOptions::NO_TICKET);
    server
        .ctx()
        .set_session_cache_mode(SslSessionCacheMode::SERVER | SslSessionCacheMode::NO_INTERNAL);
    server.ctx().set_new_session_callback(|_, session| {
        SERVER_SESSION_DER.set(session.to_der().unwrap()).unwrap();
    });
    unsafe {
        server.ctx().set_get_session_callback(|_, id| {
            let Some(der) = SERVER_SESSION_DER.get() else {
                return Ok(None);
            };

            let session = SslSession::from_der(der).unwrap();

            FOUND_SESSION.store(true, Ordering::SeqCst);

            assert_eq!(id, session.id());

            Ok(Some(session))
        });
    }
    server.ctx().set_session_id_context(b"foo").unwrap();

    let server = server.build();

    let mut client = server.client();

    client
        .ctx()
        .set_session_cache_mode(SslSessionCacheMode::CLIENT);
    client.ctx().set_new_session_callback(|_, session| {
        CLIENT_SESSION_DER.set(session.to_der().unwrap()).unwrap();
    });

    let client = client.build();

    client.builder().connect();

    assert!(CLIENT_SESSION_DER.get().is_some());
    assert!(SERVER_SESSION_DER.get().is_some());
    assert!(!FOUND_SESSION.load(Ordering::SeqCst));

    let mut ssl_builder = client.builder();

    unsafe {
        ssl_builder
            .ssl()
            .set_session(&SslSession::from_der(CLIENT_SESSION_DER.get().unwrap()).unwrap())
            .unwrap();
    }

    ssl_builder.connect();

    assert!(FOUND_SESSION.load(Ordering::SeqCst));
}

#[test]
fn new_get_session_callback_pending() {
    static CALLED_SERVER_CALLBACK: AtomicBool = AtomicBool::new(false);

    let mut server = Server::builder();

    server
        .ctx()
        .set_max_proto_version(Some(SslVersion::TLS1_2))
        .unwrap();
    server.ctx().set_options(SslOptions::NO_TICKET);
    server
        .ctx()
        .set_session_cache_mode(SslSessionCacheMode::SERVER | SslSessionCacheMode::NO_INTERNAL);
    unsafe {
        server.ctx().set_get_session_callback(|_, _| {
            if !CALLED_SERVER_CALLBACK.swap(true, Ordering::SeqCst) {
                return Err(GetSessionPendingError);
            }

            Ok(None)
        });
    }
    server.ctx().set_session_id_context(b"foo").unwrap();
    server.err_cb(|error| {
        let HandshakeError::WouldBlock(mid_handshake) = error else {
            panic!("should be WouldBlock");
        };

        assert!(mid_handshake.error().would_block());
        assert_eq!(mid_handshake.error().code(), ErrorCode::PENDING_SESSION);

        let mut socket = mid_handshake.handshake().unwrap();

        socket.write_all(&[0]).unwrap();
    });

    let server = server.build();

    let mut client = server.client();

    client
        .ctx()
        .set_session_cache_mode(SslSessionCacheMode::CLIENT);

    client.connect();
}

#[test]
fn new_session_callback_swapped_ctx() {
    static CALLED_BACK: AtomicBool = AtomicBool::new(false);

    let mut server = Server::builder();
    server.ctx().set_session_id_context(b"foo").unwrap();

    let server = server.build();

    let mut client = server.client();

    client
        .ctx()
        .set_session_cache_mode(SslSessionCacheMode::CLIENT | SslSessionCacheMode::NO_INTERNAL);
    client
        .ctx()
        .set_new_session_callback(|_, _| CALLED_BACK.store(true, Ordering::SeqCst));

    let mut client = client.build().builder();

    let ctx = SslContextBuilder::new(SslMethod::tls()).unwrap().build();
    client.ssl().set_ssl_context(&ctx).unwrap();

    client.connect();

    assert!(CALLED_BACK.load(Ordering::SeqCst));
}

#[test]
fn session_cache_size() {
    let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
    ctx.set_session_cache_size(1234);
    let ctx = ctx.build();
    assert_eq!(ctx.session_cache_size(), 1234);
}
