//! Tokio-based TCP connector.

use std::{io, net::SocketAddr, time::Duration};

use tokio::net::{TcpSocket, TcpStream};

use super::BoxConnecting;
use crate::conn::{Connected, Connection, http::HttpInfo, tls_info::TlsInfoFactory};

/// A connector that uses `tokio` for TCP connections.
#[derive(Clone, Copy, Debug, Default)]
pub struct TcpConnector {
    _priv: (),
}

impl TcpConnector {
    /// Creates a new [`TcpConnector`].
    #[inline]
    pub fn new() -> Self {
        Self { _priv: () }
    }
}

impl super::TcpConnector for TcpConnector {
    type TcpStream = std::net::TcpStream;
    type Connection = TcpStream;
    type Error = io::Error;
    type Future = BoxConnecting<Self::Connection, Self::Error>;
    type Sleep = tokio::time::Sleep;

    #[inline]
    fn connect(&self, socket: Self::TcpStream, addr: SocketAddr) -> Self::Future {
        let socket = TcpSocket::from_std_stream(socket);
        Box::pin(socket.connect(addr))
    }

    #[inline]
    fn sleep(&self, duration: Duration) -> Self::Sleep {
        tokio::time::sleep(duration)
    }
}

impl Connection for TcpStream {
    fn connected(&self) -> Connected {
        let connected = Connected::new();
        if let (Ok(remote_addr), Ok(local_addr)) = (self.peer_addr(), self.local_addr()) {
            connected.extra(HttpInfo {
                remote_addr,
                local_addr,
            })
        } else {
            connected
        }
    }
}

impl TlsInfoFactory for TcpStream {}
