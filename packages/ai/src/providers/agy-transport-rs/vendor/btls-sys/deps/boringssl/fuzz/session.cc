// Copyright 2016 The BoringSSL Authors
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

#include <stdio.h>

#include <openssl/mem.h>
#include <openssl/ssl.h>

struct GlobalState {
  GlobalState() : ctx(SSL_CTX_new(TLS_method())) {}

  bssl::UniquePtr<SSL_CTX> ctx;
};

static GlobalState g_state;

extern "C" int LLVMFuzzerTestOneInput(const uint8_t *buf, size_t len) {
  // Parse in our session.
  bssl::UniquePtr<SSL_SESSION> session(
      SSL_SESSION_from_bytes(buf, len, g_state.ctx.get()));

  // If the format was invalid, just return.
  if (!session) {
    return 0;
  }

  // Stress the encoder.
  size_t encoded_len;
  uint8_t *encoded;
  if (!SSL_SESSION_to_bytes(session.get(), &encoded, &encoded_len)) {
    fprintf(stderr, "SSL_SESSION_to_bytes failed.\n");
    return 1;
  }

  OPENSSL_free(encoded);
  return 0;
}
