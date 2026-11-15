// Copyright 2021 The BoringSSL Authors
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

#include <openssl/bytestring.h>
#include <openssl/ssl.h>
#include <openssl/span.h>

#include "../ssl/internal.h"


extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  static bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  static bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));

  CBS reader(bssl::Span(buf, len));
  CBS encoded_client_hello_inner_cbs;

  if (!CBS_get_u24_length_prefixed(&reader, &encoded_client_hello_inner_cbs)) {
    return 0;
  }

  bssl::Array<uint8_t> encoded_client_hello_inner;
  if (!encoded_client_hello_inner.CopyFrom(encoded_client_hello_inner_cbs)) {
    return 0;
  }

  // Use the remaining bytes in |reader| as the ClientHelloOuter.
  SSL_CLIENT_HELLO client_hello_outer;
  if (!SSL_parse_client_hello(ssl.get(), &client_hello_outer, CBS_data(&reader),
                              CBS_len(&reader))) {
    return 0;
  }

  // Recover the ClientHelloInner from the EncodedClientHelloInner and
  // ClientHelloOuter.
  uint8_t alert_unused;
  bssl::Array<uint8_t> client_hello_inner;
  bssl::ssl_decode_client_hello_inner(
      ssl.get(), &alert_unused, &client_hello_inner, encoded_client_hello_inner,
      &client_hello_outer);
  return 0;
}
