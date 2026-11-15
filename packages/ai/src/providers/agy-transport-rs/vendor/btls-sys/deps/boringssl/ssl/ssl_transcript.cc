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

#include <string_view>

#include <openssl/buf.h>
#include <openssl/digest.h>
#include <openssl/err.h>

#include "internal.h"


BSSL_NAMESPACE_BEGIN

SSLTranscript::SSLTranscript(bool is_dtls) : is_dtls_(is_dtls) {}

SSLTranscript::~SSLTranscript() {}

bool SSLTranscript::Init() {
  buffer_.reset(BUF_MEM_new());
  if (!buffer_) {
    return false;
  }

  hash_.Reset();
  return true;
}

bool SSLTranscript::InitHash(uint16_t version, const SSL_CIPHER *cipher) {
  version_ = version;
  const EVP_MD *md = ssl_get_handshake_digest(version, cipher);
  if (Digest() == md) {
    // No need to re-hash the buffer.
    return true;
  }
  if (!HashBuffer(hash_.get(), md)) {
    return false;
  }
  if (is_dtls_ && version_ >= TLS1_3_VERSION) {
    // In DTLS 1.3, prior to the call to InitHash, the message (if present) in
    // the buffer has the DTLS 1.2 header. After the call to InitHash, the TLS
    // 1.3 header is written by SSLTranscript::Update. If the buffer isn't freed
    // here, it would have a mix of different header formats and using it would
    // yield wrong results. However, there's no need for the buffer once the
    // version and the digest for the cipher suite are known, so the buffer is
    // freed here to avoid potential misuse of the SSLTranscript object.
    FreeBuffer();
  }
  return true;
}

bool SSLTranscript::HashBuffer(EVP_MD_CTX *ctx, const EVP_MD *digest) const {
  if (!EVP_DigestInit_ex(ctx, digest, nullptr)) {
    return false;
  }
  if (!is_dtls_ || version_ < TLS1_3_VERSION) {
    return EVP_DigestUpdate(ctx, buffer_->data, buffer_->length);
  }

  // If the version is DTLS 1.3 and we still have a buffer, then there should be
  // at most a single DTLSHandshake message in the buffer, for the ClientHello.
  // On the server side, the version (DTLS 1.3) and cipher suite are chosen in
  // response to the first ClientHello, and InitHash is called before that
  // ClientHello is added to the SSLTranscript, so the buffer is empty if this
  // SSLTranscript is on the server.
  if (buffer_->length == 0) {
    return true;
  }

  // On the client side, we can receive either a ServerHello or
  // HelloRetryRequest in response to the ClientHello. Regardless of which
  // message we receive, the client code calls InitHash before updating the
  // transcript with that message, so the ClientHello is the only message in the
  // buffer. In DTLS 1.3, we need to skip the message_seq, fragment_offset, and
  // fragment_length fields from the DTLSHandshake message in the buffer. The
  // structure of a DTLSHandshake message is as follows (RFC 9147, section 5.2):
  //
  //   struct {
  //       HandshakeType msg_type;    /* handshake type */
  //       uint24 length;             /* bytes in message */
  //       uint16 message_seq;        /* DTLS-required field */
  //       uint24 fragment_offset;    /* DTLS-required field */
  //       uint24 fragment_length;    /* DTLS-required field */
  //       select (msg_type) {
  //         /* omitted for brevity */
  //       } body;
  //   } DTLSHandshake;
  CBS buf, header;
  CBS_init(&buf, reinterpret_cast<uint8_t *>(buffer_->data), buffer_->length);
  if (!CBS_get_bytes(&buf, &header, 4) ||                             //
      !CBS_skip(&buf, 8) ||                                           //
      !EVP_DigestUpdate(ctx, CBS_data(&header), CBS_len(&header)) ||  //
      !EVP_DigestUpdate(ctx, CBS_data(&buf), CBS_len(&buf))) {
    return false;
  }
  return true;
}

void SSLTranscript::FreeBuffer() { buffer_.reset(); }

