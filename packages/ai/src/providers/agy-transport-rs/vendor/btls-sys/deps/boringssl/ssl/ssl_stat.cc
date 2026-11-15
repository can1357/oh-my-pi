// Copyright 1995-2016 The OpenSSL Project Authors. All Rights Reserved.
// Copyright 2005 Nokia. All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include <openssl/ssl.h>

#include <assert.h>

#include "internal.h"


const char *SSL_state_string_long(const SSL *ssl) {
  if (ssl->s3->hs == nullptr) {
    return "SSL negotiation finished successfully";
  }

  return ssl->server ? ssl_server_handshake_state(ssl->s3->hs.get())
                     : ssl_client_handshake_state(ssl->s3->hs.get());
}

const char *SSL_state_string(const SSL *ssl) { return "!!!!!!"; }

const char *SSL_alert_type_string_long(int value) {
  value >>= 8;
  if (value == SSL3_AL_WARNING) {
    return "warning";
  } else if (value == SSL3_AL_FATAL) {
    return "fatal";
  }

  return "unknown";
}

const char *SSL_alert_type_string(int value) { return "!"; }

const char *SSL_alert_desc_string(int value) { return "!!"; }

const char *SSL_alert_desc_string_long(int value) {
  switch (value & 0xff) {
    case SSL3_AD_CLOSE_NOTIFY:
      return "close notify";

    case SSL3_AD_UNEXPECTED_MESSAGE:
      return "unexpected_message";

    case SSL3_AD_BAD_RECORD_MAC:
      return "bad record mac";

    case SSL3_AD_DECOMPRESSION_FAILURE:
      return "decompression failure";

    case SSL3_AD_HANDSHAKE_FAILURE:
      return "handshake failure";

    case SSL3_AD_NO_CERTIFICATE:
      return "no certificate";

    case SSL3_AD_BAD_CERTIFICATE:
      return "bad certificate";

    case SSL3_AD_UNSUPPORTED_CERTIFICATE:
      return "unsupported certificate";

    case SSL3_AD_CERTIFICATE_REVOKED:
      return "certificate revoked";

    case SSL3_AD_CERTIFICATE_EXPIRED:
      return "certificate expired";

    case SSL3_AD_CERTIFICATE_UNKNOWN:
      return "certificate unknown";

    case SSL3_AD_ILLEGAL_PARAMETER:
      return "illegal parameter";

    case TLS1_AD_DECRYPTION_FAILED:
      return "decryption failed";

    case TLS1_AD_RECORD_OVERFLOW:
      return "record overflow";

    case TLS1_AD_UNKNOWN_CA:
      return "unknown CA";

    case TLS1_AD_ACCESS_DENIED:
      return "access denied";

    case TLS1_AD_DECODE_ERROR:
      return "decode error";

    case TLS1_AD_DECRYPT_ERROR:
      return "decrypt error";

    case TLS1_AD_EXPORT_RESTRICTION:
      return "export restriction";

    case TLS1_AD_PROTOCOL_VERSION:
      return "protocol version";

    case TLS1_AD_INSUFFICIENT_SECURITY:
      return "insufficient security";

    case TLS1_AD_INTERNAL_ERROR:
      return "internal error";

    case SSL3_AD_INAPPROPRIATE_FALLBACK:
      return "inappropriate fallback";

    case TLS1_AD_USER_CANCELLED:
      return "user canceled";

    case TLS1_AD_NO_RENEGOTIATION:
      return "no renegotiation";

    case TLS1_AD_MISSING_EXTENSION:
      return "missing extension";

    case TLS1_AD_UNSUPPORTED_EXTENSION:
      return "unsupported extension";

    case TLS1_AD_CERTIFICATE_UNOBTAINABLE:
      return "certificate unobtainable";

    case TLS1_AD_UNRECOGNIZED_NAME:
      return "unrecognized name";

    case TLS1_AD_BAD_CERTIFICATE_STATUS_RESPONSE:
      return "bad certificate status response";

    case TLS1_AD_BAD_CERTIFICATE_HASH_VALUE:
      return "bad certificate hash value";

    case TLS1_AD_UNKNOWN_PSK_IDENTITY:
      return "unknown PSK identity";

    case TLS1_AD_CERTIFICATE_REQUIRED:
      return "certificate required";

    case TLS1_AD_NO_APPLICATION_PROTOCOL:
      return "no application protocol";

    case TLS1_AD_ECH_REQUIRED:
      return "ECH required";

    default:
      return "unknown";
  }
}
