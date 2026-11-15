//! WebSocket message types and utilities
//!
//! This module provides WebSocket message types that wrap the underlying
//! tungstenite message implementation, offering a more ergonomic API
//! for working with WebSocket communications.

use std::{fmt, ops::Deref};

use bytes::Bytes;

use super::tungstenite;
use crate::Error;

/// UTF-8 wrapper for [Bytes].
///
/// An [Utf8Bytes] is always guaranteed to contain valid UTF-8.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Utf8Bytes(pub(super) tungstenite::Utf8Bytes);

impl Utf8Bytes {
    /// Creates from a static str.
    #[inline]
    pub const fn from_static(str: &'static str) -> Self {
        Self(tungstenite::Utf8Bytes::from_static(str))
    }

    /// Returns as a string slice.
    #[inline]
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl Deref for Utf8Bytes {
    type Target = str;

    /// ```
    /// /// Example fn that takes a str slice
    /// fn a(s: &str) {}
    ///
    /// let data = wreq::Utf8Bytes::from_static("foo123");
    ///
    /// // auto-deref as arg
    /// a(&data);
    ///
    /// // deref to str methods
    /// assert_eq!(data.len(), 6);
    /// ```
    #[inline]
    fn deref(&self) -> &Self::Target {
        self.as_str()
    }
}

impl fmt::Display for Utf8Bytes {
    #[inline]
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl TryFrom<Bytes> for Utf8Bytes {
    type Error = std::str::Utf8Error;

    #[inline]
    fn try_from(bytes: Bytes) -> Result<Self, Self::Error> {
        Ok(Self(bytes.try_into()?))
    }
}

impl TryFrom<Vec<u8>> for Utf8Bytes {
    type Error = std::str::Utf8Error;

    #[inline]
    fn try_from(v: Vec<u8>) -> Result<Self, Self::Error> {
        Ok(Self(v.try_into()?))
    }
}

impl From<String> for Utf8Bytes {
    #[inline]
    fn from(s: String) -> Self {
        Self(s.into())
    }
}

impl From<&str> for Utf8Bytes {
    #[inline]
    fn from(s: &str) -> Self {
        Self(s.into())
    }
}

impl From<&String> for Utf8Bytes {
    #[inline]
    fn from(s: &String) -> Self {
        Self(s.into())
    }
}

impl From<Utf8Bytes> for Bytes {
    #[inline]
    fn from(Utf8Bytes(bytes): Utf8Bytes) -> Self {
        bytes.into()
    }
}

impl<T> PartialEq<T> for Utf8Bytes
where
    for<'a> &'a str: PartialEq<T>,
{
    /// ```
    /// let payload = wreq::Utf8Bytes::from_static("foo123");
    /// assert_eq!(payload, "foo123");
    /// assert_eq!(payload, "foo123".to_string());
    /// assert_eq!(payload, &"foo123".to_string());
    /// assert_eq!(payload, std::borrow::Cow::from("foo123"));
    /// ```
    #[inline]
    fn eq(&self, other: &T) -> bool {
        self.as_str() == *other
    }
}

/// Status code used to indicate why an endpoint is closing the WebSocket connection.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CloseCode(pub(super) u16);

impl CloseCode {
    //! Constants for [`CloseCode`]s.
    //!
    //! [`CloseCode`]: super::CloseCode

    /// Indicates a normal closure, meaning that the purpose for which the connection was
    /// established has been fulfilled.
    pub const NORMAL: CloseCode = CloseCode(1000);

    /// Indicates that an endpoint is "going away", such as a server going down or a browser having
    /// navigated away from a page.
    pub const AWAY: CloseCode = CloseCode(1001);

    /// Indicates that an endpoint is terminating the connection due to a protocol error.
    pub const PROTOCOL: CloseCode = CloseCode(1002);

    /// Indicates that an endpoint is terminating the connection because it has received a type of
    /// data that it cannot accept.
    ///
    /// For example, an endpoint MAY send this if it understands only text data, but receives a
    /// binary message.
    pub const UNSUPPORTED: CloseCode = CloseCode(1003);

    /// Indicates that no status code was included in a closing frame.
    pub const STATUS: CloseCode = CloseCode(1005);

    /// Indicates an abnormal closure.
    pub const ABNORMAL: CloseCode = CloseCode(1006);

    /// Indicates that an endpoint is terminating the connection because it has received data
    /// within a message that was not consistent with the type of the message.
    ///
    /// For example, an endpoint received non-UTF-8 RFC3629 data within a text message.
    pub const INVALID: CloseCode = CloseCode(1007);

    /// Indicates that an endpoint is terminating the connection because it has received a message
    /// that violates its policy.
    ///
    /// This is a generic status code that can be returned when there is
    /// no other more suitable status code (e.g., `UNSUPPORTED` or `SIZE`) or if there is a need to
    /// hide specific details about the policy.
    pub const POLICY: CloseCode = CloseCode(1008);

