use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::thread::{self, JoinHandle};

use crate::ssl::{
    HandshakeError, Ssl, SslContext, SslContextBuilder, SslFiletype, SslMethod, SslRef, SslStream,
};

pub struct Server {
    handle: Option<JoinHandle<()>>,
    addr: SocketAddr,
}

impl Drop for Server {
    fn drop(&mut self) {
        if !thread::panicking() {
            self.handle.take().unwrap().join().unwrap();
        }
    }
}

impl Server {
    pub fn builder() -> Builder {
        let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
        ctx.set_certificate_chain_file("test/cert.pem").unwrap();
        ctx.set_private_key_file("test/key.pem", SslFiletype::PEM)
            .unwrap();

        Builder {
            ctx,
            ssl_cb: Box::new(|_| {}),
            io_cb: Box::new(|_| {}),
            err_cb: Box::new(|_| {}),
            should_error: false,
            expected_connections_count: 1,
        }
    }

    /// Serves the leaf and the root together.
    pub fn builder_full_chain() -> Builder {
        let mut ctx = SslContext::builder(SslMethod::tls()).unwrap();
        // Uses certs.pem instead of cert.pem.
        ctx.set_certificate_chain_file("test/certs.pem").unwrap();
        ctx.set_private_key_file("test/key.pem", SslFiletype::PEM)
            .unwrap();

        Builder {
            ctx,
            ssl_cb: Box::new(|_| {}),
            io_cb: Box::new(|_| {}),
            err_cb: Box::new(|_| {}),
            should_error: false,
            expected_connections_count: 1,
        }
    }

    pub fn client(&self) -> ClientBuilder {
        ClientBuilder {
            ctx: SslContext::builder(SslMethod::tls()).unwrap(),
            addr: self.addr,
        }
    }

    pub fn client_with_root_ca(&self) -> ClientBuilder {
        let mut client = self.client();

        client.ctx().set_ca_file("test/root-ca.pem").unwrap();

        client
    }

    pub fn connect_tcp(&self) -> TcpStream {
        TcpStream::connect(self.addr).unwrap()
    }
}

pub struct Builder {
    ctx: SslContextBuilder,
    ssl_cb: Box<dyn FnMut(&mut SslRef) + Send>,
    io_cb: Box<dyn FnMut(SslStream<TcpStream>) + Send>,
    err_cb: Box<dyn FnMut(HandshakeError<TcpStream>) + Send>,
    should_error: bool,
    expected_connections_count: usize,
}

impl Builder {
    pub fn ctx(&mut self) -> &mut SslContextBuilder {
        &mut self.ctx
    }

    pub fn ssl_cb<F>(&mut self, cb: F)
    where
        F: 'static + FnMut(&mut SslRef) + Send,
    {
        self.ssl_cb = Box::new(cb);
    }

    pub fn io_cb<F>(&mut self, cb: F)
    where
        F: 'static + FnMut(SslStream<TcpStream>) + Send,
    {
        self.io_cb = Box::new(cb);
    }

    pub fn err_cb(&mut self, cb: impl FnMut(HandshakeError<TcpStream>) + Send + 'static) {
        self.should_error();

        self.err_cb = Box::new(cb);
    }

    pub fn should_error(&mut self) {
        self.should_error = true;
    }

    pub fn expected_connections_count(&mut self, count: usize) {
        self.expected_connections_count = count;
    }

    pub fn build(self) -> Server {
        let ctx = self.ctx.build();
        let socket = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = socket.local_addr().unwrap();
        let mut ssl_cb = self.ssl_cb;
        let mut io_cb = self.io_cb;
        let mut err_cb = self.err_cb;
        let should_error = self.should_error;
        let mut count = self.expected_connections_count;

        let handle = thread::spawn(move || {
            while count > 0 {
                let socket = socket.accept().unwrap().0;
                let mut ssl = Ssl::new(&ctx).unwrap();

                ssl_cb(&mut ssl);

                let r = ssl.accept(socket);

                if should_error {
                    err_cb(r.unwrap_err());
                } else {
                    let mut socket = r.unwrap();

                    socket.write_all(&[0]).unwrap();
                    io_cb(socket);
                }

                count -= 1;
            }
        });

        Server {
            handle: Some(handle),
            addr,
        }
    }
}

pub struct ClientBuilder {
    ctx: SslContextBuilder,
    addr: SocketAddr,
}

impl ClientBuilder {
    pub fn ctx(&mut self) -> &mut SslContextBuilder {
        &mut self.ctx
    }

    pub fn build(self) -> Client {
        Client {
            ctx: self.ctx.build(),
            addr: self.addr,
        }
    }

    pub fn connect(self) -> SslStream<TcpStream> {
        self.build().builder().connect()
    }

    pub fn connect_err(self) -> HandshakeError<TcpStream> {
        self.build().builder().connect_err()
    }
}

pub struct Client {
    ctx: SslContext,
    addr: SocketAddr,
}

impl Client {
    pub fn builder(&self) -> ClientSslBuilder {
        ClientSslBuilder {
            ssl: Ssl::new(&self.ctx).unwrap(),
            addr: self.addr,
        }
    }
}

pub struct ClientSslBuilder {
    ssl: Ssl,
    addr: SocketAddr,
}

impl ClientSslBuilder {
    pub fn ssl(&mut self) -> &mut SslRef {
        &mut self.ssl
    }

    pub fn connect(self) -> SslStream<TcpStream> {
        let socket = TcpStream::connect(self.addr).unwrap();
        let mut s = self.ssl.connect(socket).unwrap();
        s.read_exact(&mut [0]).unwrap();
        s
    }

    pub fn connect_err(self) -> HandshakeError<TcpStream> {
        let socket = TcpStream::connect(self.addr).unwrap();

        self.ssl.setup_connect(socket).handshake().unwrap_err()
    }
}
