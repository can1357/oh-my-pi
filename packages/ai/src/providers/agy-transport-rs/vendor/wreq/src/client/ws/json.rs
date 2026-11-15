use serde::{Serialize, de::DeserializeOwned};

use super::{Message, Utf8Bytes};
use crate::Error;

impl Message {
    /// Tries to serialize the JSON as a [`Message::Text`].
    ///
    /// # Optional
    ///
    /// This requires the optional `json` feature enabled.
    ///
    /// # Errors
    ///
    /// Serialization can fail if `T`'s implementation of `Serialize` decides to
    /// fail, or if `T` contains a map with non-string keys.
    #[cfg_attr(docsrs, doc(cfg(feature = "json")))]
    pub fn text_from_json<T: Serialize + ?Sized>(json: &T) -> crate::Result<Self> {
        serde_json::to_string(json)
            .map(Utf8Bytes::from)
            .map(Message::Text)
            .map_err(Error::decode)
    }

    /// Tries to serialize the JSON as a [`Message::Binary`].
    ///
    /// # Optional
    ///
    /// This requires that the optional `json` feature is enabled.
    ///
    /// # Errors
    ///
    /// Serialization can fail if `T`'s implementation of `Serialize` decides to
    /// fail, or if `T` contains a map with non-string keys.
    #[cfg_attr(docsrs, doc(cfg(feature = "json")))]
    pub fn binary_from_json<T: Serialize + ?Sized>(json: &T) -> crate::Result<Self> {
        serde_json::to_vec(json)
            .map(bytes::Bytes::from)
            .map(Message::Binary)
            .map_err(Error::decode)
    }

    /// Tries to deserialize the message body as JSON.
    ///
    /// # Optional
    ///
    /// This requires that the optional `json` feature is enabled.
    ///
    /// # Errors
    ///
    /// This method fails whenever the response body is not in `JSON` format,
    /// or it cannot be properly deserialized to target type `T`.
    ///
    /// For more details please see [`serde_json::from_str`] and
    /// [`serde_json::from_slice`].
    #[cfg_attr(docsrs, doc(cfg(feature = "json")))]
    pub fn json<T: DeserializeOwned>(&self) -> crate::Result<T> {
        use serde::de::Error as _;
        match self {
            Self::Text(x) => serde_json::from_str(x).map_err(Error::decode),
            Self::Binary(x) => serde_json::from_slice(x).map_err(Error::decode),
            Self::Ping(_) | Self::Pong(_) | Self::Close { .. } => Err(Error::decode(
                serde_json::Error::custom("neither text nor binary"),
            )),
        }
    }
}

#[cfg(test)]
mod test {
    use serde::{Deserialize, Serialize};

    use super::Message;

    #[derive(Default, Serialize, Deserialize)]
    struct Content {
        message: String,
    }

    #[test]
    pub fn text_json() -> crate::Result<()> {
        let content = Content::default();
        let message = Message::text_from_json(&content)?;
        assert!(matches!(message, Message::Text(_)));
        let _: Content = message.json()?;

        Ok(())
    }

    #[test]
    pub fn binary_json() -> crate::Result<()> {
        let content = Content::default();
        let message = Message::binary_from_json(&content)?;
        assert!(matches!(message, Message::Binary(_)));
        let _: Content = message.json()?;

        Ok(())
    }
}