    /// Indicates that an endpoint is terminating the connection because it has received a message
    /// that is too big for it to process.
    pub const SIZE: CloseCode = CloseCode(1009);

    /// Indicates that an endpoint (client) is terminating the connection because the server
    /// did not respond to extension negotiation correctly.
    ///
    /// Specifically, the client has expected the server to negotiate one or more extension(s),
    /// but the server didn't return them in the response message of the WebSocket handshake.
    /// The list of extensions that are needed should be given as the reason for closing.
    /// Note that this status code is not used by the server,
    /// because it can fail the WebSocket handshake instead.
    pub const EXTENSION: CloseCode = CloseCode(1010);

    /// Indicates that a server is terminating the connection because it encountered an unexpected
    /// condition that prevented it from fulfilling the request.
    pub const ERROR: CloseCode = CloseCode(1011);

    /// Indicates that the server is restarting.
    pub const RESTART: CloseCode = CloseCode(1012);

    /// Indicates that the server is overloaded and the client should either connect to a different
    /// IP (when multiple targets exist), or reconnect to the same IP when a user has performed an
    /// action.
    pub const AGAIN: CloseCode = CloseCode(1013);
}

impl From<CloseCode> for u16 {
    #[inline]
    fn from(code: CloseCode) -> u16 {
        code.0
    }
}

impl From<u16> for CloseCode {
    #[inline]
    fn from(code: u16) -> CloseCode {
        CloseCode(code)
    }
}

/// A struct representing the close command.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct CloseFrame {
    /// The reason as a code.
    pub code: CloseCode,
    /// The reason as text string.
    pub reason: Utf8Bytes,
}

/// A WebSocket message.
//
// This code comes from https://github.com/snapview/tungstenite-rs/blob/master/src/protocol/message.rs and is under following license:
// Copyright (c) 2017 Alexey Galakhov
// Copyright (c) 2016 Jason Housley
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
#[derive(Debug, Eq, PartialEq, Clone)]
pub enum Message {
    /// A text WebSocket message
    Text(Utf8Bytes),
    /// A binary WebSocket message
    Binary(Bytes),
    /// A ping message with the specified payload
    ///
    /// The payload here must have a length less than 125 bytes.
    ///
    /// Ping messages will be automatically responded to by the server, so you do not have to worry
    /// about dealing with them yourself.
    Ping(Bytes),
    /// A pong message with the specified payload
    ///
    /// The payload here must have a length less than 125 bytes.
    ///
    /// Pong messages will be automatically sent to the client if a ping message is received, so
    /// you do not have to worry about constructing them yourself unless you want to implement a
    /// [unidirectional heartbeat](https://tools.ietf.org/html/rfc6455#section-5.5.3).
    Pong(Bytes),
    /// A close message with the optional close frame.
    ///
    /// You may "uncleanly" close a WebSocket connection at any time
    /// by simply dropping the [`super::WebSocket`].
    /// However, you may also use the graceful closing protocol, in which
    /// 1. peer A sends a close frame, and does not send any further messages;
    /// 2. peer B responds with a close frame, and does not send any further messages;
    /// 3. peer A processes the remaining messages sent by peer B, before finally
    /// 4. both peers close the connection.
    ///
    /// After sending a close frame,
    /// you may still read messages,
    /// but attempts to send another message will error.
    /// After receiving a close frame,
    /// wreq will automatically respond with a close frame if necessary
    /// (you do not have to deal with this yourself).
    /// Since no further messages will be received,
    /// you may either do nothing
    /// or explicitly drop the connection.
    Close(Option<CloseFrame>),
}

impl Message {
    /// Converts this `Message` into a `tungstenite::Message`.
    ///
    /// This method transforms the current `Message` instance into its corresponding
    /// `tungstenite::Message` representation. This is useful when you need to work
    /// with the `tungstenite` library directly.
    ///
    /// # Returns
    ///
    /// A `tungstenite::Message` instance that represents the current `Message`.
    pub(super) fn into_tungstenite(self) -> tungstenite::Message {
        match self {
            Self::Text(text) => tungstenite::Message::Text(text.0),
            Self::Binary(binary) => tungstenite::Message::Binary(binary),
            Self::Ping(ping) => tungstenite::Message::Ping(ping),
            Self::Pong(pong) => tungstenite::Message::Pong(pong),
            Self::Close(Some(close)) => {
                tungstenite::Message::Close(Some(tungstenite::protocol::CloseFrame {
                    code: tungstenite::protocol::frame::coding::CloseCode::from(close.code.0),
                    reason: close.reason.0,
                }))
            }
            Self::Close(None) => tungstenite::Message::Close(None),
        }
    }

