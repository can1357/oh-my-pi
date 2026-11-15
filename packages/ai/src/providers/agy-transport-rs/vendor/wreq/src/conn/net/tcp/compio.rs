//! Compio-based TCP connector.

#![allow(dead_code)]

use std::{future::Future, io, net::SocketAddr, pin::Pin, time::Duration};

use compio::net::{TcpSocket, TcpStream};
use wreq_rt::rt::compio::{future::SendFuture, io::CompioIO};

use super::BoxConnecting;
use crate::conn::{
    Connected, Connection, http::HttpInfo, net::io::CompioConnection, tls_info::TlsInfoFactory,
};

/// A connector that uses `compio` for TCP connections.
#[derive(Clone, Copy, Debug, Default)]
pub struct TcpConnector {
    _priv: (),
}

// ===== impl TcpConnector =====

impl TcpConnector {
    /// Creates a new [`TcpConnector`].
    #[inline]
    pub fn new() -> Self {
        Self { _priv: () }
    }
}

impl super::TcpConnector for TcpConnector {
    type TcpStream = std::net::TcpStream;
    type Connection = CompioConnection<TcpStream>;
    type Error = io::Error;
    type Future = BoxConnecting<Self::Connection, Self::Error>;
    type Sleep = Pin<Box<dyn Future<Output = ()> + Send + 'static>>;

    #[inline]
    fn connect(&self, socket: Self::TcpStream, addr: SocketAddr) -> Self::Future {
        Box::pin(SendFuture::new(async move {
            let socket = TcpSocket::from_std_stream(socket)?;
            let tcp_stream = socket.connect(addr).await?;
            Ok(CompioConnection {
                peer_addr: tcp_stream.peer_addr().ok(),
                local_addr: tcp_stream.local_addr().ok(),
                inner: CompioIO::new(tcp_stream),
            })
        }))
    }

    #[inline]
    fn sleep(&self, duration: Duration) -> Self::Sleep {
        Box::pin(SendFuture::new(compio::time::sleep(duration)))
    }
}

impl Connection for CompioConnection<TcpStream> {
    fn connected(&self) -> Connected {
        let connected = Connected::new();
        if let (Some(remote_addr), Some(local_addr)) = (self.peer_addr, self.local_addr) {
            connected.extra(HttpInfo {
                remote_addr,
                local_addr,
            })
        } else {
            connected
        }
    }
}

impl TlsInfoFactory for CompioConnection<TcpStream> {}