size_t SSLTranscript::DigestLen() const { return EVP_MD_size(Digest()); }

const EVP_MD *SSLTranscript::Digest() const {
  return EVP_MD_CTX_get0_md(hash_.get());
}

bool SSLTranscript::UpdateForHelloRetryRequest() {
  if (buffer_) {
    buffer_->length = 0;
  }

  uint8_t old_hash[EVP_MAX_MD_SIZE];
  size_t hash_len;
  if (!GetHash(old_hash, &hash_len)) {
    return false;
  }
  const uint8_t header[4] = {SSL3_MT_MESSAGE_HASH, 0, 0,
                             static_cast<uint8_t>(hash_len)};
  if (!EVP_DigestInit_ex(hash_.get(), Digest(), nullptr) ||
      !AddToBufferOrHash(header) ||
      !AddToBufferOrHash(Span(old_hash, hash_len))) {
    return false;
  }
  return true;
}

bool SSLTranscript::CopyToHashContext(EVP_MD_CTX *ctx,
                                      const EVP_MD *digest) const {
  const EVP_MD *transcript_digest = Digest();
  if (transcript_digest != nullptr &&
      EVP_MD_type(transcript_digest) == EVP_MD_type(digest)) {
    return EVP_MD_CTX_copy_ex(ctx, hash_.get());
  }

  if (buffer_) {
    return HashBuffer(ctx, digest);
  }

  OPENSSL_PUT_ERROR(SSL, ERR_R_INTERNAL_ERROR);
  return false;
}

bool SSLTranscript::Update(Span<const uint8_t> in) {
  if (!is_dtls_ || version_ < TLS1_3_VERSION) {
    return AddToBufferOrHash(in);
  }
  if (in.size() < DTLS1_HM_HEADER_LENGTH) {
    return false;
  }
  // The message passed into Update is the whole Handshake or DTLSHandshake
  // message, including the msg_type and length. In DTLS, the DTLSHandshake
  // message also has message_seq, fragment_offset, and fragment_length
  // fields. In DTLS 1.3, those fields are omitted so that the same
  // transcript format as TLS 1.3 is used. This means we write the 1-byte
  // msg_type, 3-byte length, then skip 2+3+3 bytes for the DTLS-specific
  // fields that get omitted.
  if (!AddToBufferOrHash(in.first<4>()) ||
      !AddToBufferOrHash(in.subspan<12>())) {
    return false;
  }
  return true;
}

bool SSLTranscript::AddToBufferOrHash(Span<const uint8_t> in) {
  // Depending on the state of the handshake, either the handshake buffer may be
  // active, the rolling hash, or both.
  if (buffer_ &&  //
      !BUF_MEM_append(buffer_.get(), in.data(), in.size())) {
    return false;
  }

  if (EVP_MD_CTX_md(hash_.get()) != nullptr) {
    EVP_DigestUpdate(hash_.get(), in.data(), in.size());
  }

  return true;
}

bool SSLTranscript::GetHash(uint8_t *out, size_t *out_len) const {
  ScopedEVP_MD_CTX ctx;
  unsigned len;
  if (!EVP_MD_CTX_copy_ex(ctx.get(), hash_.get()) ||
      !EVP_DigestFinal_ex(ctx.get(), out, &len)) {
    return false;
  }
  *out_len = len;
  return true;
}

bool SSLTranscript::GetFinishedMAC(uint8_t *out, size_t *out_len,
                                   const SSL_SESSION *session,
                                   bool from_server) const {
  uint8_t digest[EVP_MAX_MD_SIZE];
  size_t digest_len;
  if (!GetHash(digest, &digest_len)) {
    return false;
  }

  std::string_view label = from_server ? "server finished" : "client finished";
  static const size_t kFinishedLen = 12;
  if (!tls1_prf(Digest(), Span(out, kFinishedLen), session->secret, label,
                Span(digest, digest_len), {})) {
    return false;
  }

  *out_len = kFinishedLen;
  return true;
}

BSSL_NAMESPACE_END