    /// Converts a `tungstenite::Message` into an `Option<Message>`.
    ///
    /// This method transforms a given `tungstenite::Message` into its corresponding
    /// `Message` representation. This is useful when you need to convert messages
    /// received from the `tungstenite` library into the `Message` type used by this
    /// library.
    ///
    /// # Arguments
    ///
    /// * `message` - The `tungstenite::Message` to convert.
    ///
    /// # Returns
    ///
    /// An `Option<Message>` instance that represents the given `tungstenite::Message`.
    /// Returns `None` if the message is a `Frame` frame, as recommended by the
    /// `tungstenite` maintainers.
    pub(super) fn from_tungstenite(message: tungstenite::Message) -> Option<Self> {
        match message {
            tungstenite::Message::Text(text) => Some(Self::Text(Utf8Bytes(text))),
            tungstenite::Message::Binary(binary) => Some(Self::Binary(binary)),
            tungstenite::Message::Ping(ping) => Some(Self::Ping(ping)),
            tungstenite::Message::Pong(pong) => Some(Self::Pong(pong)),
            tungstenite::Message::Close(Some(close)) => Some(Self::Close(Some(CloseFrame {
                code: CloseCode(close.code.into()),
                reason: Utf8Bytes(close.reason),
            }))),
            tungstenite::Message::Close(None) => Some(Self::Close(None)),
            // we can ignore `Frame` frames as recommended by the tungstenite maintainers
            // https://github.com/snapview/tungstenite-rs/issues/268
            tungstenite::Message::Frame(_) => None,
        }
    }

    /// Consume the WebSocket and return it as binary data.
    pub fn into_data(self) -> Bytes {
        match self {
            Self::Text(string) => Bytes::from(string),
            Self::Binary(data) | Self::Ping(data) | Self::Pong(data) => data,
            Self::Close(None) => Bytes::new(),
            Self::Close(Some(frame)) => Bytes::from(frame.reason),
        }
    }

    /// Attempt to consume the WebSocket message and convert it to a Utf8Bytes.
    pub fn into_text(self) -> crate::Result<Utf8Bytes> {
        match self {
            Self::Text(string) => Ok(string),
            Self::Binary(data) | Self::Ping(data) | Self::Pong(data) => {
                Utf8Bytes::try_from(data).map_err(Error::decode)
            }
            Self::Close(None) => Ok(Utf8Bytes::default()),
            Self::Close(Some(frame)) => Ok(frame.reason),
        }
    }

    /// Attempt to get a &str from the WebSocket message,
    /// this will try to convert binary data to utf8.
    pub fn to_text(&self) -> crate::Result<&str> {
        match *self {
            Self::Text(ref string) => Ok(string.as_str()),
            Self::Binary(ref data) | Self::Ping(ref data) | Self::Pong(ref data) => {
                std::str::from_utf8(data).map_err(Error::decode)
            }
            Self::Close(None) => Ok(""),
            Self::Close(Some(ref frame)) => Ok(&frame.reason),
        }
    }
}

impl Message {
    /// Create a new text WebSocket message from a stringable.
    pub fn text<S>(string: S) -> Message
    where
        S: Into<Utf8Bytes>,
    {
        Message::Text(string.into())
    }

    /// Create a new binary WebSocket message by converting to `Bytes`.
    pub fn binary<B>(bin: B) -> Message
    where
        B: Into<Bytes>,
    {
        Message::Binary(bin.into())
    }

    /// Create a new ping WebSocket message by converting to `Bytes`.
    pub fn ping<B>(bin: B) -> Message
    where
        B: Into<Bytes>,
    {
        Message::Ping(bin.into())
    }

    /// Create a new pong WebSocket message by converting to `Bytes`.
    pub fn pong<B>(bin: B) -> Message
    where
        B: Into<Bytes>,
    {
        Message::Pong(bin.into())
    }

    /// Create a new close WebSocket message with an optional close frame.
    pub fn close<C>(close: C) -> Message
    where
        C: Into<Option<CloseFrame>>,
    {
        Message::Close(close.into())
    }
}

impl From<String> for Message {
    fn from(string: String) -> Self {
        Message::Text(string.into())
    }
}

impl<'s> From<&'s str> for Message {
    fn from(string: &'s str) -> Self {
        Message::Text(string.into())
    }
}

impl<'b> From<&'b [u8]> for Message {
    fn from(data: &'b [u8]) -> Self {
        Message::Binary(Bytes::copy_from_slice(data))
    }
}

impl From<Vec<u8>> for Message {
    fn from(data: Vec<u8>) -> Self {
        Message::Binary(data.into())
    }
}

impl From<Message> for Vec<u8> {
    fn from(msg: Message) -> Self {
        msg.into_data().to_vec()
    }
}
