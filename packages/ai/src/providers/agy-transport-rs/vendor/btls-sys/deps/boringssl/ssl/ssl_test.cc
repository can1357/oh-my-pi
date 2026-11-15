// Copyright 2014 The BoringSSL Authors
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

#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#include <algorithm>
#include <iterator>
#include <limits>
#include <string>
#include <utility>
#include <vector>

#include <gmock/gmock.h>
#include <gtest/gtest.h>

#include <openssl/aead.h>
#include <openssl/base64.h>
#include <openssl/bio.h>
#include <openssl/bytestring.h>
#include <openssl/cipher.h>
#include <openssl/crypto.h>
#include <openssl/curve25519.h>
#include <openssl/err.h>
#include <openssl/hmac.h>
#include <openssl/hpke.h>
#include <openssl/pem.h>
#include <openssl/rand.h>
#include <openssl/sha.h>
#include <openssl/ssl.h>
#include <openssl/x509.h>

#include "../crypto/internal.h"
#include "../crypto/test/file_util.h"
#include "../crypto/test/test_util.h"
#include "internal.h"

#if defined(OPENSSL_WINDOWS)
// Windows defines struct timeval in winsock2.h.
#include <winsock2.h>
#else
#include <sys/time.h>
#endif

#if defined(OPENSSL_THREADS)
#include <thread>
#endif


using testing::ElementsAre;
using testing::ElementsAreArray;
using testing::Key;
using testing::Not;

BSSL_NAMESPACE_BEGIN

namespace {

#define TRACED_CALL(code)                     \
  do {                                        \
    SCOPED_TRACE("<- called from here");      \
    code;                                     \
    if (::testing::Test::HasFatalFailure()) { \
      return;                                 \
    }                                         \
  } while (false)

struct VersionParam {
  uint16_t version;
  enum { is_tls, is_dtls } ssl_method;
  const char name[8];
};

static const size_t kTicketKeyLen = 48;

static const VersionParam kAllVersions[] = {
    {TLS1_VERSION, VersionParam::is_tls, "TLS1"},
    {TLS1_1_VERSION, VersionParam::is_tls, "TLS1_1"},
    {TLS1_2_VERSION, VersionParam::is_tls, "TLS1_2"},
    {TLS1_3_VERSION, VersionParam::is_tls, "TLS1_3"},
    {DTLS1_VERSION, VersionParam::is_dtls, "DTLS1"},
    {DTLS1_2_VERSION, VersionParam::is_dtls, "DTLS1_2"},
    {DTLS1_3_VERSION, VersionParam::is_dtls, "DTLS1_3"},
};

struct ExpectedCipher {
  uint16_t protocol_id;
  int in_group_flag;
};

struct CipherTest {
  // The rule string to apply.
  const char *rule;
  // The list of expected ciphers, in order.
  std::vector<ExpectedCipher> expected;
  // True if this cipher list should fail in strict mode.
  bool strict_fail;
};

struct CurveTest {
  // The rule string to apply.
  const char *rule;
  // The list of expected curves, in order.
  std::vector<uint16_t> expected;
};

template <typename T>
class UnownedSSLExData {
 public:
  UnownedSSLExData() {
    index_ = SSL_get_ex_new_index(0, nullptr, nullptr, nullptr, nullptr);
  }

  T *Get(const SSL *ssl) {
    return index_ < 0 ? nullptr
                      : static_cast<T *>(SSL_get_ex_data(ssl, index_));
  }

  bool Set(SSL *ssl, T *t) {
    return index_ >= 0 && SSL_set_ex_data(ssl, index_, t);
  }

 private:
  int index_;
};

static timeval g_current_time;

static void CurrentTimeCallback(const SSL *ssl, timeval *out_clock) {
  *out_clock = g_current_time;
}

static void FrozenTimeCallback(const SSL *ssl, timeval *out_clock) {
  out_clock->tv_sec = 1000;
  out_clock->tv_usec = 0;
}

static const CipherTest kCipherTests[] = {
    // Selecting individual ciphers should work.
    {
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // + reorders selected ciphers to the end, keeping their relative order.
    {
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "+aRSA",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // ! banishes ciphers from future selections.
    {
        "!aRSA:"
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // Multiple masks can be ANDed in a single rule.
    {
        "kRSA+AESGCM+AES128",
        {
            {SSL_CIPHER_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // - removes selected ciphers, but preserves their order for future
    // selections. Select AES_128_GCM, but order the key exchanges RSA,
    // ECDHE_RSA.
    {
        "ALL:-kECDHE:"
        "-kRSA:-ALL:"
        "AESGCM+AES128+aRSA",
        {
            {SSL_CIPHER_RSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // Unknown selectors are no-ops, except in strict mode.
    {
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "BOGUS1",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        true,
    },
    // Unknown selectors are no-ops, except in strict mode.
    {
        "ECDHE-ECDSA-CHACHA20-POLY1305:"
        "ECDHE-RSA-CHACHA20-POLY1305:"
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "-BOGUS2:+BOGUS3:!BOGUS4",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        true,
    },
    // Square brackets specify equi-preference groups.
    {
        "[ECDHE-ECDSA-CHACHA20-POLY1305|ECDHE-ECDSA-AES128-GCM-SHA256]:"
        "[ECDHE-RSA-CHACHA20-POLY1305]:"
        "ECDHE-RSA-AES128-GCM-SHA256",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 1},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // Standard names may be used instead of OpenSSL names.
    {
        "[TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256|"
        "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256]:"
        "[TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256]:"
        "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, 1},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // @STRENGTH performs a stable strength-sort of the selected ciphers and
    // only the selected ciphers.
    {
        // To simplify things, banish all but {ECDHE_RSA,RSA} x
        // {CHACHA20,AES_256_CBC,AES_128_CBC} x SHA1.
        "!AESGCM:!3DES:"
        // Order some ciphers backwards by strength.
        "ALL:-CHACHA20:-AES256:-AES128:-ALL:"
        // Select ECDHE ones and sort them by strength. Ties should resolve
        // based on the order above.
        "kECDHE:@STRENGTH:-ALL:"
        // Now bring back everything uses RSA. ECDHE_RSA should be first, sorted
        // by strength. Then RSA, backwards by strength.
        "aRSA",
        {
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_256_CBC_SHA, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_CBC_SHA, 0},
            {SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA, 0},
            {SSL_CIPHER_RSA_WITH_AES_256_CBC_SHA, 0},
        },
        false,
    },
    // Additional masks after @STRENGTH get silently discarded.
    //
    // TODO(davidben): Make this an error. If not silently discarded, they get
    // interpreted as + opcodes which are very different.
    {
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES256-GCM-SHA384:"
        "@STRENGTH+AES256",
        {
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_256_GCM_SHA384, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    {
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES256-GCM-SHA384:"
        "@STRENGTH+AES256:"
        "ECDHE-RSA-CHACHA20-POLY1305",
        {
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_256_GCM_SHA384, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, 0},
        },
        false,
    },
    // Exact ciphers may not be used in multi-part rules; they are treated
    // as unknown aliases.
    {
        "ECDHE-ECDSA-AES128-GCM-SHA256:"
        "ECDHE-RSA-AES128-GCM-SHA256:"
        "!ECDHE-RSA-AES128-GCM-SHA256+RSA:"
        "!ECDSA+ECDHE-ECDSA-AES128-GCM-SHA256",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        true,
    },
    // SSLv3 matches everything that existed before TLS 1.2.
    {
        "AES128-SHA:ECDHE-RSA-AES128-GCM-SHA256:!SSLv3",
        {
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // TLSv1.2 matches everything added in TLS 1.2.
    {
        "AES128-SHA:ECDHE-RSA-AES128-GCM-SHA256:!TLSv1.2",
        {
            {SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA, 0},
        },
        false,
    },
    // The two directives have no intersection.  But each component is valid, so
    // even in strict mode it is accepted.
    {
        "AES128-SHA:ECDHE-RSA-AES128-GCM-SHA256:!TLSv1.2+SSLv3",
        {
            {SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // Spaces, semi-colons and commas are separators.
    {
        "AES128-SHA: ECDHE-RSA-AES128-GCM-SHA256 AES256-SHA "
        ",ECDHE-ECDSA-AES128-GCM-SHA256 ; AES128-GCM-SHA256",
        {
            {SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA, 0},
            {SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_RSA_WITH_AES_256_CBC_SHA, 0},
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_RSA_WITH_AES_128_GCM_SHA256, 0},
        },
        // …but not in strict mode.
        true,
    },
    // 3DES ciphers are disabled by default.
    {
        "RSA",
        {
            {SSL_CIPHER_RSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_RSA_WITH_AES_256_GCM_SHA384, 0},
            {SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA, 0},
            {SSL_CIPHER_RSA_WITH_AES_256_CBC_SHA, 0},
        },
        false,
    },
    // But 3DES ciphers may be specified by name.
    {
        "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
        {
            {SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA, 0},
        },
        false,
    },
    {
        "DES-CBC3-SHA",
        {
            {SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA, 0},
        },
        false,
    },
    // Or by a selector that specifically includes deprecated ciphers.
    {
        "3DES",
        {
            {SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA, 0},
        },
        false,
    },
    // Such selectors may be combined with other selectors that would otherwise
    // not allow deprecated ciphers.
    {
        "RSA+3DES",
        {
            {SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA, 0},
        },
        false,
    },
    // The cipher must still match all combined selectors, however. "ECDHE+3DES"
    // matches nothing because we do not implement
    // TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA. (The test includes
    // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 so the final list is not empty.)
    {
        "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:ECDHE+3DES",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // Although aliases like "RSA" do not match 3DES when adding ciphers, they do
    // match it when removing ciphers.
    {
        "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256:RSA:RSA+3DES:!RSA",
        {
            {SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, 0},
        },
        false,
    },
    // 3DES still participates in strength sorting.
    {
        "RSA:3DES:@STRENGTH",
        {
            {SSL_CIPHER_RSA_WITH_AES_256_GCM_SHA384, 0},
            {SSL_CIPHER_RSA_WITH_AES_256_CBC_SHA, 0},
            {SSL_CIPHER_RSA_WITH_AES_128_GCM_SHA256, 0},
            {SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA, 0},
            {SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA, 0},
        },
        false,
    },
};

static const char *kBadRules[] = {
    // Invalid brackets.
    "[ECDHE-RSA-CHACHA20-POLY1305|ECDHE-RSA-AES128-GCM-SHA256",
    "RSA]",
    "[[RSA]]",
    // Operators inside brackets.
    "[+RSA]",
    // Unknown directive.
    "@BOGUS",
    // Empty cipher lists error at SSL_CTX_set_cipher_list.
    "",
    "BOGUS",
    // COMPLEMENTOFDEFAULT is empty.
    "COMPLEMENTOFDEFAULT",
    // Invalid command.
    "?BAR",
    // Special operators are not allowed if equi-preference groups are used.
    "[ECDHE-RSA-CHACHA20-POLY1305|ECDHE-RSA-AES128-GCM-SHA256]:+FOO",
    "[ECDHE-RSA-CHACHA20-POLY1305|ECDHE-RSA-AES128-GCM-SHA256]:!FOO",
    "[ECDHE-RSA-CHACHA20-POLY1305|ECDHE-RSA-AES128-GCM-SHA256]:-FOO",
    "[ECDHE-RSA-CHACHA20-POLY1305|ECDHE-RSA-AES128-GCM-SHA256]:@STRENGTH",
    // Opcode supplied, but missing selector.
    "+",
    // Spaces are forbidden in equal-preference groups.
    "[AES128-SHA | AES128-SHA256]",
};

static const char *kMustNotIncludeDeprecated[] = {
    "ALL",  "DEFAULT", "HIGH",  "FIPS",  "SHA",
    "SHA1", "RSA",     "SSLv3", "TLSv1", "TLSv1.2",
};

static const char *kShouldIncludeCBCSHA256[] = {
    "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256",
    "ALL:TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256",
};

static const CurveTest kCurveTests[] = {
    {
        "P-256",
        {SSL_GROUP_SECP256R1},
    },
    {
        "P-256:X25519Kyber768Draft00",
        {SSL_GROUP_SECP256R1, SSL_GROUP_X25519_KYBER768_DRAFT00},
    },
    {
        "P-256:X25519MLKEM768",
        {SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
    },
    {
        "P-256:MLKEM1024",
        {SSL_GROUP_SECP256R1, SSL_GROUP_MLKEM1024},
    },
    {
        "MLKEM1024:X25519MLKEM768",
        {SSL_GROUP_MLKEM1024, SSL_GROUP_X25519_MLKEM768},
    },

    {
        "P-256:P-384:P-521:X25519",
        {
            SSL_GROUP_SECP256R1,
            SSL_GROUP_SECP384R1,
            SSL_GROUP_SECP521R1,
            SSL_GROUP_X25519,
        },
    },
    {
        "prime256v1:secp384r1:secp521r1:x25519",
        {
            SSL_GROUP_SECP256R1,
            SSL_GROUP_SECP384R1,
            SSL_GROUP_SECP521R1,
            SSL_GROUP_X25519,
        },
    },
};

static const char *kBadCurvesLists[] = {
    "",
    ":",
    "::",
    "P-256::X25519",
    "RSA:P-256",
    "P-256:RSA",
    "X25519:P-256:",
    ":X25519:P-256",
    "X25519:X25519",
};

static std::string CipherListToString(SSL_CTX *ctx) {
  bool in_group = false;
  std::string ret;
  const STACK_OF(SSL_CIPHER) *ciphers = SSL_CTX_get_ciphers(ctx);
  for (size_t i = 0; i < sk_SSL_CIPHER_num(ciphers); i++) {
    const SSL_CIPHER *cipher = sk_SSL_CIPHER_value(ciphers, i);
    if (!in_group && SSL_CTX_cipher_in_group(ctx, i)) {
      ret += "\t[\n";
      in_group = true;
    }
    ret += "\t";
    if (in_group) {
      ret += "  ";
    }
    ret += SSL_CIPHER_get_name(cipher);
    ret += "\n";
    if (in_group && !SSL_CTX_cipher_in_group(ctx, i)) {
      ret += "\t]\n";
      in_group = false;
    }
  }
  return ret;
}

static bool CipherListsEqual(SSL_CTX *ctx,
                             const std::vector<ExpectedCipher> &expected) {
  const STACK_OF(SSL_CIPHER) *ciphers = SSL_CTX_get_ciphers(ctx);
  if (sk_SSL_CIPHER_num(ciphers) != expected.size()) {
    return false;
  }

  for (size_t i = 0; i < expected.size(); i++) {
    const SSL_CIPHER *cipher = sk_SSL_CIPHER_value(ciphers, i);
    if (expected[i].protocol_id != SSL_CIPHER_get_protocol_id(cipher) ||
        expected[i].in_group_flag != !!SSL_CTX_cipher_in_group(ctx, i)) {
      return false;
    }
  }

  return true;
}

TEST(SSLTest, CipherRules) {
  for (const CipherTest &t : kCipherTests) {
    SCOPED_TRACE(t.rule);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);

    // Test lax mode.
    ASSERT_TRUE(SSL_CTX_set_cipher_list(ctx.get(), t.rule));
    EXPECT_TRUE(CipherListsEqual(ctx.get(), t.expected))
        << "Cipher rule evaluated to:\n"
        << CipherListToString(ctx.get());

    // Test strict mode.
    if (t.strict_fail) {
      EXPECT_FALSE(SSL_CTX_set_strict_cipher_list(ctx.get(), t.rule));
    } else {
      ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(ctx.get(), t.rule));
      EXPECT_TRUE(CipherListsEqual(ctx.get(), t.expected))
          << "Cipher rule evaluated to:\n"
          << CipherListToString(ctx.get());
    }
  }

  for (const char *rule : kBadRules) {
    SCOPED_TRACE(rule);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);

    EXPECT_FALSE(SSL_CTX_set_cipher_list(ctx.get(), rule));
    ERR_clear_error();
  }

  for (const char *rule : kMustNotIncludeDeprecated) {
    SCOPED_TRACE(rule);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);

    ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(ctx.get(), rule));
    for (const SSL_CIPHER *cipher : SSL_CTX_get_ciphers(ctx.get())) {
      EXPECT_NE(NID_undef, SSL_CIPHER_get_cipher_nid(cipher));
      EXPECT_FALSE(ssl_cipher_is_deprecated(cipher));
    }
  }

  {
    for (const char *rule : kShouldIncludeCBCSHA256) {
      bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
      ASSERT_TRUE(ctx);
      ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(ctx.get(), rule));

      bool found = false;
      for (const SSL_CIPHER *cipher : SSL_CTX_get_ciphers(ctx.get())) {
        if (SSL_CIPHER_ECDHE_RSA_WITH_AES_128_CBC_SHA256 ==
            SSL_CIPHER_get_protocol_id(cipher)) {
          found = true;
          break;
        }
      }
      EXPECT_TRUE(found);
    }
  }
}

TEST(SSLTest, CurveRules) {
  for (const CurveTest &t : kCurveTests) {
    SCOPED_TRACE(t.rule);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);

    ASSERT_TRUE(SSL_CTX_set1_groups_list(ctx.get(), t.rule));
    ASSERT_EQ(t.expected.size(), ctx->supported_group_list.size());
    for (size_t i = 0; i < t.expected.size(); i++) {
      EXPECT_EQ(t.expected[i], ctx->supported_group_list[i]);
    }
  }

  for (const char *rule : kBadCurvesLists) {
    SCOPED_TRACE(rule);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);

    EXPECT_FALSE(SSL_CTX_set1_groups_list(ctx.get(), rule));
    ERR_clear_error();
  }
}

TEST(SSLTest, DefaultCurves) {
  const uint16_t kDefaults[] = {SSL_GROUP_X25519, SSL_GROUP_SECP256R1,
                                SSL_GROUP_SECP384R1};

  // Test the group ID APIs.
  {
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);
    // The new context is populated with the default group list.
    EXPECT_THAT(ctx->supported_group_list, ElementsAreArray(kDefaults));

    // Set some other list to check that it is set away from the default.
    const uint16_t kArbitraryGroupIds[] = {SSL_GROUP_X25519};
    ASSERT_TRUE(SSL_CTX_set1_group_ids(ctx.get(), kArbitraryGroupIds,
                                       std::size(kArbitraryGroupIds)));
    EXPECT_THAT(ctx->supported_group_list, Not(ElementsAreArray(kDefaults)));

    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    ASSERT_TRUE(ssl);
    EXPECT_THAT(ssl->config->supported_group_list,
                Not(ElementsAreArray(kDefaults)));

    // Setting an empty list restores the defaults.
    ASSERT_TRUE(SSL_set1_group_ids(ssl.get(), nullptr, 0));
    EXPECT_THAT(ssl->config->supported_group_list, ElementsAreArray(kDefaults));
    ASSERT_TRUE(SSL_CTX_set1_group_ids(ctx.get(), nullptr, 0));
    EXPECT_THAT(ctx->supported_group_list, ElementsAreArray(kDefaults));
  }

  // Test the NID APIs.
  {
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);
    // The new context is populated with the default group list.
    EXPECT_THAT(ctx->supported_group_list, ElementsAreArray(kDefaults));

    // Set some other list to check that it is set away from the default.
    const int kArbitraryNids[] = {NID_X9_62_prime256v1};
    ASSERT_TRUE(SSL_CTX_set1_groups(ctx.get(), kArbitraryNids,
                                    std::size(kArbitraryNids)));
    EXPECT_THAT(ctx->supported_group_list, Not(ElementsAreArray(kDefaults)));

    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    ASSERT_TRUE(ssl);
    EXPECT_THAT(ssl->config->supported_group_list,
                Not(ElementsAreArray(kDefaults)));

    // Setting an empty list restores the defaults.
    ASSERT_TRUE(SSL_set1_groups(ssl.get(), nullptr, 0));
    EXPECT_THAT(ssl->config->supported_group_list, ElementsAreArray(kDefaults));
    ASSERT_TRUE(SSL_CTX_set1_groups(ctx.get(), nullptr, 0));
    EXPECT_THAT(ctx->supported_group_list, ElementsAreArray(kDefaults));
  }
}

TEST(SSLTest, SetClientKeyShares) {
  const struct {
    const char *description;
    std::vector<uint16_t> supported_groups;
    std::vector<uint16_t> key_shares;
    bool expected_success;
  } kTests[] = {
      {
          "Empty key shares with default supported groups",
          {},
          {},
          true,
      },
      {
          "Empty key shares with custom supported groups",
          {SSL_GROUP_X25519, SSL_GROUP_X25519_MLKEM768},
          {},
          true,
      },
      {
          "One key share matching default supported groups",
          {},
          {SSL_GROUP_X25519},
          true,
      },
      {
          "One key share matching custom supported groups",
          {SSL_GROUP_X25519, SSL_GROUP_X25519_MLKEM768},
          {SSL_GROUP_X25519},
          true,
      },
      {
          "Key share not in supported default groups",
          {},
          {SSL_GROUP_MLKEM1024},
          false,
      },
      {
          "Key share not in supported custom groups",
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1},
          {SSL_GROUP_X25519_MLKEM768},
          false,
      },
      {
          "Multiple key shares, in correct order",
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
          {SSL_GROUP_X25519, SSL_GROUP_X25519_MLKEM768},
          true,
      },
      {
          "Multiple key shares, out of order",
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
          {SSL_GROUP_X25519_MLKEM768, SSL_GROUP_X25519},
          false,
      },
      {
          "More than two key shares",
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768,
           SSL_GROUP_MLKEM1024},
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
          true,
      },
      {
          "Key shares cover all supported groups",
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
          true,
      },
      {
          "Multiple key shares, not all valid",
          {SSL_GROUP_X25519, SSL_GROUP_X25519_MLKEM768},
          {SSL_GROUP_X25519, SSL_GROUP_SECP256R1, SSL_GROUP_X25519_MLKEM768},
          false,
      },
      {
          "Key shares contain duplicates",
          {},
          {SSL_GROUP_X25519, SSL_GROUP_X25519},
          false,
      },
  };

  for (const auto &t : kTests) {
    SCOPED_TRACE(t.description);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);
    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    ASSERT_TRUE(ssl);
    ASSERT_FALSE(ssl->config->client_key_share_selections.has_value());

    ASSERT_TRUE(SSL_set1_group_ids(ssl.get(), t.supported_groups.data(),
                                   t.supported_groups.size()));
    EXPECT_EQ(SSL_set1_client_key_shares(ssl.get(), t.key_shares.data(),
                                         t.key_shares.size()),
              t.expected_success);
    if (t.expected_success) {
      ASSERT_TRUE(ssl->config->client_key_share_selections.has_value());
      EXPECT_THAT(ssl->config->client_key_share_selections.value(),
                  ElementsAreArray(t.key_shares));
    }
  }
}

// Test the behavior that modifying the SSL's supported groups results in
// clearing the previously set client key shares, iff the supported groups
// become incompatible with the key shares.
TEST(SSLTest, ClientKeySharesResetAfterChangingGroups) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  ASSERT_FALSE(ssl->config->client_key_share_selections.has_value());

  // An initial groups list and key shares that are compatible.
  const uint16_t kGroups1[] = {SSL_GROUP_X25519_MLKEM768, SSL_GROUP_X25519};
  const uint16_t kKeyShares[] = {SSL_GROUP_X25519_MLKEM768, SSL_GROUP_X25519};
  ASSERT_TRUE(
      SSL_set1_group_ids(ssl.get(), kGroups1, std::size(kGroups1)));
  ASSERT_TRUE(SSL_set1_client_key_shares(ssl.get(), kKeyShares,
                                         std::size(kKeyShares)));
  ASSERT_TRUE(ssl->config->client_key_share_selections.has_value());
  EXPECT_EQ(ssl->config->client_key_share_selections->size(), 2u);

  // A new groups list that is still compatible with the previously set key
  // shares.
  const uint16_t kGroups2[] = {SSL_GROUP_MLKEM1024, SSL_GROUP_X25519_MLKEM768,
                               SSL_GROUP_X25519};
  ASSERT_TRUE(
      SSL_set1_group_ids(ssl.get(), kGroups2, std::size(kGroups2)));
  ASSERT_TRUE(ssl->config->client_key_share_selections.has_value());
  EXPECT_EQ(ssl->config->client_key_share_selections->size(), 2u);

  // A new groups list that is no longer compatible with the previously set key
  // shares.
  const uint16_t kGroups3[] = {SSL_GROUP_MLKEM1024, SSL_GROUP_X25519};
  ASSERT_TRUE(
      SSL_set1_group_ids(ssl.get(), kGroups3, std::size(kGroups3)));
  EXPECT_FALSE(ssl->config->client_key_share_selections.has_value());
}

TEST(SSLTest, ServerSupportedGroupsHint) {
  // List of client's supported groups used for these test cases.
  const uint16_t kSupportedGroups[] = {
      SSL_GROUP_X25519_MLKEM768,  //
      SSL_GROUP_MLKEM1024,        //
      SSL_GROUP_X25519,           //
      SSL_GROUP_SECP256R1,        //
  };

  // By default, the first post-quantum and first classical groups are chosen.
  std::vector<uint16_t> kDefaultKeyShares = {SSL_GROUP_X25519_MLKEM768,
                                             SSL_GROUP_X25519};

  const struct {
    const char *description;
    std::vector<uint16_t> server_hinted_groups;
    std::vector<uint16_t> expected_key_shares;
  } kTests[] = {
      {
          "Empty hint (defaults chosen)",
          {},
          kDefaultKeyShares,
      },
      {
          "Hint one group, supported by client",
          {SSL_GROUP_SECP256R1},
          {SSL_GROUP_SECP256R1},
      },
      {
          "Hint one group, not supported by client",
          {SSL_GROUP_X25519_KYBER768_DRAFT00},
          kDefaultKeyShares,
      },
      {
          "Hint two groups, both supported by client in same order",
          {SSL_GROUP_X25519_MLKEM768, SSL_GROUP_MLKEM1024},
          {SSL_GROUP_X25519_MLKEM768},
      },
      {
          "Hint two groups, both supported by client in different order",
          {SSL_GROUP_X25519, SSL_GROUP_X25519_MLKEM768},
          // The key share will be determined by the client's preference order,
          // not the server hint's order.
          {SSL_GROUP_X25519_MLKEM768},
      },
      {
          "Hint two groups, supported and non-supported by client",
          {SSL_GROUP_MLKEM1024, SSL_GROUP_SECP384R1},
          {SSL_GROUP_MLKEM1024},
      },
      {
          "Hint two groups, non-supported and supported by client",
          {SSL_GROUP_SECP384R1, SSL_GROUP_MLKEM1024},
          {SSL_GROUP_MLKEM1024},
      },
      {
          "Hint unrecognized group",
          {0x1234},
          kDefaultKeyShares,
      },
  };

  for (const auto &t : kTests) {
    SCOPED_TRACE(t.description);
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);
    ASSERT_TRUE(SSL_CTX_set1_group_ids(ctx.get(), kSupportedGroups,
                                       std::size(kSupportedGroups)));
    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    ASSERT_TRUE(ssl);
    ASSERT_TRUE(SSL_set1_server_supported_groups_hint(
        ssl.get(), t.server_hinted_groups.data(),
        t.server_hinted_groups.size()));
    ASSERT_TRUE(SSL_connect(ssl.get()));

    std::vector<uint16_t> key_shares;
    for (const auto &key_share : ssl->s3->hs->key_shares) {
      key_shares.push_back(key_share->GroupID());
    }
    EXPECT_THAT(key_shares, ElementsAreArray(t.expected_key_shares));
  }
}

TEST(SSLTest, ServerHintOverridesClientKeyShareSelections) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);

  const uint16_t kGroups[] = {SSL_GROUP_SECP256R1, SSL_GROUP_X25519};
  ASSERT_TRUE(SSL_set1_group_ids(ssl.get(), kGroups, std::size(kGroups)));

  const uint16_t kKeyShares[] = {SSL_GROUP_SECP256R1};
  ASSERT_TRUE(
      SSL_set1_client_key_shares(ssl.get(), kKeyShares, std::size(kKeyShares)));
  ASSERT_TRUE(ssl->config->client_key_share_selections.has_value());
  EXPECT_THAT(ssl->config->client_key_share_selections.value(),
              ElementsAreArray(kKeyShares));
  const uint16_t kServerHint[] = {SSL_GROUP_X25519};
  ASSERT_TRUE(SSL_set1_server_supported_groups_hint(ssl.get(), kServerHint,
                                                    std::size(kServerHint)));
  EXPECT_THAT(ssl->config->server_supported_groups_hint,
              ElementsAreArray(kServerHint));

  // The group predicted based on the server hint should win.
  ASSERT_TRUE(SSL_connect(ssl.get()));
  ASSERT_EQ(ssl->s3->hs->key_shares.size(), 1u);
  EXPECT_EQ(kServerHint[0], ssl->s3->hs->key_shares[0]->GroupID());
}

TEST(SSLTest, ServerHintOverridesEmptyClientKeyShareSelections) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);

  const uint16_t kGroups[] = {SSL_GROUP_SECP256R1, SSL_GROUP_X25519};
  ASSERT_TRUE(SSL_set1_group_ids(ssl.get(), kGroups, std::size(kGroups)));

  ASSERT_TRUE(SSL_set1_client_key_shares(ssl.get(), nullptr, 0));
  EXPECT_TRUE(ssl->config->client_key_share_selections->empty());
  const uint16_t kServerHint[] = {SSL_GROUP_X25519};
  ASSERT_TRUE(SSL_set1_server_supported_groups_hint(ssl.get(), kServerHint,
                                                    std::size(kServerHint)));
  EXPECT_THAT(ssl->config->server_supported_groups_hint,
              ElementsAreArray(kServerHint));

  // The group predicted based on the server hint should win.
  ASSERT_TRUE(SSL_connect(ssl.get()));
  ASSERT_EQ(ssl->s3->hs->key_shares.size(), 1u);
  EXPECT_EQ(kServerHint[0], ssl->s3->hs->key_shares[0]->GroupID());
}

// kOpenSSLSession is a serialized SSL_SESSION.
static const char kOpenSSLSession[] =
    "MIIFqgIBAQICAwMEAsAvBCAG5Q1ndq4Yfmbeo1zwLkNRKmCXGdNgWvGT3cskV0yQ"
    "kAQwJlrlzkAWBOWiLj/jJ76D7l+UXoizP2KI2C7I2FccqMmIfFmmkUy32nIJ0mZH"
    "IWoJoQYCBFRDO46iBAICASyjggR6MIIEdjCCA16gAwIBAgIIK9dUvsPWSlUwDQYJ"
    "KoZIhvcNAQEFBQAwSTELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkdvb2dsZSBJbmMx"
    "JTAjBgNVBAMTHEdvb2dsZSBJbnRlcm5ldCBBdXRob3JpdHkgRzIwHhcNMTQxMDA4"
    "MTIwNzU3WhcNMTUwMTA2MDAwMDAwWjBoMQswCQYDVQQGEwJVUzETMBEGA1UECAwK"
    "Q2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91bnRhaW4gVmlldzETMBEGA1UECgwKR29v"
    "Z2xlIEluYzEXMBUGA1UEAwwOd3d3Lmdvb2dsZS5jb20wggEiMA0GCSqGSIb3DQEB"
    "AQUAA4IBDwAwggEKAoIBAQCcKeLrplAC+Lofy8t/wDwtB6eu72CVp0cJ4V3lknN6"
    "huH9ct6FFk70oRIh/VBNBBz900jYy+7111Jm1b8iqOTQ9aT5C7SEhNcQFJvqzH3e"
    "MPkb6ZSWGm1yGF7MCQTGQXF20Sk/O16FSjAynU/b3oJmOctcycWYkY0ytS/k3LBu"
    "Id45PJaoMqjB0WypqvNeJHC3q5JjCB4RP7Nfx5jjHSrCMhw8lUMW4EaDxjaR9KDh"
    "PLgjsk+LDIySRSRDaCQGhEOWLJZVLzLo4N6/UlctCHEllpBUSvEOyFga52qroGjg"
    "rf3WOQ925MFwzd6AK+Ich0gDRg8sQfdLH5OuP1cfLfU1AgMBAAGjggFBMIIBPTAd"
    "BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwGQYDVR0RBBIwEIIOd3d3Lmdv"
    "b2dsZS5jb20waAYIKwYBBQUHAQEEXDBaMCsGCCsGAQUFBzAChh9odHRwOi8vcGtp"
    "Lmdvb2dsZS5jb20vR0lBRzIuY3J0MCsGCCsGAQUFBzABhh9odHRwOi8vY2xpZW50"
    "czEuZ29vZ2xlLmNvbS9vY3NwMB0GA1UdDgQWBBQ7a+CcxsZByOpc+xpYFcIbnUMZ"
    "hTAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFErdBhYbvPZotXb1gba7Yhq6WoEv"
    "MBcGA1UdIAQQMA4wDAYKKwYBBAHWeQIFATAwBgNVHR8EKTAnMCWgI6Ahhh9odHRw"
    "Oi8vcGtpLmdvb2dsZS5jb20vR0lBRzIuY3JsMA0GCSqGSIb3DQEBBQUAA4IBAQCa"
    "OXCBdoqUy5bxyq+Wrh1zsyyCFim1PH5VU2+yvDSWrgDY8ibRGJmfff3r4Lud5kal"
    "dKs9k8YlKD3ITG7P0YT/Rk8hLgfEuLcq5cc0xqmE42xJ+Eo2uzq9rYorc5emMCxf"
    "5L0TJOXZqHQpOEcuptZQ4OjdYMfSxk5UzueUhA3ogZKRcRkdB3WeWRp+nYRhx4St"
    "o2rt2A0MKmY9165GHUqMK9YaaXHDXqBu7Sefr1uSoAP9gyIJKeihMivsGqJ1TD6Z"
    "cc6LMe+dN2P8cZEQHtD1y296ul4Mivqk3jatUVL8/hCwgch9A8O4PGZq9WqBfEWm"
    "IyHh1dPtbg1lOXdYCWtjpAIEAKUDAgEUqQUCAwGJwKqBpwSBpBwUQvoeOk0Kg36S"
    "YTcLEkXqKwOBfF9vE4KX0NxeLwjcDTpsuh3qXEaZ992r1N38VDcyS6P7I6HBYN9B"
    "sNHM362zZnY27GpTw+Kwd751CLoXFPoaMOe57dbBpXoro6Pd3BTbf/Tzr88K06yE"
    "OTDKPNj3+inbMaVigtK4PLyPq+Topyzvx9USFgRvyuoxn0Hgb+R0A3j6SLRuyOdA"
    "i4gv7Y5oliyntgMBAQA=";

// kCustomSession is a custom serialized SSL_SESSION generated by
// filling in missing fields from |kOpenSSLSession|. This includes
// providing |peer_sha256|, so |peer| is not serialized.
static const char kCustomSession[] =
    "MIIBZAIBAQICAwMEAsAvBCAG5Q1ndq4Yfmbeo1zwLkNRKmCXGdNgWvGT3cskV0yQ"
    "kAQwJlrlzkAWBOWiLj/jJ76D7l+UXoizP2KI2C7I2FccqMmIfFmmkUy32nIJ0mZH"
    "IWoJoQYCBFRDO46iBAICASykAwQBAqUDAgEUqAcEBXdvcmxkqQUCAwGJwKqBpwSB"
    "pBwUQvoeOk0Kg36SYTcLEkXqKwOBfF9vE4KX0NxeLwjcDTpsuh3qXEaZ992r1N38"
    "VDcyS6P7I6HBYN9BsNHM362zZnY27GpTw+Kwd751CLoXFPoaMOe57dbBpXoro6Pd"
    "3BTbf/Tzr88K06yEOTDKPNj3+inbMaVigtK4PLyPq+Topyzvx9USFgRvyuoxn0Hg"
    "b+R0A3j6SLRuyOdAi4gv7Y5oliynrSIEIAYGBgYGBgYGBgYGBgYGBgYGBgYGBgYG"
    "BgYGBgYGBgYGrgMEAQevAwQBBLADBAEF";

// kBoringSSLSession is a serialized SSL_SESSION generated from bssl client.
static const char kBoringSSLSession[] =
    "MIIRwQIBAQICAwMEAsAvBCDdoGxGK26mR+8lM0uq6+k9xYuxPnwAjpcF9n0Yli9R"
    "kQQwbyshfWhdi5XQ1++7n2L1qqrcVlmHBPpr6yknT/u4pUrpQB5FZ7vqvNn8MdHf"
    "9rWgoQYCBFXgs7uiBAICHCCjggR6MIIEdjCCA16gAwIBAgIIf+yfD7Y6UicwDQYJ"
    "KoZIhvcNAQELBQAwSTELMAkGA1UEBhMCVVMxEzARBgNVBAoTCkdvb2dsZSBJbmMx"
    "JTAjBgNVBAMTHEdvb2dsZSBJbnRlcm5ldCBBdXRob3JpdHkgRzIwHhcNMTUwODEy"
    "MTQ1MzE1WhcNMTUxMTEwMDAwMDAwWjBoMQswCQYDVQQGEwJVUzETMBEGA1UECAwK"
    "Q2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91bnRhaW4gVmlldzETMBEGA1UECgwKR29v"
    "Z2xlIEluYzEXMBUGA1UEAwwOd3d3Lmdvb2dsZS5jb20wggEiMA0GCSqGSIb3DQEB"
    "AQUAA4IBDwAwggEKAoIBAQC0MeG5YGQ0t+IeJeoneP/PrhEaieibeKYkbKVLNZpo"
    "PLuBinvhkXZo3DC133NpCBpy6ZktBwamqyixAyuk/NU6OjgXqwwxfQ7di1AInLIU"
    "792c7hFyNXSUCG7At8Ifi3YwBX9Ba6u/1d6rWTGZJrdCq3QU11RkKYyTq2KT5mce"
    "Tv9iGKqSkSTlp8puy/9SZ/3DbU3U+BuqCFqeSlz7zjwFmk35acdCilpJlVDDN5C/"
    "RCh8/UKc8PaL+cxlt531qoTENvYrflBno14YEZlCBZsPiFeUSILpKEj3Ccwhy0eL"
    "EucWQ72YZU8mUzXBoXGn0zA0crFl5ci/2sTBBGZsylNBAgMBAAGjggFBMIIBPTAd"
    "BgNVHSUEFjAUBggrBgEFBQcDAQYIKwYBBQUHAwIwGQYDVR0RBBIwEIIOd3d3Lmdv"
    "b2dsZS5jb20waAYIKwYBBQUHAQEEXDBaMCsGCCsGAQUFBzAChh9odHRwOi8vcGtp"
    "Lmdvb2dsZS5jb20vR0lBRzIuY3J0MCsGCCsGAQUFBzABhh9odHRwOi8vY2xpZW50"
    "czEuZ29vZ2xlLmNvbS9vY3NwMB0GA1UdDgQWBBS/bzHxcE73Q4j3slC4BLbMtLjG"
    "GjAMBgNVHRMBAf8EAjAAMB8GA1UdIwQYMBaAFErdBhYbvPZotXb1gba7Yhq6WoEv"
    "MBcGA1UdIAQQMA4wDAYKKwYBBAHWeQIFATAwBgNVHR8EKTAnMCWgI6Ahhh9odHRw"
    "Oi8vcGtpLmdvb2dsZS5jb20vR0lBRzIuY3JsMA0GCSqGSIb3DQEBCwUAA4IBAQAb"
    "qdWPZEHk0X7iKPCTHL6S3w6q1eR67goxZGFSM1lk1hjwyu7XcLJuvALVV9uY3ovE"
    "kQZSHwT+pyOPWQhsSjO+1GyjvCvK/CAwiUmBX+bQRGaqHsRcio7xSbdVcajQ3bXd"
    "X+s0WdbOpn6MStKAiBVloPlSxEI8pxY6x/BBCnTIk/+DMB17uZlOjG3vbAnkDkP+"
    "n0OTucD9sHV7EVj9XUxi51nOfNBCN/s7lpUjDS/NJ4k3iwOtbCPswiot8vLO779a"
    "f07vR03r349Iz/KTzk95rlFtX0IU+KYNxFNsanIXZ+C9FYGRXkwhHcvFb4qMUB1y"
    "TTlM80jBMOwyjZXmjRAhpAIEAKUDAgEUqQUCAwGJwKqBpwSBpOgebbmn9NRUtMWH"
    "+eJpqA5JLMFSMCChOsvKey3toBaCNGU7HfAEiiXNuuAdCBoK262BjQc2YYfqFzqH"
    "zuppopXCvhohx7j/tnCNZIMgLYt/O9SXK2RYI5z8FhCCHvB4CbD5G0LGl5EFP27s"
    "Jb6S3aTTYPkQe8yZSlxevg6NDwmTogLO9F7UUkaYmVcMQhzssEE2ZRYNwSOU6KjE"
    "0Yj+8fAiBtbQriIEIN2L8ZlpaVrdN5KFNdvcmOxJu81P8q53X55xQyGTnGWwsgMC"
    "ARezggvvMIIEdjCCA16gAwIBAgIIf+yfD7Y6UicwDQYJKoZIhvcNAQELBQAwSTEL"
    "MAkGA1UEBhMCVVMxEzARBgNVBAoTCkdvb2dsZSBJbmMxJTAjBgNVBAMTHEdvb2ds"
    "ZSBJbnRlcm5ldCBBdXRob3JpdHkgRzIwHhcNMTUwODEyMTQ1MzE1WhcNMTUxMTEw"
    "MDAwMDAwWjBoMQswCQYDVQQGEwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQG"
    "A1UEBwwNTW91bnRhaW4gVmlldzETMBEGA1UECgwKR29vZ2xlIEluYzEXMBUGA1UE"
    "AwwOd3d3Lmdvb2dsZS5jb20wggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIB"
    "AQC0MeG5YGQ0t+IeJeoneP/PrhEaieibeKYkbKVLNZpoPLuBinvhkXZo3DC133Np"
    "CBpy6ZktBwamqyixAyuk/NU6OjgXqwwxfQ7di1AInLIU792c7hFyNXSUCG7At8If"
    "i3YwBX9Ba6u/1d6rWTGZJrdCq3QU11RkKYyTq2KT5mceTv9iGKqSkSTlp8puy/9S"
    "Z/3DbU3U+BuqCFqeSlz7zjwFmk35acdCilpJlVDDN5C/RCh8/UKc8PaL+cxlt531"
    "qoTENvYrflBno14YEZlCBZsPiFeUSILpKEj3Ccwhy0eLEucWQ72YZU8mUzXBoXGn"
    "0zA0crFl5ci/2sTBBGZsylNBAgMBAAGjggFBMIIBPTAdBgNVHSUEFjAUBggrBgEF"
    "BQcDAQYIKwYBBQUHAwIwGQYDVR0RBBIwEIIOd3d3Lmdvb2dsZS5jb20waAYIKwYB"
    "BQUHAQEEXDBaMCsGCCsGAQUFBzAChh9odHRwOi8vcGtpLmdvb2dsZS5jb20vR0lB"
    "RzIuY3J0MCsGCCsGAQUFBzABhh9odHRwOi8vY2xpZW50czEuZ29vZ2xlLmNvbS9v"
    "Y3NwMB0GA1UdDgQWBBS/bzHxcE73Q4j3slC4BLbMtLjGGjAMBgNVHRMBAf8EAjAA"
    "MB8GA1UdIwQYMBaAFErdBhYbvPZotXb1gba7Yhq6WoEvMBcGA1UdIAQQMA4wDAYK"
    "KwYBBAHWeQIFATAwBgNVHR8EKTAnMCWgI6Ahhh9odHRwOi8vcGtpLmdvb2dsZS5j"
    "b20vR0lBRzIuY3JsMA0GCSqGSIb3DQEBCwUAA4IBAQAbqdWPZEHk0X7iKPCTHL6S"
    "3w6q1eR67goxZGFSM1lk1hjwyu7XcLJuvALVV9uY3ovEkQZSHwT+pyOPWQhsSjO+"
    "1GyjvCvK/CAwiUmBX+bQRGaqHsRcio7xSbdVcajQ3bXdX+s0WdbOpn6MStKAiBVl"
    "oPlSxEI8pxY6x/BBCnTIk/+DMB17uZlOjG3vbAnkDkP+n0OTucD9sHV7EVj9XUxi"
    "51nOfNBCN/s7lpUjDS/NJ4k3iwOtbCPswiot8vLO779af07vR03r349Iz/KTzk95"
    "rlFtX0IU+KYNxFNsanIXZ+C9FYGRXkwhHcvFb4qMUB1yTTlM80jBMOwyjZXmjRAh"
    "MIID8DCCAtigAwIBAgIDAjqDMA0GCSqGSIb3DQEBCwUAMEIxCzAJBgNVBAYTAlVT"
    "MRYwFAYDVQQKEw1HZW9UcnVzdCBJbmMuMRswGQYDVQQDExJHZW9UcnVzdCBHbG9i"
    "YWwgQ0EwHhcNMTMwNDA1MTUxNTU2WhcNMTYxMjMxMjM1OTU5WjBJMQswCQYDVQQG"
    "EwJVUzETMBEGA1UEChMKR29vZ2xlIEluYzElMCMGA1UEAxMcR29vZ2xlIEludGVy"
    "bmV0IEF1dGhvcml0eSBHMjCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB"
    "AJwqBHdc2FCROgajguDYUEi8iT/xGXAaiEZ+4I/F8YnOIe5a/mENtzJEiaB0C1NP"
    "VaTOgmKV7utZX8bhBYASxF6UP7xbSDj0U/ck5vuR6RXEz/RTDfRK/J9U3n2+oGtv"
    "h8DQUB8oMANA2ghzUWx//zo8pzcGjr1LEQTrfSTe5vn8MXH7lNVg8y5Kr0LSy+rE"
    "ahqyzFPdFUuLH8gZYR/Nnag+YyuENWllhMgZxUYi+FOVvuOAShDGKuy6lyARxzmZ"
    "EASg8GF6lSWMTlJ14rbtCMoU/M4iarNOz0YDl5cDfsCx3nuvRTPPuj5xt970JSXC"
    "DTWJnZ37DhF5iR43xa+OcmkCAwEAAaOB5zCB5DAfBgNVHSMEGDAWgBTAephojYn7"
    "qwVkDBF9qn1luMrMTjAdBgNVHQ4EFgQUSt0GFhu89mi1dvWBtrtiGrpagS8wDgYD"
    "VR0PAQH/BAQDAgEGMC4GCCsGAQUFBwEBBCIwIDAeBggrBgEFBQcwAYYSaHR0cDov"
    "L2cuc3ltY2QuY29tMBIGA1UdEwEB/wQIMAYBAf8CAQAwNQYDVR0fBC4wLDAqoCig"
    "JoYkaHR0cDovL2cuc3ltY2IuY29tL2NybHMvZ3RnbG9iYWwuY3JsMBcGA1UdIAQQ"
    "MA4wDAYKKwYBBAHWeQIFATANBgkqhkiG9w0BAQsFAAOCAQEAqvqpIM1qZ4PtXtR+"
    "3h3Ef+AlBgDFJPupyC1tft6dgmUsgWM0Zj7pUsIItMsv91+ZOmqcUHqFBYx90SpI"
    "hNMJbHzCzTWf84LuUt5oX+QAihcglvcpjZpNy6jehsgNb1aHA30DP9z6eX0hGfnI"
    "Oi9RdozHQZJxjyXON/hKTAAj78Q1EK7gI4BzfE00LshukNYQHpmEcxpw8u1VDu4X"
    "Bupn7jLrLN1nBz/2i8Jw3lsA5rsb0zYaImxssDVCbJAJPZPpZAkiDoUGn8JzIdPm"
    "X4DkjYUiOnMDsWCOrmji9D6X52ASCWg23jrW4kOVWzeBkoEfu43XrVJkFleW2V40"
    "fsg12DCCA30wggLmoAMCAQICAxK75jANBgkqhkiG9w0BAQUFADBOMQswCQYDVQQG"
    "EwJVUzEQMA4GA1UEChMHRXF1aWZheDEtMCsGA1UECxMkRXF1aWZheCBTZWN1cmUg"
    "Q2VydGlmaWNhdGUgQXV0aG9yaXR5MB4XDTAyMDUyMTA0MDAwMFoXDTE4MDgyMTA0"
    "MDAwMFowQjELMAkGA1UEBhMCVVMxFjAUBgNVBAoTDUdlb1RydXN0IEluYy4xGzAZ"
    "BgNVBAMTEkdlb1RydXN0IEdsb2JhbCBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEP"
    "ADCCAQoCggEBANrMGGMw/fQXIxpWflvfPGw45HG3eJHUvKHYTPioQ7YD6U0hBwiI"
    "2lgvZjkpvQV4i5046AW3an5xpObEYKaw74DkiSgPniXW7YPzraaRx5jJQhg1FJ2t"
    "mEaSLk/K8YdDwRaVVy1Q74ktgHpXrfLuX2vSAI25FPgUFTXZwEaje3LIkb/JVSvN"
    "0Jc+nCZkzN/Ogxlxyk7m1NV7qRnNVd7I7NJeOFPlXE+MLf5QIzb8ZubLjqQ5GQC3"
    "lQI5kQsO/jgu0R0FmvZNPm8PBx2vLB6PYDni+jZTEznUXiYr2z2oFL0y6xgDKFIE"
    "ceWrMz3hOLsHNoRinHnqFjD0X8Ar6HFr5PkCAwEAAaOB8DCB7TAfBgNVHSMEGDAW"
    "gBRI5mj5K9KylddH2CMgEE8zmJCf1DAdBgNVHQ4EFgQUwHqYaI2J+6sFZAwRfap9"
    "ZbjKzE4wDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAQYwOgYDVR0fBDMw"
    "MTAvoC2gK4YpaHR0cDovL2NybC5nZW90cnVzdC5jb20vY3Jscy9zZWN1cmVjYS5j"
    "cmwwTgYDVR0gBEcwRTBDBgRVHSAAMDswOQYIKwYBBQUHAgEWLWh0dHBzOi8vd3d3"
    "Lmdlb3RydXN0LmNvbS9yZXNvdXJjZXMvcmVwb3NpdG9yeTANBgkqhkiG9w0BAQUF"
    "AAOBgQB24RJuTksWEoYwBrKBCM/wCMfHcX5m7sLt1Dsf//DwyE7WQziwuTB9GNBV"
    "g6JqyzYRnOhIZqNtf7gT1Ef+i1pcc/yu2RsyGTirlzQUqpbS66McFAhJtrvlke+D"
    "NusdVm/K2rxzY5Dkf3s+Iss9B+1fOHSc4wNQTqGvmO5h8oQ/Eg==";

// kBadSessionExtraField is a custom serialized SSL_SESSION generated by
// replacing the final (optional) element of |kCustomSession| with tag
// number 99.
static const char kBadSessionExtraField[] =
    "MIIBdgIBAQICAwMEAsAvBCAG5Q1ndq4Yfmbeo1zwLkNRKmCXGdNgWvGT3cskV0yQ"
    "kAQwJlrlzkAWBOWiLj/jJ76D7l+UXoizP2KI2C7I2FccqMmIfFmmkUy32nIJ0mZH"
    "IWoJoQYCBFRDO46iBAICASykAwQBAqUDAgEUphAEDnd3dy5nb29nbGUuY29tqAcE"
    "BXdvcmxkqQUCAwGJwKqBpwSBpBwUQvoeOk0Kg36SYTcLEkXqKwOBfF9vE4KX0Nxe"
    "LwjcDTpsuh3qXEaZ992r1N38VDcyS6P7I6HBYN9BsNHM362zZnY27GpTw+Kwd751"
    "CLoXFPoaMOe57dbBpXoro6Pd3BTbf/Tzr88K06yEOTDKPNj3+inbMaVigtK4PLyP"
    "q+Topyzvx9USFgRvyuoxn0Hgb+R0A3j6SLRuyOdAi4gv7Y5oliynrSIEIAYGBgYG"
    "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGrgMEAQevAwQBBOMDBAEF";

// kBadSessionVersion is a custom serialized SSL_SESSION generated by replacing
// the version of |kCustomSession| with 2.
static const char kBadSessionVersion[] =
    "MIIBdgIBAgICAwMEAsAvBCAG5Q1ndq4Yfmbeo1zwLkNRKmCXGdNgWvGT3cskV0yQ"
    "kAQwJlrlzkAWBOWiLj/jJ76D7l+UXoizP2KI2C7I2FccqMmIfFmmkUy32nIJ0mZH"
    "IWoJoQYCBFRDO46iBAICASykAwQBAqUDAgEUphAEDnd3dy5nb29nbGUuY29tqAcE"
    "BXdvcmxkqQUCAwGJwKqBpwSBpBwUQvoeOk0Kg36SYTcLEkXqKwOBfF9vE4KX0Nxe"
    "LwjcDTpsuh3qXEaZ992r1N38VDcyS6P7I6HBYN9BsNHM362zZnY27GpTw+Kwd751"
    "CLoXFPoaMOe57dbBpXoro6Pd3BTbf/Tzr88K06yEOTDKPNj3+inbMaVigtK4PLyP"
    "q+Topyzvx9USFgRvyuoxn0Hgb+R0A3j6SLRuyOdAi4gv7Y5oliynrSIEIAYGBgYG"
    "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGrgMEAQevAwQBBLADBAEF";

// kBadSessionTrailingData is a custom serialized SSL_SESSION with trailing data
// appended.
static const char kBadSessionTrailingData[] =
    "MIIBdgIBAQICAwMEAsAvBCAG5Q1ndq4Yfmbeo1zwLkNRKmCXGdNgWvGT3cskV0yQ"
    "kAQwJlrlzkAWBOWiLj/jJ76D7l+UXoizP2KI2C7I2FccqMmIfFmmkUy32nIJ0mZH"
    "IWoJoQYCBFRDO46iBAICASykAwQBAqUDAgEUphAEDnd3dy5nb29nbGUuY29tqAcE"
    "BXdvcmxkqQUCAwGJwKqBpwSBpBwUQvoeOk0Kg36SYTcLEkXqKwOBfF9vE4KX0Nxe"
    "LwjcDTpsuh3qXEaZ992r1N38VDcyS6P7I6HBYN9BsNHM362zZnY27GpTw+Kwd751"
    "CLoXFPoaMOe57dbBpXoro6Pd3BTbf/Tzr88K06yEOTDKPNj3+inbMaVigtK4PLyP"
    "q+Topyzvx9USFgRvyuoxn0Hgb+R0A3j6SLRuyOdAi4gv7Y5oliynrSIEIAYGBgYG"
    "BgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGBgYGrgMEAQevAwQBBLADBAEFAAAA";

static bool DecodeBase64(std::vector<uint8_t> *out, const char *in) {
  size_t len;
  if (!EVP_DecodedLength(&len, strlen(in))) {
    fprintf(stderr, "EVP_DecodedLength failed\n");
    return false;
  }

  out->resize(len);
  if (!EVP_DecodeBase64(out->data(), &len, len, (const uint8_t *)in,
                        strlen(in))) {
    fprintf(stderr, "EVP_DecodeBase64 failed\n");
    return false;
  }
  out->resize(len);
  return true;
}

static bool DecodeLowerHex(std::vector<uint8_t> *out,
                           bssl::Span<const char> in) {
  if (in.size() % 2 != 0) {
    return false;
  }
  out->resize(in.size() / 2);
  for (size_t i = 0; i < out->size(); i++) {
    char hi = in[2 * i], lo = in[2 * i + 1];
    uint8_t b = 0;
    if ('0' <= hi && hi <= '9') {
      b |= hi - '0';
    } else if ('a' <= hi && hi <= 'f') {
      b |= hi - 'a' + 10;
    } else {
      return false;
    }
    b <<= 4;
    if ('0' <= lo && lo <= '9') {
      b |= lo - '0';
    } else if ('a' <= lo && lo <= 'f') {
      b |= lo - 'a' + 10;
    } else {
      return false;
    }
    (*out)[i] = b;
  }
  return true;
}

TEST(SSLTest, SessionEncoding) {
  for (const char *input_b64 : {
           kOpenSSLSession,
           kCustomSession,
           kBoringSSLSession,
       }) {
    SCOPED_TRACE(std::string(input_b64));
    // Decode the input.
    std::vector<uint8_t> input;
    ASSERT_TRUE(DecodeBase64(&input, input_b64));

    // Verify the SSL_SESSION decodes.
    bssl::UniquePtr<SSL_CTX> ssl_ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ssl_ctx);
    bssl::UniquePtr<SSL_SESSION> session(
        SSL_SESSION_from_bytes(input.data(), input.size(), ssl_ctx.get()));
    ASSERT_TRUE(session) << "SSL_SESSION_from_bytes failed";

    // Verify the SSL_SESSION encoding round-trips.
    size_t encoded_len;
    bssl::UniquePtr<uint8_t> encoded;
    uint8_t *encoded_raw;
    ASSERT_TRUE(SSL_SESSION_to_bytes(session.get(), &encoded_raw, &encoded_len))
        << "SSL_SESSION_to_bytes failed";
    encoded.reset(encoded_raw);
    EXPECT_EQ(Bytes(encoded.get(), encoded_len), Bytes(input))
        << "SSL_SESSION_to_bytes did not round-trip";

    // Verify the SSL_SESSION also decodes with the legacy API.
    const uint8_t *cptr = input.data();
    session.reset(d2i_SSL_SESSION(nullptr, &cptr, input.size()));
    ASSERT_TRUE(session) << "d2i_SSL_SESSION failed";
    EXPECT_EQ(cptr, input.data() + input.size());

    // Verify the SSL_SESSION encoding round-trips via the legacy API.
    int len = i2d_SSL_SESSION(session.get(), nullptr);
    ASSERT_GT(len, 0) << "i2d_SSL_SESSION failed";
    ASSERT_EQ(static_cast<size_t>(len), input.size())
        << "i2d_SSL_SESSION(NULL) returned invalid length";

    encoded.reset((uint8_t *)OPENSSL_malloc(input.size()));
    ASSERT_TRUE(encoded);

    uint8_t *ptr = encoded.get();
    len = i2d_SSL_SESSION(session.get(), &ptr);
    ASSERT_GT(len, 0) << "i2d_SSL_SESSION failed";
    ASSERT_EQ(static_cast<size_t>(len), input.size())
        << "i2d_SSL_SESSION(NULL) returned invalid length";
    ASSERT_EQ(ptr, encoded.get() + input.size())
        << "i2d_SSL_SESSION did not advance ptr correctly";
    EXPECT_EQ(Bytes(encoded.get(), encoded_len), Bytes(input))
        << "SSL_SESSION_to_bytes did not round-trip";
  }

  for (const char *input_b64 : {
           kBadSessionExtraField,
           kBadSessionVersion,
           kBadSessionTrailingData,
       }) {
    SCOPED_TRACE(std::string(input_b64));
    std::vector<uint8_t> input;
    ASSERT_TRUE(DecodeBase64(&input, input_b64));

    // Verify that the SSL_SESSION fails to decode.
    bssl::UniquePtr<SSL_CTX> ssl_ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ssl_ctx);
    bssl::UniquePtr<SSL_SESSION> session(
        SSL_SESSION_from_bytes(input.data(), input.size(), ssl_ctx.get()));
    EXPECT_FALSE(session) << "SSL_SESSION_from_bytes unexpectedly succeeded";
    ERR_clear_error();
  }
}

static void ExpectDefaultVersion(uint16_t min_version, uint16_t max_version,
                                 const SSL_METHOD *(*method)(void)) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(method()));
  ASSERT_TRUE(ctx);
  EXPECT_EQ(min_version, SSL_CTX_get_min_proto_version(ctx.get()));
  EXPECT_EQ(max_version, SSL_CTX_get_max_proto_version(ctx.get()));
}

TEST(SSLTest, DefaultVersion) {
  ExpectDefaultVersion(TLS1_2_VERSION, TLS1_3_VERSION, &TLS_method);
  ExpectDefaultVersion(TLS1_VERSION, TLS1_VERSION, &TLSv1_method);
  ExpectDefaultVersion(TLS1_1_VERSION, TLS1_1_VERSION, &TLSv1_1_method);
  ExpectDefaultVersion(TLS1_2_VERSION, TLS1_2_VERSION, &TLSv1_2_method);
  ExpectDefaultVersion(DTLS1_2_VERSION, DTLS1_2_VERSION, &DTLS_method);
  ExpectDefaultVersion(DTLS1_VERSION, DTLS1_VERSION, &DTLSv1_method);
  ExpectDefaultVersion(DTLS1_2_VERSION, DTLS1_2_VERSION, &DTLSv1_2_method);
}

TEST(SSLTest, CipherProperties) {
  static const struct {
    uint16_t protocol_id;
    const char *standard_name;
    int cipher_nid;
    int digest_nid;
    int kx_nid;
    int auth_nid;
    int prf_nid;
  } kTests[] = {
      {
          SSL_CIPHER_RSA_WITH_3DES_EDE_CBC_SHA,
          "TLS_RSA_WITH_3DES_EDE_CBC_SHA",
          NID_des_ede3_cbc,
          NID_sha1,
          NID_kx_rsa,
          NID_auth_rsa,
          NID_md5_sha1,
      },
      {
          SSL_CIPHER_RSA_WITH_AES_128_CBC_SHA,
          "TLS_RSA_WITH_AES_128_CBC_SHA",
          NID_aes_128_cbc,
          NID_sha1,
          NID_kx_rsa,
          NID_auth_rsa,
          NID_md5_sha1,
      },
      {
          SSL_CIPHER_PSK_WITH_AES_256_CBC_SHA,
          "TLS_PSK_WITH_AES_256_CBC_SHA",
          NID_aes_256_cbc,
          NID_sha1,
          NID_kx_psk,
          NID_auth_psk,
          NID_md5_sha1,
      },
      {
          SSL_CIPHER_ECDHE_RSA_WITH_AES_128_CBC_SHA,
          "TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
          NID_aes_128_cbc,
          NID_sha1,
          NID_kx_ecdhe,
          NID_auth_rsa,
          NID_md5_sha1,
      },
      {
          SSL_CIPHER_ECDHE_RSA_WITH_AES_256_CBC_SHA,
          "TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA",
          NID_aes_256_cbc,
          NID_sha1,
          NID_kx_ecdhe,
          NID_auth_rsa,
          NID_md5_sha1,
      },
      {
          SSL_CIPHER_ECDHE_RSA_WITH_AES_128_GCM_SHA256,
          "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256",
          NID_aes_128_gcm,
          NID_undef,
          NID_kx_ecdhe,
          NID_auth_rsa,
          NID_sha256,
      },
      {
          SSL_CIPHER_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256,
          "TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256",
          NID_aes_128_gcm,
          NID_undef,
          NID_kx_ecdhe,
          NID_auth_ecdsa,
          NID_sha256,
      },
      {
          SSL_CIPHER_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384,
          "TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384",
          NID_aes_256_gcm,
          NID_undef,
          NID_kx_ecdhe,
          NID_auth_ecdsa,
          NID_sha384,
      },
      {
          SSL_CIPHER_ECDHE_PSK_WITH_AES_128_CBC_SHA,
          "TLS_ECDHE_PSK_WITH_AES_128_CBC_SHA",
          NID_aes_128_cbc,
          NID_sha1,
          NID_kx_ecdhe,
          NID_auth_psk,
          NID_md5_sha1,
      },
      {
          SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256,
          "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256",
          NID_chacha20_poly1305,
          NID_undef,
          NID_kx_ecdhe,
          NID_auth_rsa,
          NID_sha256,
      },
      {
          SSL_CIPHER_AES_256_GCM_SHA384,
          "TLS_AES_256_GCM_SHA384",
          NID_aes_256_gcm,
          NID_undef,
          NID_kx_any,
          NID_auth_any,
          NID_sha384,
      },
      {
          SSL_CIPHER_AES_128_GCM_SHA256,
          "TLS_AES_128_GCM_SHA256",
          NID_aes_128_gcm,
          NID_undef,
          NID_kx_any,
          NID_auth_any,
          NID_sha256,
      },
      {
          SSL_CIPHER_CHACHA20_POLY1305_SHA256,
          "TLS_CHACHA20_POLY1305_SHA256",
          NID_chacha20_poly1305,
          NID_undef,
          NID_kx_any,
          NID_auth_any,
          NID_sha256,
      },
  };

  for (const auto &t : kTests) {
    SCOPED_TRACE(t.standard_name);

    const SSL_CIPHER *cipher = SSL_get_cipher_by_value(t.protocol_id);
    ASSERT_TRUE(cipher);
    EXPECT_STREQ(t.standard_name, SSL_CIPHER_standard_name(cipher));

    EXPECT_EQ(t.cipher_nid, SSL_CIPHER_get_cipher_nid(cipher));
    EXPECT_EQ(t.digest_nid, SSL_CIPHER_get_digest_nid(cipher));
    EXPECT_EQ(t.kx_nid, SSL_CIPHER_get_kx_nid(cipher));
    EXPECT_EQ(t.auth_nid, SSL_CIPHER_get_auth_nid(cipher));
    EXPECT_EQ(t.prf_nid, EVP_MD_nid(SSL_CIPHER_get_handshake_digest(cipher)));
    EXPECT_EQ(t.prf_nid, SSL_CIPHER_get_prf_nid(cipher));
  }
}

// CreateSessionWithTicket returns a sample |SSL_SESSION| with the specified
// version and ticket length or nullptr on failure.
static bssl::UniquePtr<SSL_SESSION> CreateSessionWithTicket(uint16_t version,
                                                            size_t ticket_len) {
  std::vector<uint8_t> der;
  if (!DecodeBase64(&der, kOpenSSLSession)) {
    return nullptr;
  }

  bssl::UniquePtr<SSL_CTX> ssl_ctx(SSL_CTX_new(TLS_method()));
  if (!ssl_ctx) {
    return nullptr;
  }
  // Use a garbage ticket.
  std::vector<uint8_t> ticket(ticket_len, 'a');
  bssl::UniquePtr<SSL_SESSION> session(
      SSL_SESSION_from_bytes(der.data(), der.size(), ssl_ctx.get()));
  if (!session ||                                                   //
      !SSL_SESSION_set_protocol_version(session.get(), version) ||  //
      !SSL_SESSION_set_ticket(session.get(), ticket.data(), ticket.size())) {
    return nullptr;
  }
  // Fix up the timeout.
  SSL_SESSION_set_time(session.get(), time(nullptr));
  return session;
}

static bool GetClientHello(SSL *ssl, std::vector<uint8_t> *out) {
  bssl::UniquePtr<BIO> bio(BIO_new(BIO_s_mem()));
  if (!bio) {
    return false;
  }
  // Do not configure a reading BIO, but record what's written to a memory BIO.
  BIO_up_ref(bio.get());
  SSL_set_bio(ssl, nullptr /* rbio */, bio.get());
  int ret = SSL_connect(ssl);
  if (ret > 0) {
    // SSL_connect should fail without a BIO to write to.
    return false;
  }
  ERR_clear_error();

  const uint8_t *client_hello;
  size_t client_hello_len;
  if (!BIO_mem_contents(bio.get(), &client_hello, &client_hello_len)) {
    return false;
  }

  // We did not get far enough to write a ClientHello.
  if (client_hello_len == 0) {
    return false;
  }

  *out = std::vector<uint8_t>(client_hello, client_hello + client_hello_len);
  return true;
}

// GetClientHelloLen creates a client SSL connection with the specified version
// and ticket length. It returns the length of the ClientHello, not including
// the record header, on success and zero on error.
static size_t GetClientHelloLen(uint16_t max_version, uint16_t session_version,
                                size_t ticket_len) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_SESSION> session =
      CreateSessionWithTicket(session_version, ticket_len);
  if (!ctx || !session) {
    return 0;
  }

  // Set a one-element cipher list so the baseline ClientHello is unpadded.
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  if (!ssl || !SSL_set_session(ssl.get(), session.get()) ||
      !SSL_set_strict_cipher_list(ssl.get(), "ECDHE-RSA-AES128-GCM-SHA256") ||
      !SSL_set_max_proto_version(ssl.get(), max_version)) {
    return 0;
  }

  std::vector<uint8_t> client_hello;
  if (!GetClientHello(ssl.get(), &client_hello) ||
      client_hello.size() <= SSL3_RT_HEADER_LENGTH) {
    return 0;
  }

  return client_hello.size() - SSL3_RT_HEADER_LENGTH;
}

TEST(SSLTest, Padding) {
  struct PaddingVersions {
    uint16_t max_version, session_version;
  };
  static const PaddingVersions kPaddingVersions[] = {
      // Test the padding extension at TLS 1.2.
      {TLS1_2_VERSION, TLS1_2_VERSION},
      // Test the padding extension at TLS 1.3 with a TLS 1.2 session, so there
      // will be no PSK binder after the padding extension.
      {TLS1_3_VERSION, TLS1_2_VERSION},
      // Test the padding extension at TLS 1.3 with a TLS 1.3 session, so there
      // will be a PSK binder after the padding extension.
      {TLS1_3_VERSION, TLS1_3_VERSION},

  };

  struct PaddingTest {
    size_t input_len, padded_len;
  };
  static const PaddingTest kPaddingTests[] = {
      // ClientHellos of length below 0x100 do not require padding.
      {0xfe, 0xfe},
      {0xff, 0xff},
      // ClientHellos of length 0x100 through 0x1fb are padded up to 0x200.
      {0x100, 0x200},
      {0x123, 0x200},
      {0x1fb, 0x200},
      // ClientHellos of length 0x1fc through 0x1ff get padded beyond 0x200. The
      // padding extension takes a minimum of four bytes plus one required
      // content
      // byte. (To work around yet more server bugs, we avoid empty final
      // extensions.)
      {0x1fc, 0x201},
      {0x1fd, 0x202},
      {0x1fe, 0x203},
      {0x1ff, 0x204},
      // Finally, larger ClientHellos need no padding.
      {0x200, 0x200},
      {0x201, 0x201},
  };

  for (const PaddingVersions &versions : kPaddingVersions) {
    SCOPED_TRACE(versions.max_version);
    SCOPED_TRACE(versions.session_version);

    // Sample a baseline length.
    size_t base_len =
        GetClientHelloLen(versions.max_version, versions.session_version, 1);
    ASSERT_NE(base_len, 0u) << "Baseline length could not be sampled";

    for (const PaddingTest &test : kPaddingTests) {
      SCOPED_TRACE(test.input_len);
      ASSERT_LE(base_len, test.input_len) << "Baseline ClientHello too long";

      size_t padded_len =
          GetClientHelloLen(versions.max_version, versions.session_version,
                            1 + test.input_len - base_len);
      EXPECT_EQ(padded_len, test.padded_len)
          << "ClientHello was not padded to expected length";
    }
  }
}

static bssl::UniquePtr<X509> CertFromPEM(const char *pem) {
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, strlen(pem)));
  if (!bio) {
    return nullptr;
  }
  return bssl::UniquePtr<X509>(
      PEM_read_bio_X509(bio.get(), nullptr, nullptr, nullptr));
}

static bssl::UniquePtr<EVP_PKEY> KeyFromPEM(const char *pem) {
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, strlen(pem)));
  if (!bio) {
    return nullptr;
  }
  return bssl::UniquePtr<EVP_PKEY>(
      PEM_read_bio_PrivateKey(bio.get(), nullptr, nullptr, nullptr));
}

static bssl::UniquePtr<CRYPTO_BUFFER> BufferFromPEM(const char *pem) {
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, strlen(pem)));
  char *name, *header;
  uint8_t *data;
  long data_len;
  if (!PEM_read_bio(bio.get(), &name, &header, &data, &data_len)) {
    return nullptr;
  }
  OPENSSL_free(name);
  OPENSSL_free(header);

  auto ret = bssl::UniquePtr<CRYPTO_BUFFER>(
      CRYPTO_BUFFER_new(data, data_len, nullptr));
  OPENSSL_free(data);
  return ret;
}

static bssl::UniquePtr<X509> X509FromBuffer(
    bssl::UniquePtr<CRYPTO_BUFFER> buffer) {
  if (!buffer) {
    return nullptr;
  }
  const uint8_t *derp = CRYPTO_BUFFER_data(buffer.get());
  return bssl::UniquePtr<X509>(
      d2i_X509(nullptr, &derp, CRYPTO_BUFFER_len(buffer.get())));
}

static bssl::UniquePtr<X509> GetTestCertificate() {
  static const char kCertPEM[] =
      "-----BEGIN CERTIFICATE-----\n"
      "MIICWDCCAcGgAwIBAgIJAPuwTC6rEJsMMA0GCSqGSIb3DQEBBQUAMEUxCzAJBgNV\n"
      "BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX\n"
      "aWRnaXRzIFB0eSBMdGQwHhcNMTQwNDIzMjA1MDQwWhcNMTcwNDIyMjA1MDQwWjBF\n"
      "MQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UECgwYSW50\n"
      "ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKB\n"
      "gQDYK8imMuRi/03z0K1Zi0WnvfFHvwlYeyK9Na6XJYaUoIDAtB92kWdGMdAQhLci\n"
      "HnAjkXLI6W15OoV3gA/ElRZ1xUpxTMhjP6PyY5wqT5r6y8FxbiiFKKAnHmUcrgfV\n"
      "W28tQ+0rkLGMryRtrukXOgXBv7gcrmU7G1jC2a7WqmeI8QIDAQABo1AwTjAdBgNV\n"
      "HQ4EFgQUi3XVrMsIvg4fZbf6Vr5sp3Xaha8wHwYDVR0jBBgwFoAUi3XVrMsIvg4f\n"
      "Zbf6Vr5sp3Xaha8wDAYDVR0TBAUwAwEB/zANBgkqhkiG9w0BAQUFAAOBgQA76Hht\n"
      "ldY9avcTGSwbwoiuIqv0jTL1fHFnzy3RHMLDh+Lpvolc5DSrSJHCP5WuK0eeJXhr\n"
      "T5oQpHL9z/cCDLAKCKRa4uV0fhEdOWBqyR9p8y5jJtye72t6CuFUV5iqcpF4BH4f\n"
      "j2VNHwsSrJwkD4QUGlUtH7vwnQmyCFxZMmWAJg==\n"
      "-----END CERTIFICATE-----\n";
  return CertFromPEM(kCertPEM);
}
static bssl::UniquePtr<CRYPTO_BUFFER> GetTestCertificateBuffer() {
  static const char kCertPEM[] =
      "-----BEGIN CERTIFICATE-----\n"
      "MIICWDCCAcGgAwIBAgIJAPuwTC6rEJsMMA0GCSqGSIb3DQEBBQUAMEUxCzAJBgNV\n"
      "BAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBX\n"
      "aWRnaXRzIFB0eSBMdGQwHhcNMTQwNDIzMjA1MDQwWhcNMTcwNDIyMjA1MDQwWjBF\n"
      "MQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UECgwYSW50\n"
      "ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKB\n"
      "gQDYK8imMuRi/03z0K1Zi0WnvfFHvwlYeyK9Na6XJYaUoIDAtB92kWdGMdAQhLci\n"
      "HnAjkXLI6W15OoV3gA/ElRZ1xUpxTMhjP6PyY5wqT5r6y8FxbiiFKKAnHmUcrgfV\n"
      "W28tQ+0rkLGMryRtrukXOgXBv7gcrmU7G1jC2a7WqmeI8QIDAQABo1AwTjAdBgNV\n"
      "HQ4EFgQUi3XVrMsIvg4fZbf6Vr5sp3Xaha8wHwYDVR0jBBgwFoAUi3XVrMsIvg4f\n"
      "Zbf6Vr5sp3Xaha8wDAYDVR0TBAUwAwEB/zANBgkqhkiG9w0BAQUFAAOBgQA76Hht\n"
      "ldY9avcTGSwbwoiuIqv0jTL1fHFnzy3RHMLDh+Lpvolc5DSrSJHCP5WuK0eeJXhr\n"
      "T5oQpHL9z/cCDLAKCKRa4uV0fhEdOWBqyR9p8y5jJtye72t6CuFUV5iqcpF4BH4f\n"
      "j2VNHwsSrJwkD4QUGlUtH7vwnQmyCFxZMmWAJg==\n"
      "-----END CERTIFICATE-----\n";
  return BufferFromPEM(kCertPEM);
}

static bssl::UniquePtr<EVP_PKEY> GetTestKey() {
  static const char kKeyPEM[] =
      "-----BEGIN RSA PRIVATE KEY-----\n"
      "MIICXgIBAAKBgQDYK8imMuRi/03z0K1Zi0WnvfFHvwlYeyK9Na6XJYaUoIDAtB92\n"
      "kWdGMdAQhLciHnAjkXLI6W15OoV3gA/ElRZ1xUpxTMhjP6PyY5wqT5r6y8FxbiiF\n"
      "KKAnHmUcrgfVW28tQ+0rkLGMryRtrukXOgXBv7gcrmU7G1jC2a7WqmeI8QIDAQAB\n"
      "AoGBAIBy09Fd4DOq/Ijp8HeKuCMKTHqTW1xGHshLQ6jwVV2vWZIn9aIgmDsvkjCe\n"
      "i6ssZvnbjVcwzSoByhjN8ZCf/i15HECWDFFh6gt0P5z0MnChwzZmvatV/FXCT0j+\n"
      "WmGNB/gkehKjGXLLcjTb6dRYVJSCZhVuOLLcbWIV10gggJQBAkEA8S8sGe4ezyyZ\n"
      "m4e9r95g6s43kPqtj5rewTsUxt+2n4eVodD+ZUlCULWVNAFLkYRTBCASlSrm9Xhj\n"
      "QpmWAHJUkQJBAOVzQdFUaewLtdOJoPCtpYoY1zd22eae8TQEmpGOR11L6kbxLQsk\n"
      "aMly/DOnOaa82tqAGTdqDEZgSNmCeKKknmECQAvpnY8GUOVAubGR6c+W90iBuQLj\n"
      "LtFp/9ihd2w/PoDwrHZaoUYVcT4VSfJQog/k7kjE4MYXYWL8eEKg3WTWQNECQQDk\n"
      "104Wi91Umd1PzF0ijd2jXOERJU1wEKe6XLkYYNHWQAe5l4J4MWj9OdxFXAxIuuR/\n"
      "tfDwbqkta4xcux67//khAkEAvvRXLHTaa6VFzTaiiO8SaFsHV3lQyXOtMrBpB5jd\n"
      "moZWgjHvB2W9Ckn7sDqsPB+U2tyX0joDdQEyuiMECDY8oQ==\n"
      "-----END RSA PRIVATE KEY-----\n";
  return KeyFromPEM(kKeyPEM);
}

static bssl::UniquePtr<SSL_CTX> CreateContextWithTestCertificate(
    const SSL_METHOD *method) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(method));
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  if (!ctx || !cert || !key ||
      !SSL_CTX_use_certificate(ctx.get(), cert.get()) ||
      !SSL_CTX_use_PrivateKey(ctx.get(), key.get())) {
    return nullptr;
  }
  return ctx;
}

static bssl::UniquePtr<CRYPTO_BUFFER> GetECDSATestCertificateBuffer() {
  static const char kCertPEM[] =
      "-----BEGIN CERTIFICATE-----\n"
      "MIIBzzCCAXagAwIBAgIJANlMBNpJfb/rMAkGByqGSM49BAEwRTELMAkGA1UEBhMC\n"
      "QVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdpZGdp\n"
      "dHMgUHR5IEx0ZDAeFw0xNDA0MjMyMzIxNTdaFw0xNDA1MjMyMzIxNTdaMEUxCzAJ\n"
      "BgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5l\n"
      "dCBXaWRnaXRzIFB0eSBMdGQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATmK2ni\n"
      "v2Wfl74vHg2UikzVl2u3qR4NRvvdqakendy6WgHn1peoChj5w8SjHlbifINI2xYa\n"
      "HPUdfvGULUvPciLBo1AwTjAdBgNVHQ4EFgQUq4TSrKuV8IJOFngHVVdf5CaNgtEw\n"
      "HwYDVR0jBBgwFoAUq4TSrKuV8IJOFngHVVdf5CaNgtEwDAYDVR0TBAUwAwEB/zAJ\n"
      "BgcqhkjOPQQBA0gAMEUCIQDyoDVeUTo2w4J5m+4nUIWOcAZ0lVfSKXQA9L4Vh13E\n"
      "BwIgfB55FGohg/B6dGh5XxSZmmi08cueFV7mHzJSYV51yRQ=\n"
      "-----END CERTIFICATE-----\n";
  return BufferFromPEM(kCertPEM);
}

static bssl::UniquePtr<X509> GetECDSATestCertificate() {
  return X509FromBuffer(GetECDSATestCertificateBuffer());
}


static bssl::UniquePtr<EVP_PKEY> GetECDSATestKey() {
  static const char kKeyPEM[] =
      "-----BEGIN PRIVATE KEY-----\n"
      "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBw8IcnrUoEqc3VnJ\n"
      "TYlodwi1b8ldMHcO6NHJzgqLtGqhRANCAATmK2niv2Wfl74vHg2UikzVl2u3qR4N\n"
      "Rvvdqakendy6WgHn1peoChj5w8SjHlbifINI2xYaHPUdfvGULUvPciLB\n"
      "-----END PRIVATE KEY-----\n";
  return KeyFromPEM(kKeyPEM);
}

static const char kChainTestCertificatePEM[] =
    "-----BEGIN CERTIFICATE-----\n"
    "MIIC0jCCAbqgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwDzENMAsGA1UEAwwEQiBD\n"
    "QTAeFw0xNjAyMjgyMDI3MDNaFw0yNjAyMjUyMDI3MDNaMBgxFjAUBgNVBAMMDUNs\n"
    "aWVudCBDZXJ0IEEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQDRvaz8\n"
    "CC/cshpCafJo4jLkHEoBqDLhdgFelJoAiQUyIqyWl2O7YHPnpJH+TgR7oelzNzt/\n"
    "kLRcH89M/TszB6zqyLTC4aqmvzKL0peD/jL2LWBucR0WXIvjA3zoRuF/x86+rYH3\n"
    "tHb+xs2PSs8EGL/Ev+ss+qTzTGEn26fuGNHkNw6tOwPpc+o8+wUtzf/kAthamo+c\n"
    "IDs2rQ+lP7+aLZTLeU/q4gcLutlzcK5imex5xy2jPkweq48kijK0kIzl1cPlA5d1\n"
    "z7C8jU50Pj9X9sQDJTN32j7UYRisJeeYQF8GaaN8SbrDI6zHgKzrRLyxDt/KQa9V\n"
    "iLeXANgZi+Xx9KgfAgMBAAGjLzAtMAwGA1UdEwEB/wQCMAAwHQYDVR0lBBYwFAYI\n"
    "KwYBBQUHAwEGCCsGAQUFBwMCMA0GCSqGSIb3DQEBCwUAA4IBAQBFEVbmYl+2RtNw\n"
    "rDftRDF1v2QUbcN2ouSnQDHxeDQdSgasLzT3ui8iYu0Rw2WWcZ0DV5e0ztGPhWq7\n"
    "AO0B120aFRMOY+4+bzu9Q2FFkQqc7/fKTvTDzIJI5wrMnFvUfzzvxh3OHWMYSs/w\n"
    "giq33hTKeHEq6Jyk3btCny0Ycecyc3yGXH10sizUfiHlhviCkDuESk8mFDwDDzqW\n"
    "ZF0IipzFbEDHoIxLlm3GQxpiLoEV4k8KYJp3R5KBLFyxM6UGPz8h72mIPCJp2RuK\n"
    "MYgF91UDvVzvnYm6TfseM2+ewKirC00GOrZ7rEcFvtxnKSqYf4ckqfNdSU1Y+RRC\n"
    "1ngWZ7Ih\n"
    "-----END CERTIFICATE-----\n";


static bssl::UniquePtr<CRYPTO_BUFFER> GetChainTestCertificateBuffer() {
  return BufferFromPEM(kChainTestCertificatePEM);
}

static bssl::UniquePtr<X509> GetChainTestCertificate() {
  return X509FromBuffer(GetChainTestCertificateBuffer());
}

static const char kChainTestIntermediatePEM[] =
    "-----BEGIN CERTIFICATE-----\n"
    "MIICwjCCAaqgAwIBAgICEAEwDQYJKoZIhvcNAQELBQAwFDESMBAGA1UEAwwJQyBS\n"
    "b290IENBMB4XDTE2MDIyODIwMjcwM1oXDTI2MDIyNTIwMjcwM1owDzENMAsGA1UE\n"
    "AwwEQiBDQTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEBALsSCYmDip2D\n"
    "GkjFxw7ykz26JSjELkl6ArlYjFJ3aT/SCh8qbS4gln7RH8CPBd78oFdfhIKQrwtZ\n"
    "3/q21ykD9BAS3qHe2YdcJfm8/kWAy5DvXk6NXU4qX334KofBAEpgdA/igEFq1P1l\n"
    "HAuIfZCpMRfT+i5WohVsGi8f/NgpRvVaMONLNfgw57mz1lbtFeBEISmX0kbsuJxF\n"
    "Qj/Bwhi5/0HAEXG8e7zN4cEx0yPRvmOATRdVb/8dW2pwOHRJq9R5M0NUkIsTSnL7\n"
    "6N/z8hRAHMsV3IudC5Yd7GXW1AGu9a+iKU+Q4xcZCoj0DC99tL4VKujrV1kAeqsM\n"
    "cz5/dKzi6+cCAwEAAaMjMCEwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMC\n"
    "AQYwDQYJKoZIhvcNAQELBQADggEBAIIeZiEeNhWWQ8Y4D+AGDwqUUeG8NjCbKrXQ\n"
    "BlHg5wZ8xftFaiP1Dp/UAezmx2LNazdmuwrYB8lm3FVTyaPDTKEGIPS4wJKHgqH1\n"
    "QPDhqNm85ey7TEtI9oYjsNim/Rb+iGkIAMXaxt58SzxbjvP0kMr1JfJIZbic9vye\n"
    "NwIspMFIpP3FB8ywyu0T0hWtCQgL4J47nigCHpOu58deP88fS/Nyz/fyGVWOZ76b\n"
    "WhWwgM3P3X95fQ3d7oFPR/bVh0YV+Cf861INwplokXgXQ3/TCQ+HNXeAMWn3JLWv\n"
    "XFwk8owk9dq/kQGdndGgy3KTEW4ctPX5GNhf3LJ9Q7dLji4ReQ4=\n"
    "-----END CERTIFICATE-----\n";

static bssl::UniquePtr<CRYPTO_BUFFER> GetChainTestIntermediateBuffer() {
  return BufferFromPEM(kChainTestIntermediatePEM);
}

static bssl::UniquePtr<CRYPTO_BUFFER> GetChainTestIntermediateIssuerBuffer() {
  static const char kSubjectPEM[] =
      "-----BEGIN SUBJECT-----\n"
      "MBQxEjAQBgNVBAMMCUMgUm9vdCBDQQ==\n"
      "-----END SUBJECT-----\n";
  return BufferFromPEM(kSubjectPEM);
}

static bssl::UniquePtr<CRYPTO_BUFFER> GetTestCertIssuerBuffer() {
  static const char kSubjectPEM[] =
      "-----BEGIN SUBJECT-----\n"
      "MEUxCzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJ\n"
      "bnRlcm5ldCBXaWRnaXRzIFB0eSBMdGQ=\n"
      "-----END SUBJECT-----\n";
  return BufferFromPEM(kSubjectPEM);
}

static bssl::UniquePtr<CRYPTO_BUFFER> GetBogusIssuerBuffer() {
  static const char kSubjectPEM[] =
      "-----BEGIN SUBJECT-----\n"
      "MBYxFDASBgNVBAMMC0RpZ2lOb3RBRm94\n"
      "-----END SUBJECT-----\n";
  return BufferFromPEM(kSubjectPEM);
}

static bssl::UniquePtr<X509> GetChainTestIntermediate() {
  return X509FromBuffer(GetChainTestIntermediateBuffer());
}

static const char kChainTestKeyPEM[] =
    "-----BEGIN PRIVATE KEY-----\n"
    "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDRvaz8CC/cshpC\n"
    "afJo4jLkHEoBqDLhdgFelJoAiQUyIqyWl2O7YHPnpJH+TgR7oelzNzt/kLRcH89M\n"
    "/TszB6zqyLTC4aqmvzKL0peD/jL2LWBucR0WXIvjA3zoRuF/x86+rYH3tHb+xs2P\n"
    "Ss8EGL/Ev+ss+qTzTGEn26fuGNHkNw6tOwPpc+o8+wUtzf/kAthamo+cIDs2rQ+l\n"
    "P7+aLZTLeU/q4gcLutlzcK5imex5xy2jPkweq48kijK0kIzl1cPlA5d1z7C8jU50\n"
    "Pj9X9sQDJTN32j7UYRisJeeYQF8GaaN8SbrDI6zHgKzrRLyxDt/KQa9ViLeXANgZ\n"
    "i+Xx9KgfAgMBAAECggEBAK0VjSJzkyPaamcyTVSWjo7GdaBGcK60lk657RjR+lK0\n"
    "YJ7pkej4oM2hdsVZFsP8Cs4E33nXLa/0pDsRov/qrp0WQm2skwqGMC1I/bZ0WRPk\n"
    "wHaDrBBfESWnJDX/AGpVtlyOjPmgmK6J2usMPihQUDkKdAYrVWJePrMIxt1q6BMe\n"
    "iczs3qriMmtY3bUc4UyUwJ5fhDLjshHvfuIpYQyI6EXZM6dZksn9LylXJnigY6QJ\n"
    "HxOYO0BDwOsZ8yQ8J8afLk88i0GizEkgE1z3REtQUwgWfxr1WV/ud+T6/ZhSAgH9\n"
    "042mQvSFZnIUSEsmCvjhWuAunfxHKCTcAoYISWfzWpkCgYEA7gpf3HHU5Tn+CgUn\n"
    "1X5uGpG3DmcMgfeGgs2r2f/IIg/5Ac1dfYILiybL1tN9zbyLCJfcbFpWBc9hJL6f\n"
    "CPc5hUiwWFJqBJewxQkC1Ae/HakHbip+IZ+Jr0842O4BAArvixk4Lb7/N2Ct9sTE\n"
    "NJO6RtK9lbEZ5uK61DglHy8CS2UCgYEA4ZC1o36kPAMQBggajgnucb2yuUEelk0f\n"
    "AEr+GI32MGE+93xMr7rAhBoqLg4AITyIfEnOSQ5HwagnIHonBbv1LV/Gf9ursx8Z\n"
    "YOGbvT8zzzC+SU1bkDzdjAYnFQVGIjMtKOBJ3K07++ypwX1fr4QsQ8uKL8WSOWwt\n"
    "Z3Bym6XiZzMCgYADnhy+2OwHX85AkLt+PyGlPbmuelpyTzS4IDAQbBa6jcuW/2wA\n"
    "UE2km75VUXmD+u2R/9zVuLm99NzhFhSMqlUxdV1YukfqMfP5yp1EY6m/5aW7QuIP\n"
    "2MDa7TVL9rIFMiVZ09RKvbBbQxjhuzPQKL6X/PPspnhiTefQ+dl2k9xREQKBgHDS\n"
    "fMfGNEeAEKezrfSVqxphE9/tXms3L+ZpnCaT+yu/uEr5dTIAawKoQ6i9f/sf1/Sy\n"
    "xedsqR+IB+oKrzIDDWMgoJybN4pkZ8E5lzhVQIjFjKgFdWLzzqyW9z1gYfABQPlN\n"
    "FiS20WX0vgP1vcKAjdNrHzc9zyHBpgQzDmAj3NZZAoGBAI8vKCKdH7w3aL5CNkZQ\n"
    "2buIeWNA2HZazVwAGG5F2TU/LmXfRKnG6dX5bkU+AkBZh56jNZy//hfFSewJB4Kk\n"
    "buB7ERSdaNbO21zXt9FEA3+z0RfMd/Zv2vlIWOSB5nzl/7UKti3sribK6s9ZVLfi\n"
    "SxpiPQ8d/hmSGwn4ksrWUsJD\n"
    "-----END PRIVATE KEY-----\n";

static bssl::UniquePtr<EVP_PKEY> GetChainTestKey() {
  return KeyFromPEM(kChainTestKeyPEM);
}

static bool CompleteHandshakes(SSL *client, SSL *server) {
  // Drive both their handshakes to completion.
  for (;;) {
    int client_ret = SSL_do_handshake(client);
    int client_err = SSL_get_error(client, client_ret);
    if (client_err != SSL_ERROR_NONE &&        //
        client_err != SSL_ERROR_WANT_READ &&   //
        client_err != SSL_ERROR_WANT_WRITE &&  //
        client_err != SSL_ERROR_PENDING_TICKET) {
      fprintf(stderr, "Client error: %s\n", SSL_error_description(client_err));
      return false;
    }

    int server_ret = SSL_do_handshake(server);
    int server_err = SSL_get_error(server, server_ret);
    if (server_err != SSL_ERROR_NONE &&        //
        server_err != SSL_ERROR_WANT_READ &&   //
        server_err != SSL_ERROR_WANT_WRITE &&  //
        server_err != SSL_ERROR_PENDING_TICKET) {
      fprintf(stderr, "Server error: %s\n", SSL_error_description(server_err));
      return false;
    }

    if (client_ret == 1 && server_ret == 1) {
      break;
    }
  }

  return true;
}

static bool FlushNewSessionTickets(SSL *client, SSL *server) {
  // NewSessionTickets are deferred on the server to |SSL_write|, and clients do
  // not pick them up until |SSL_read|.
  for (;;) {
    int server_ret = SSL_write(server, nullptr, 0);
    int server_err = SSL_get_error(server, server_ret);
    // The server may either succeed (|server_ret| is zero) or block on write
    // (|server_ret| is -1 and |server_err| is |SSL_ERROR_WANT_WRITE|).
    if (server_ret > 0 ||
        (server_ret < 0 && server_err != SSL_ERROR_WANT_WRITE)) {
      fprintf(stderr, "Unexpected server result: %d %d\n", server_ret,
              server_err);
      return false;
    }

    int client_ret = SSL_read(client, nullptr, 0);
    int client_err = SSL_get_error(client, client_ret);
    // The client must always block on read.
    if (client_ret != -1 || client_err != SSL_ERROR_WANT_READ) {
      fprintf(stderr, "Unexpected client result: %d %d\n", client_ret,
              client_err);
      return false;
    }

    // The server flushed everything it had to write.
    if (server_ret == 0) {
      return true;
    }
  }
}

// CreateClientAndServer creates a client and server |SSL| objects whose |BIO|s
// are paired with each other. It does not run the handshake. The caller is
// expected to configure the objects and drive the handshake as needed.
static bool CreateClientAndServer(bssl::UniquePtr<SSL> *out_client,
                                  bssl::UniquePtr<SSL> *out_server,
                                  SSL_CTX *client_ctx, SSL_CTX *server_ctx) {
  bssl::UniquePtr<SSL> client(SSL_new(client_ctx)), server(SSL_new(server_ctx));
  if (!client || !server) {
    return false;
  }
  SSL_set_connect_state(client.get());
  SSL_set_accept_state(server.get());

  BIO *bio1, *bio2;
  if (!BIO_new_bio_pair(&bio1, 0, &bio2, 0)) {
    return false;
  }
  // SSL_set_bio takes ownership.
  SSL_set_bio(client.get(), bio1, bio1);
  SSL_set_bio(server.get(), bio2, bio2);

  *out_client = std::move(client);
  *out_server = std::move(server);
  return true;
}

struct ClientConfig {
  SSL_SESSION *session = nullptr;
  STACK_OF(CRYPTO_BUFFER) *ca_names = nullptr;
  std::string servername;
  std::string verify_hostname;
  unsigned hostflags = 0;
  bool early_data = false;
};

static bool ConnectClientAndServer(bssl::UniquePtr<SSL> *out_client,
                                   bssl::UniquePtr<SSL> *out_server,
                                   SSL_CTX *client_ctx, SSL_CTX *server_ctx,
                                   const ClientConfig &config = ClientConfig(),
                                   bool shed_handshake_config = true) {
  bssl::UniquePtr<SSL> client, server;
  if (!CreateClientAndServer(&client, &server, client_ctx, server_ctx)) {
    return false;
  }
  if (config.early_data) {
    SSL_set_early_data_enabled(client.get(), 1);
  }
  if (config.session) {
    SSL_set_session(client.get(), config.session);
  }
  if (!config.servername.empty() &&
      !SSL_set_tlsext_host_name(client.get(), config.servername.c_str())) {
    return false;
  }
  if (!config.verify_hostname.empty()) {
    if (!SSL_set1_host(client.get(), config.verify_hostname.c_str())) {
      return false;
    }
    SSL_set_hostflags(client.get(), config.hostflags);
  }

  if (config.ca_names) {
    SSL_set0_CA_names(client.get(), config.ca_names);
  }

  SSL_set_shed_handshake_config(client.get(), shed_handshake_config);
  SSL_set_shed_handshake_config(server.get(), shed_handshake_config);

  if (!CompleteHandshakes(client.get(), server.get())) {
    return false;
  }

  *out_client = std::move(client);
  *out_server = std::move(server);
  return true;
}

static bssl::UniquePtr<SSL_SESSION> g_last_session;

static int SaveLastSession(SSL *ssl, SSL_SESSION *session) {
  // Save the most recent session.
  g_last_session.reset(session);
  return 1;
}

static bssl::UniquePtr<SSL_SESSION> CreateClientSession(
    SSL_CTX *client_ctx, SSL_CTX *server_ctx,
    const ClientConfig &config = ClientConfig()) {
  g_last_session = nullptr;
  SSL_CTX_sess_set_new_cb(client_ctx, SaveLastSession);

  // Connect client and server to get a session.
  bssl::UniquePtr<SSL> client, server;
  if (!ConnectClientAndServer(&client, &server, client_ctx, server_ctx,
                              config) ||
      !FlushNewSessionTickets(client.get(), server.get())) {
    fprintf(stderr, "Failed to connect client and server.\n");
    return nullptr;
  }

  SSL_CTX_sess_set_new_cb(client_ctx, nullptr);

  if (!g_last_session) {
    fprintf(stderr, "Client did not receive a session.\n");
    return nullptr;
  }
  return std::move(g_last_session);
}

static void SetUpExpectedNewCodePoint(SSL_CTX *ctx) {
  SSL_CTX_set_select_certificate_cb(
      ctx,
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        const uint8_t *data;
        size_t len;
        if (!SSL_early_callback_ctx_extension_get(
                client_hello, TLSEXT_TYPE_application_settings, &data, &len)) {
          ADD_FAILURE() << "Could not find alps new codepoint.";
          return ssl_select_cert_error;
        }
        return ssl_select_cert_success;
      });
}

static void SetUpExpectedOldCodePoint(SSL_CTX *ctx) {
  SSL_CTX_set_select_certificate_cb(
      ctx,
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        const uint8_t *data;
        size_t len;
        if (!SSL_early_callback_ctx_extension_get(
                client_hello, TLSEXT_TYPE_application_settings_old, &data,
                &len)) {
          ADD_FAILURE() << "Could not find alps old codepoint.";
          return ssl_select_cert_error;
        }
        return ssl_select_cert_success;
      });
}

// Test that |SSL_get_client_CA_list| echoes back the configured parameter even
// before configuring as a server.
TEST(SSLTest, ClientCAList) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);

  bssl::UniquePtr<X509_NAME> name(X509_NAME_new());
  ASSERT_TRUE(name);

  bssl::UniquePtr<X509_NAME> name_dup(X509_NAME_dup(name.get()));
  ASSERT_TRUE(name_dup);

  bssl::UniquePtr<STACK_OF(X509_NAME)> stack(sk_X509_NAME_new_null());
  ASSERT_TRUE(stack);
  ASSERT_TRUE(PushToStack(stack.get(), std::move(name_dup)));

  // |SSL_set_client_CA_list| takes ownership.
  SSL_set_client_CA_list(ssl.get(), stack.release());

  STACK_OF(X509_NAME) *result = SSL_get_client_CA_list(ssl.get());
  ASSERT_TRUE(result);
  ASSERT_EQ(1u, sk_X509_NAME_num(result));
  EXPECT_EQ(0, X509_NAME_cmp(sk_X509_NAME_value(result, 0), name.get()));
}

TEST(SSLTest, AddClientCA) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);

  bssl::UniquePtr<X509> cert1 = GetTestCertificate();
  bssl::UniquePtr<X509> cert2 = GetChainTestCertificate();
  ASSERT_TRUE(cert1 && cert2);
  X509_NAME *name1 = X509_get_subject_name(cert1.get());
  X509_NAME *name2 = X509_get_subject_name(cert2.get());

  EXPECT_EQ(0u, sk_X509_NAME_num(SSL_get_client_CA_list(ssl.get())));

  ASSERT_TRUE(SSL_add_client_CA(ssl.get(), cert1.get()));
  ASSERT_TRUE(SSL_add_client_CA(ssl.get(), cert2.get()));

  STACK_OF(X509_NAME) *list = SSL_get_client_CA_list(ssl.get());
  ASSERT_EQ(2u, sk_X509_NAME_num(list));
  EXPECT_EQ(0, X509_NAME_cmp(sk_X509_NAME_value(list, 0), name1));
  EXPECT_EQ(0, X509_NAME_cmp(sk_X509_NAME_value(list, 1), name2));

  ASSERT_TRUE(SSL_add_client_CA(ssl.get(), cert1.get()));

  list = SSL_get_client_CA_list(ssl.get());
  ASSERT_EQ(3u, sk_X509_NAME_num(list));
  EXPECT_EQ(0, X509_NAME_cmp(sk_X509_NAME_value(list, 0), name1));
  EXPECT_EQ(0, X509_NAME_cmp(sk_X509_NAME_value(list, 1), name2));
  EXPECT_EQ(0, X509_NAME_cmp(sk_X509_NAME_value(list, 2), name1));
}

struct ECHConfigParams {
  uint16_t version = TLSEXT_TYPE_encrypted_client_hello;
  uint16_t config_id = 1;
  std::string public_name = "example.com";
  const EVP_HPKE_KEY *key = nullptr;
  // kem_id, if zero, takes its value from |key|.
  uint16_t kem_id = 0;
  // public_key, if empty takes its value from |key|.
  std::vector<uint8_t> public_key;
  size_t max_name_len = 16;
  // cipher_suites is a list of code points which should contain pairs of KDF
  // and AEAD IDs.
  std::vector<uint16_t> cipher_suites = {EVP_HPKE_HKDF_SHA256,
                                         EVP_HPKE_AES_128_GCM};
  std::vector<uint8_t> extensions;
};

// MakeECHConfig serializes an ECHConfig from |params| and writes it to
// |*out|.
bool MakeECHConfig(std::vector<uint8_t> *out, const ECHConfigParams &params) {
  uint16_t kem_id = params.kem_id == 0
                        ? EVP_HPKE_KEM_id(EVP_HPKE_KEY_kem(params.key))
                        : params.kem_id;
  std::vector<uint8_t> public_key = params.public_key;
  if (public_key.empty()) {
    public_key.resize(EVP_HPKE_MAX_PUBLIC_KEY_LENGTH);
    size_t len;
    if (!EVP_HPKE_KEY_public_key(params.key, public_key.data(), &len,
                                 public_key.size())) {
      return false;
    }
    public_key.resize(len);
  }

  bssl::ScopedCBB cbb;
  CBB contents, child;
  if (!CBB_init(cbb.get(), 64) ||                                      //
      !CBB_add_u16(cbb.get(), params.version) ||                       //
      !CBB_add_u16_length_prefixed(cbb.get(), &contents) ||            //
      !CBB_add_u8(&contents, params.config_id) ||                      //
      !CBB_add_u16(&contents, kem_id) ||                               //
      !CBB_add_u16_length_prefixed(&contents, &child) ||               //
      !CBB_add_bytes(&child, public_key.data(), public_key.size()) ||  //
      !CBB_add_u16_length_prefixed(&contents, &child)) {
    return false;
  }
  for (uint16_t cipher_suite : params.cipher_suites) {
    if (!CBB_add_u16(&child, cipher_suite)) {
      return false;
    }
  }
  if (!CBB_add_u8(&contents, params.max_name_len) ||
      !CBB_add_u8_length_prefixed(&contents, &child) ||
      !CBB_add_bytes(
          &child, reinterpret_cast<const uint8_t *>(params.public_name.data()),
          params.public_name.size()) ||
      !CBB_add_u16_length_prefixed(&contents, &child) ||
      !CBB_add_bytes(&child, params.extensions.data(),
                     params.extensions.size()) ||
      !CBB_flush(cbb.get())) {
    return false;
  }

  out->assign(CBB_data(cbb.get()), CBB_data(cbb.get()) + CBB_len(cbb.get()));
  return true;
}

static bssl::UniquePtr<SSL_ECH_KEYS> MakeTestECHKeys(uint8_t config_id = 1) {
  bssl::ScopedEVP_HPKE_KEY key;
  uint8_t *ech_config;
  size_t ech_config_len;
  if (!EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()) ||
      !SSL_marshal_ech_config(&ech_config, &ech_config_len, config_id,
                              key.get(), "public.example", 16)) {
    return nullptr;
  }
  bssl::UniquePtr<uint8_t> free_ech_config(ech_config);

  // Install a non-retry config.
  bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
  if (!keys || !SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1, ech_config,
                                 ech_config_len, key.get())) {
    return nullptr;
  }
  return keys;
}

static bool InstallECHConfigList(SSL *client, const SSL_ECH_KEYS *keys) {
  uint8_t *ech_config_list;
  size_t ech_config_list_len;
  if (!SSL_ECH_KEYS_marshal_retry_configs(keys, &ech_config_list,
                                          &ech_config_list_len)) {
    return false;
  }
  bssl::UniquePtr<uint8_t> free_ech_config_list(ech_config_list);
  return SSL_set1_ech_config_list(client, ech_config_list, ech_config_list_len);
}

// Test that |SSL_marshal_ech_config| and |SSL_ECH_KEYS_marshal_retry_configs|
// output values as expected.
TEST(SSLTest, MarshalECHConfig) {
  static const uint8_t kPrivateKey[X25519_PRIVATE_KEY_LEN] = {
      0xbc, 0xb5, 0x51, 0x29, 0x31, 0x10, 0x30, 0xc9, 0xed, 0x26, 0xde,
      0xd4, 0xb3, 0xdf, 0x3a, 0xce, 0x06, 0x8a, 0xee, 0x17, 0xab, 0xce,
      0xd7, 0xdb, 0xf3, 0x11, 0xe5, 0xa8, 0xf3, 0xb1, 0x8e, 0x24};
  bssl::ScopedEVP_HPKE_KEY key;
  ASSERT_TRUE(EVP_HPKE_KEY_init(key.get(), EVP_hpke_x25519_hkdf_sha256(),
                                kPrivateKey, sizeof(kPrivateKey)));

  static const uint8_t kECHConfig[] = {
      // version
      0xfe, 0x0d,
      // length
      0x00, 0x41,
      // contents.config_id
      0x01,
      // contents.kem_id
      0x00, 0x20,
      // contents.public_key
      0x00, 0x20, 0xa6, 0x9a, 0x41, 0x48, 0x5d, 0x32, 0x96, 0xa4, 0xe0, 0xc3,
      0x6a, 0xee, 0xf6, 0x63, 0x0f, 0x59, 0x32, 0x6f, 0xdc, 0xff, 0x81, 0x29,
      0x59, 0xa5, 0x85, 0xd3, 0x9b, 0x3b, 0xde, 0x98, 0x55, 0x5c,
      // contents.cipher_suites
      0x00, 0x08, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x03,
      // contents.maximum_name_length
      0x10,
      // contents.public_name
      0x0e, 0x70, 0x75, 0x62, 0x6c, 0x69, 0x63, 0x2e, 0x65, 0x78, 0x61, 0x6d,
      0x70, 0x6c, 0x65,
      // contents.extensions
      0x00, 0x00};
  uint8_t *ech_config;
  size_t ech_config_len;
  ASSERT_TRUE(SSL_marshal_ech_config(&ech_config, &ech_config_len,
                                     /*config_id=*/1, key.get(),
                                     "public.example", 16));
  bssl::UniquePtr<uint8_t> free_ech_config(ech_config);
  EXPECT_EQ(Bytes(kECHConfig), Bytes(ech_config, ech_config_len));

  // Generate a second ECHConfig.
  bssl::ScopedEVP_HPKE_KEY key2;
  ASSERT_TRUE(EVP_HPKE_KEY_generate(key2.get(), EVP_hpke_x25519_hkdf_sha256()));
  uint8_t *ech_config2;
  size_t ech_config2_len;
  ASSERT_TRUE(SSL_marshal_ech_config(&ech_config2, &ech_config2_len,
                                     /*config_id=*/2, key2.get(),
                                     "public.example", 16));
  bssl::UniquePtr<uint8_t> free_ech_config2(ech_config2);

  // Install both ECHConfigs in an |SSL_ECH_KEYS|.
  bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
  ASSERT_TRUE(keys);
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1, ech_config,
                               ech_config_len, key.get()));
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1, ech_config2,
                               ech_config2_len, key2.get()));

  // The ECHConfigList should be correctly serialized.
  uint8_t *ech_config_list;
  size_t ech_config_list_len;
  ASSERT_TRUE(SSL_ECH_KEYS_marshal_retry_configs(keys.get(), &ech_config_list,
                                                 &ech_config_list_len));
  bssl::UniquePtr<uint8_t> free_ech_config_list(ech_config_list);

  // ECHConfigList is just the concatenation with a length prefix.
  size_t len = ech_config_len + ech_config2_len;
  std::vector<uint8_t> expected = {uint8_t(len >> 8), uint8_t(len)};
  expected.insert(expected.end(), ech_config, ech_config + ech_config_len);
  expected.insert(expected.end(), ech_config2, ech_config2 + ech_config2_len);
  EXPECT_EQ(Bytes(expected), Bytes(ech_config_list, ech_config_list_len));
}

TEST(SSLTest, ECHHasDuplicateConfigID) {
  const struct {
    std::vector<uint8_t> ids;
    bool has_duplicate;
  } kTests[] = {
      {{}, false},
      {{1}, false},
      {{1, 2, 3, 255}, false},
      {{1, 2, 3, 1}, true},
  };
  for (const auto &test : kTests) {
    bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
    ASSERT_TRUE(keys);
    for (const uint8_t id : test.ids) {
      bssl::ScopedEVP_HPKE_KEY key;
      ASSERT_TRUE(
          EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()));
      uint8_t *ech_config;
      size_t ech_config_len;
      ASSERT_TRUE(SSL_marshal_ech_config(&ech_config, &ech_config_len, id,
                                         key.get(), "public.example", 16));
      bssl::UniquePtr<uint8_t> free_ech_config(ech_config);
      ASSERT_TRUE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                   ech_config, ech_config_len, key.get()));
    }

    EXPECT_EQ(test.has_duplicate ? 1 : 0,
              SSL_ECH_KEYS_has_duplicate_config_id(keys.get()));
  }
}

// Test that |SSL_ECH_KEYS_add| checks consistency between the public and
// private key.
TEST(SSLTest, ECHKeyConsistency) {
  bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
  ASSERT_TRUE(keys);
  bssl::ScopedEVP_HPKE_KEY key;
  ASSERT_TRUE(EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()));
  uint8_t public_key[EVP_HPKE_MAX_PUBLIC_KEY_LENGTH];
  size_t public_key_len;
  ASSERT_TRUE(EVP_HPKE_KEY_public_key(key.get(), public_key, &public_key_len,
                                      sizeof(public_key)));

  // Adding an ECHConfig with the matching public key succeeds.
  ECHConfigParams params;
  params.key = key.get();
  std::vector<uint8_t> ech_config;
  ASSERT_TRUE(MakeECHConfig(&ech_config, params));
  EXPECT_TRUE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                               ech_config.data(), ech_config.size(),
                               key.get()));

  // Adding an ECHConfig with the wrong public key is an error.
  bssl::ScopedEVP_HPKE_KEY wrong_key;
  ASSERT_TRUE(
      EVP_HPKE_KEY_generate(wrong_key.get(), EVP_hpke_x25519_hkdf_sha256()));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                wrong_key.get()));

  // Adding an ECHConfig with a truncated public key is an error.
  ECHConfigParams truncated;
  truncated.key = key.get();
  truncated.public_key.assign(public_key, public_key + public_key_len - 1);
  ASSERT_TRUE(MakeECHConfig(&ech_config, truncated));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));

  // Adding an ECHConfig with the right public key, but wrong KEM ID, is an
  // error.
  ECHConfigParams wrong_kem;
  wrong_kem.key = key.get();
  wrong_kem.kem_id = 0x0010;  // DHKEM(P-256, HKDF-SHA256)
  ASSERT_TRUE(MakeECHConfig(&ech_config, wrong_kem));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));
}

// Test that |SSL_CTX_set1_ech_keys| fails when the config list
// has no retry configs.
TEST(SSLTest, ECHServerConfigsWithoutRetryConfigs) {
  bssl::ScopedEVP_HPKE_KEY key;
  ASSERT_TRUE(EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()));
  uint8_t *ech_config;
  size_t ech_config_len;
  ASSERT_TRUE(SSL_marshal_ech_config(&ech_config, &ech_config_len,
                                     /*config_id=*/1, key.get(),
                                     "public.example", 16));
  bssl::UniquePtr<uint8_t> free_ech_config(ech_config);

  // Install a non-retry config.
  bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
  ASSERT_TRUE(keys);
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/0, ech_config,
                               ech_config_len, key.get()));

  // |keys| has no retry configs.
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  EXPECT_FALSE(SSL_CTX_set1_ech_keys(ctx.get(), keys.get()));

  // Add the same ECHConfig to the list, but this time mark it as a retry
  // config.
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1, ech_config,
                               ech_config_len, key.get()));
  EXPECT_TRUE(SSL_CTX_set1_ech_keys(ctx.get(), keys.get()));
}

// Test that the server APIs reject ECHConfigs with unsupported features.
TEST(SSLTest, UnsupportedECHConfig) {
  bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
  ASSERT_TRUE(keys);
  bssl::ScopedEVP_HPKE_KEY key;
  ASSERT_TRUE(EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()));

  // Unsupported versions are rejected.
  ECHConfigParams unsupported_version;
  unsupported_version.version = 0xffff;
  unsupported_version.key = key.get();
  std::vector<uint8_t> ech_config;
  ASSERT_TRUE(MakeECHConfig(&ech_config, unsupported_version));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));

  // Unsupported cipher suites are rejected. (We only support HKDF-SHA256.)
  ECHConfigParams unsupported_kdf;
  unsupported_kdf.key = key.get();
  unsupported_kdf.cipher_suites = {0x002 /* HKDF-SHA384 */,
                                   EVP_HPKE_AES_128_GCM};
  ASSERT_TRUE(MakeECHConfig(&ech_config, unsupported_kdf));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));
  ECHConfigParams unsupported_aead;
  unsupported_aead.key = key.get();
  unsupported_aead.cipher_suites = {EVP_HPKE_HKDF_SHA256, 0xffff};
  ASSERT_TRUE(MakeECHConfig(&ech_config, unsupported_aead));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));


  // Unsupported extensions are rejected.
  ECHConfigParams extensions;
  extensions.key = key.get();
  extensions.extensions = {0x00, 0x01, 0x00, 0x00};
  ASSERT_TRUE(MakeECHConfig(&ech_config, extensions));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));

  // Invalid public names are rejected.
  ECHConfigParams invalid_public_name;
  invalid_public_name.key = key.get();
  invalid_public_name.public_name = "dns_names_have_no_underscores.example";
  ASSERT_TRUE(MakeECHConfig(&ech_config, invalid_public_name));
  EXPECT_FALSE(SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1,
                                ech_config.data(), ech_config.size(),
                                key.get()));
}

// Test that |SSL_get_client_random| reports the correct value on both client
// and server in ECH. The client sends two different random values. When ECH is
// accepted, we should report the inner one.
TEST(SSLTest, ECHClientRandomsMatch) {
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL_ECH_KEYS> keys = MakeTestECHKeys();
  ASSERT_TRUE(keys);
  ASSERT_TRUE(SSL_CTX_set1_ech_keys(server_ctx.get(), keys.get()));

  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  ASSERT_TRUE(InstallECHConfigList(client.get(), keys.get()));
  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  EXPECT_TRUE(SSL_ech_accepted(client.get()));
  EXPECT_TRUE(SSL_ech_accepted(server.get()));

  // An ECH server will fairly naturally record the inner ClientHello random,
  // but an ECH client may forget to update the random once ClientHelloInner is
  // selected.
  uint8_t client_random1[SSL3_RANDOM_SIZE];
  uint8_t client_random2[SSL3_RANDOM_SIZE];
  ASSERT_EQ(sizeof(client_random1),
            SSL_get_client_random(client.get(), client_random1,
                                  sizeof(client_random1)));
  ASSERT_EQ(sizeof(client_random2),
            SSL_get_client_random(server.get(), client_random2,
                                  sizeof(client_random2)));
  EXPECT_EQ(Bytes(client_random1), Bytes(client_random2));
}

// GetECHLength sets |*out_client_hello_len| and |*out_ech_len| to the lengths
// of the ClientHello and ECH extension, respectively, when a client created
// from |ctx| constructs a ClientHello with name |name| and an ECHConfig with
// maximum name length |max_name_len|.
static bool GetECHLength(SSL_CTX *ctx, size_t *out_client_hello_len,
                         size_t *out_ech_len, size_t max_name_len,
                         const char *name) {
  bssl::ScopedEVP_HPKE_KEY key;
  uint8_t *ech_config;
  size_t ech_config_len;
  if (!EVP_HPKE_KEY_generate(key.get(), EVP_hpke_x25519_hkdf_sha256()) ||
      !SSL_marshal_ech_config(&ech_config, &ech_config_len,
                              /*config_id=*/1, key.get(), "public.example",
                              max_name_len)) {
    return false;
  }
  bssl::UniquePtr<uint8_t> free_ech_config(ech_config);

  bssl::UniquePtr<SSL_ECH_KEYS> keys(SSL_ECH_KEYS_new());
  if (!keys || !SSL_ECH_KEYS_add(keys.get(), /*is_retry_config=*/1, ech_config,
                                 ech_config_len, key.get())) {
    return false;
  }

  bssl::UniquePtr<SSL> ssl(SSL_new(ctx));
  if (!ssl || !InstallECHConfigList(ssl.get(), keys.get()) ||
      (name != nullptr && !SSL_set_tlsext_host_name(ssl.get(), name))) {
    return false;
  }
  SSL_set_connect_state(ssl.get());

  std::vector<uint8_t> client_hello;
  SSL_CLIENT_HELLO parsed;
  const uint8_t *unused;
  if (!GetClientHello(ssl.get(), &client_hello)) {
    return false;
  }
  // Skip record and handshake headers. This assumes the ClientHello
  // fits in one record.
  auto body =
      Span(client_hello).subspan(SSL3_RT_HEADER_LENGTH + SSL3_HM_HEADER_LENGTH);
  if (!SSL_parse_client_hello(ssl.get(), &parsed, body.data(), body.size()) ||
      !SSL_early_callback_ctx_extension_get(
          &parsed, TLSEXT_TYPE_encrypted_client_hello, &unused, out_ech_len)) {
    return false;
  }
  *out_client_hello_len = client_hello.size();
  return true;
}

TEST(SSLTest, ECHPadding) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Sample lengths with max_name_len = 128 as baseline.
  size_t client_hello_len_baseline, ech_len_baseline;
  ASSERT_TRUE(GetECHLength(ctx.get(), &client_hello_len_baseline,
                           &ech_len_baseline, 128, "example.com"));

  // Check that all name lengths under the server's maximum look the same.
  for (size_t name_len : {1, 2, 32, 64, 127, 128}) {
    SCOPED_TRACE(name_len);
    size_t client_hello_len, ech_len;
    ASSERT_TRUE(GetECHLength(ctx.get(), &client_hello_len, &ech_len, 128,
                             std::string(name_len, 'a').c_str()));
    EXPECT_EQ(client_hello_len, client_hello_len_baseline);
    EXPECT_EQ(ech_len, ech_len_baseline);
  }

  // When sending no SNI, we must still pad as if we are sending one.
  size_t client_hello_len, ech_len;
  ASSERT_TRUE(
      GetECHLength(ctx.get(), &client_hello_len, &ech_len, 128, nullptr));
  EXPECT_EQ(client_hello_len, client_hello_len_baseline);
  EXPECT_EQ(ech_len, ech_len_baseline);

  // Name lengths above the maximum do not get named-based padding, but the
  // overall input is padded to a multiple of 32.
  size_t client_hello_len_baseline2, ech_len_baseline2;
  ASSERT_TRUE(GetECHLength(ctx.get(), &client_hello_len_baseline2,
                           &ech_len_baseline2, 128,
                           std::string(128 + 32, 'a').c_str()));
  EXPECT_EQ(ech_len_baseline2, ech_len_baseline + 32);
  // The ClientHello lengths may match if we are still under the threshold for
  // padding extension.
  EXPECT_GE(client_hello_len_baseline2, client_hello_len_baseline);

  for (size_t name_len = 128 + 1; name_len < 128 + 32; name_len++) {
    SCOPED_TRACE(name_len);
    ASSERT_TRUE(GetECHLength(ctx.get(), &client_hello_len, &ech_len, 128,
                             std::string(name_len, 'a').c_str()));
    EXPECT_TRUE(ech_len == ech_len_baseline || ech_len == ech_len_baseline2)
        << ech_len;
    EXPECT_TRUE(client_hello_len == client_hello_len_baseline ||
                client_hello_len == client_hello_len_baseline2)
        << client_hello_len;
  }
}

TEST(SSLTest, ECHPublicName) {
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("")));
  EXPECT_TRUE(ssl_is_valid_ech_public_name(StringAsBytes("example.com")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes(".example.com")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("example.com.")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("example..com")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("www.-example.com")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("www.example-.com")));
  EXPECT_FALSE(
      ssl_is_valid_ech_public_name(StringAsBytes("no_underscores.example")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(
      StringAsBytes("invalid_chars.\x01.example")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(
      StringAsBytes("invalid_chars.\xff.example")));
  static const uint8_t kWithNUL[] = {'t', 'e', 's', 't', 0};
  EXPECT_FALSE(ssl_is_valid_ech_public_name(kWithNUL));

  // Test an LDH label with every character and the maximum length.
  EXPECT_TRUE(ssl_is_valid_ech_public_name(StringAsBytes(
      "abcdefhijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123456789")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes(
      "abcdefhijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOPQRSTUVWXYZ-01234567899")));

  // Inputs with trailing numeric components are rejected.
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("127.0.0.1")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("example.1")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("example.01")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("example.0x01")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("example.0X01")));
  // Leading zeros and values that overflow |uint32_t| are still rejected.
  EXPECT_FALSE(ssl_is_valid_ech_public_name(
      StringAsBytes("example.123456789000000000000000")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(
      StringAsBytes("example.012345678900000000000000")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(
      StringAsBytes("example.0x123456789abcdefABCDEF0")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(
      StringAsBytes("example.0x0123456789abcdefABCDEF")));
  // Adding a non-digit or non-hex character makes it a valid DNS name again.
  // Single-component numbers are rejected.
  EXPECT_TRUE(
      ssl_is_valid_ech_public_name(StringAsBytes("example.1234567890a")));
  EXPECT_TRUE(
      ssl_is_valid_ech_public_name(StringAsBytes("example.01234567890a")));
  EXPECT_TRUE(ssl_is_valid_ech_public_name(
      StringAsBytes("example.0x123456789abcdefg")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("1")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("01")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("0x01")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("0X01")));
  // Numbers with trailing dots are rejected. (They are already rejected by the
  // LDH label rules, but the WHATWG URL parser additionally rejects them.)
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("1.")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("01.")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("0x01.")));
  EXPECT_FALSE(ssl_is_valid_ech_public_name(StringAsBytes("0X01.")));
}

// When using the built-in verifier, test that |SSL_get0_ech_name_override| is
// applied automatically.
TEST(SSLTest, ECHBuiltinVerifier) {
  // These test certificates generated with the following Go program.
  /* clang-format off
func main() {
  notBefore := time.Date(2000, time.January, 1, 0, 0, 0, 0, time.UTC)
  notAfter := time.Date(2099, time.January, 1, 0, 0, 0, 0, time.UTC)
  rootKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
  rootTemplate := &x509.Certificate{
    SerialNumber:          big.NewInt(1),
    Subject:               pkix.Name{CommonName: "Test CA"},
    NotBefore:             notBefore,
    NotAfter:              notAfter,
    BasicConstraintsValid: true,
    IsCA:                  true,
  }
  rootDER, _ := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, &rootKey.PublicKey, rootKey)
  root, _ := x509.ParseCertificate(rootDER)
  pem.Encode(os.Stdout, &pem.Block{Type: "CERTIFICATE", Bytes: rootDER})
  leafKey, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
  leafKeyDER, _ := x509.MarshalPKCS8PrivateKey(leafKey)
  pem.Encode(os.Stdout, &pem.Block{Type: "PRIVATE KEY", Bytes: leafKeyDER})
  for i, name := range []string{"public.example", "secret.example"} {
    leafTemplate := &x509.Certificate{
      SerialNumber:          big.NewInt(int64(i) + 2),
      Subject:               pkix.Name{CommonName: name},
      NotBefore:             notBefore,
      NotAfter:              notAfter,
      BasicConstraintsValid: true,
      DNSNames:              []string{name},
    }
    leafDER, _ := x509.CreateCertificate(rand.Reader, leafTemplate, root, &leafKey.PublicKey, rootKey)
    pem.Encode(os.Stdout, &pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
  }
}
clang-format on */
  bssl::UniquePtr<X509> root = CertFromPEM(R"(
-----BEGIN CERTIFICATE-----
MIIBRzCB7aADAgECAgEBMAoGCCqGSM49BAMCMBIxEDAOBgNVBAMTB1Rlc3QgQ0Ew
IBcNMDAwMTAxMDAwMDAwWhgPMjA5OTAxMDEwMDAwMDBaMBIxEDAOBgNVBAMTB1Rl
c3QgQ0EwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAT5JUjrI1DAxSpEl88UkmJw
tAJqxo/YrSFo9V3MkcNkfTixi5p6MUtO8DazhEgekBcd2+tBAWtl7dy0qpvTqx92
ozIwMDAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTw6ftkexAI6o4r5FntJIfL
GU5F4zAKBggqhkjOPQQDAgNJADBGAiEAiiNowddQeHZaZFIygwe6RW5/WG4sUXWC
dkyl9CQzRaYCIQCFS1EvwZbZtMny27fYm1eeYciY0TkJTEi34H1KwyzzIA==
-----END CERTIFICATE-----
)");
  ASSERT_TRUE(root);
  bssl::UniquePtr<EVP_PKEY> leaf_key = KeyFromPEM(R"(
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgj5WKHwHnziiyPauf
7QukxTwtTyGZkk8qNdms4puJfxqhRANCAARNrkhxabALDlJrHtvkuDwvCWUF/oVC
hr6PDITHi1lDlJzvVT4aXBH87sH2n2UV5zpx13NHkq1bIC8eRT8eOIe0
-----END PRIVATE KEY-----
)");
  ASSERT_TRUE(leaf_key);
  bssl::UniquePtr<X509> leaf_public = CertFromPEM(R"(
-----BEGIN CERTIFICATE-----
MIIBaDCCAQ6gAwIBAgIBAjAKBggqhkjOPQQDAjASMRAwDgYDVQQDEwdUZXN0IENB
MCAXDTAwMDEwMTAwMDAwMFoYDzIwOTkwMTAxMDAwMDAwWjAZMRcwFQYDVQQDEw5w
dWJsaWMuZXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABE2uSHFpsAsO
Umse2+S4PC8JZQX+hUKGvo8MhMeLWUOUnO9VPhpcEfzuwfafZRXnOnHXc0eSrVsg
Lx5FPx44h7SjTDBKMAwGA1UdEwEB/wQCMAAwHwYDVR0jBBgwFoAU8On7ZHsQCOqO
K+RZ7SSHyxlOReMwGQYDVR0RBBIwEIIOcHVibGljLmV4YW1wbGUwCgYIKoZIzj0E
AwIDSAAwRQIhANqZRhDR/+QL05hsWXMYEwaiHifd9iakKoFEhKFchcF3AiBRAeXw
wRGGT6+iPmTYM6N5/IDyAb5B9Ke38O6lLEsUwA==
-----END CERTIFICATE-----
)");
  ASSERT_TRUE(leaf_public);
  bssl::UniquePtr<X509> leaf_secret = CertFromPEM(R"(
-----BEGIN CERTIFICATE-----
MIIBaTCCAQ6gAwIBAgIBAzAKBggqhkjOPQQDAjASMRAwDgYDVQQDEwdUZXN0IENB
MCAXDTAwMDEwMTAwMDAwMFoYDzIwOTkwMTAxMDAwMDAwWjAZMRcwFQYDVQQDEw5z
ZWNyZXQuZXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABE2uSHFpsAsO
Umse2+S4PC8JZQX+hUKGvo8MhMeLWUOUnO9VPhpcEfzuwfafZRXnOnHXc0eSrVsg
Lx5FPx44h7SjTDBKMAwGA1UdEwEB/wQCMAAwHwYDVR0jBBgwFoAU8On7ZHsQCOqO
K+RZ7SSHyxlOReMwGQYDVR0RBBIwEIIOc2VjcmV0LmV4YW1wbGUwCgYIKoZIzj0E
AwIDSQAwRgIhAPQdIz1xCFkc9WuSkxOxJDpywZiEp9SnKcxJ9nwrlRp3AiEA+O3+
XRqE7XFhHL+7TNC2a9OOAjQsEF137YPWo+rhgko=
-----END CERTIFICATE-----
)");
  ASSERT_TRUE(leaf_secret);

  // Use different config IDs so that fuzzer mode, which breaks trial
  // decryption, will observe the key mismatch.
  bssl::UniquePtr<SSL_ECH_KEYS> keys = MakeTestECHKeys(/*config_id=*/1);
  ASSERT_TRUE(keys);
  bssl::UniquePtr<SSL_ECH_KEYS> wrong_keys = MakeTestECHKeys(/*config_id=*/2);
  ASSERT_TRUE(wrong_keys);
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);

  // Configure the client to verify certificates and expect the secret name.
  // This is the name the client is trying to connect to. If ECH is rejected,
  // BoringSSL will internally override this setting with the public name.
  bssl::UniquePtr<X509_STORE> store(X509_STORE_new());
  ASSERT_TRUE(store);
  ASSERT_TRUE(X509_STORE_add_cert(store.get(), root.get()));
  SSL_CTX_set_cert_store(client_ctx.get(), store.release());
  SSL_CTX_set_verify(client_ctx.get(), SSL_VERIFY_PEER, nullptr);
  X509_VERIFY_PARAM_set_flags(SSL_CTX_get0_param(client_ctx.get()),
                              X509_V_FLAG_NO_CHECK_TIME);
  static const char kSecretName[] = "secret.example";
  ASSERT_TRUE(X509_VERIFY_PARAM_set1_host(SSL_CTX_get0_param(client_ctx.get()),
                                          kSecretName, strlen(kSecretName)));

  // For simplicity, we only run through a pair of representative scenarios here
  // and rely on runner.go to verify that |SSL_get0_ech_name_override| behaves
  // correctly.
  for (bool accept_ech : {false, true}) {
    SCOPED_TRACE(accept_ech);
    for (bool use_leaf_secret : {false, true}) {
      SCOPED_TRACE(use_leaf_secret);

      // The server will reject ECH when configured with the wrong keys.
      ASSERT_TRUE(SSL_CTX_set1_ech_keys(
          server_ctx.get(), accept_ech ? keys.get() : wrong_keys.get()));

      bssl::UniquePtr<SSL> client, server;
      ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                        server_ctx.get()));
      ASSERT_TRUE(InstallECHConfigList(client.get(), keys.get()));

      // Configure the server with the selected certificate.
      ASSERT_TRUE(SSL_use_certificate(server.get(), use_leaf_secret
                                                        ? leaf_secret.get()
                                                        : leaf_public.get()));
      ASSERT_TRUE(SSL_use_PrivateKey(server.get(), leaf_key.get()));

      // The handshake may fail due to name mismatch or ECH reject. We check
      // |SSL_get_verify_result| to confirm the handshake got far enough.
      CompleteHandshakes(client.get(), server.get());
      EXPECT_EQ(accept_ech == use_leaf_secret ? X509_V_OK
                                              : X509_V_ERR_HOSTNAME_MISMATCH,
                SSL_get_verify_result(client.get()));
    }
  }
}

#if defined(OPENSSL_THREADS)
// Test that the server ECH config can be swapped out while the |SSL_CTX| is
// in use on other threads. This test is intended to be run with TSan.
TEST(SSLTest, ECHThreads) {
  // Generate a pair of ECHConfigs.
  bssl::ScopedEVP_HPKE_KEY key1;
  ASSERT_TRUE(EVP_HPKE_KEY_generate(key1.get(), EVP_hpke_x25519_hkdf_sha256()));
  uint8_t *ech_config1;
  size_t ech_config1_len;
  ASSERT_TRUE(SSL_marshal_ech_config(&ech_config1, &ech_config1_len,
                                     /*config_id=*/1, key1.get(),
                                     "public.example", 16));
  bssl::UniquePtr<uint8_t> free_ech_config1(ech_config1);
  bssl::ScopedEVP_HPKE_KEY key2;
  ASSERT_TRUE(EVP_HPKE_KEY_generate(key2.get(), EVP_hpke_x25519_hkdf_sha256()));
  uint8_t *ech_config2;
  size_t ech_config2_len;
  ASSERT_TRUE(SSL_marshal_ech_config(&ech_config2, &ech_config2_len,
                                     /*config_id=*/2, key2.get(),
                                     "public.example", 16));
  bssl::UniquePtr<uint8_t> free_ech_config2(ech_config2);

  // |keys1| contains the first config. |keys12| contains both.
  bssl::UniquePtr<SSL_ECH_KEYS> keys1(SSL_ECH_KEYS_new());
  ASSERT_TRUE(keys1);
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys1.get(), /*is_retry_config=*/1, ech_config1,
                               ech_config1_len, key1.get()));
  bssl::UniquePtr<SSL_ECH_KEYS> keys12(SSL_ECH_KEYS_new());
  ASSERT_TRUE(keys12);
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys12.get(), /*is_retry_config=*/1, ech_config2,
                               ech_config2_len, key2.get()));
  ASSERT_TRUE(SSL_ECH_KEYS_add(keys12.get(), /*is_retry_config=*/0, ech_config1,
                               ech_config1_len, key1.get()));

  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(server_ctx);
  ASSERT_TRUE(SSL_CTX_set1_ech_keys(server_ctx.get(), keys1.get()));

  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  ASSERT_TRUE(InstallECHConfigList(client.get(), keys1.get()));

  // In parallel, complete the connection and reconfigure the ECHConfig. Note
  // |keys12| supports all the keys in |keys1|, so the handshake should complete
  // the same whichever the server uses.
  std::vector<std::thread> threads;
  threads.emplace_back([&] {
    ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));
    EXPECT_TRUE(SSL_ech_accepted(client.get()));
    EXPECT_TRUE(SSL_ech_accepted(server.get()));
  });
  threads.emplace_back([&] {
    EXPECT_TRUE(SSL_CTX_set1_ech_keys(server_ctx.get(), keys12.get()));
  });
  for (auto &thread : threads) {
    thread.join();
  }
}
#endif  // OPENSSL_THREADS

TEST(SSLTest, TLS13ExporterAvailability) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  // Configure only TLS 1.3.
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(client_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), TLS1_3_VERSION));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));

  std::vector<uint8_t> buffer(32);
  const char *label = "EXPORTER-test-label";

  // The exporters are not available before the handshake starts.
  EXPECT_FALSE(SSL_export_keying_material(client.get(), buffer.data(),
                                          buffer.size(), label, strlen(label),
                                          nullptr, 0, 0));
  EXPECT_FALSE(SSL_export_keying_material(server.get(), buffer.data(),
                                          buffer.size(), label, strlen(label),
                                          nullptr, 0, 0));

  // Send the client's first flight of handshake messages.
  int client_ret = SSL_do_handshake(client.get());
  EXPECT_EQ(SSL_get_error(client.get(), client_ret), SSL_ERROR_WANT_READ);

  // The handshake isn't far enough for the exporters to work.
  EXPECT_FALSE(SSL_export_keying_material(client.get(), buffer.data(),
                                          buffer.size(), label, strlen(label),
                                          nullptr, 0, 0));
  EXPECT_FALSE(SSL_export_keying_material(server.get(), buffer.data(),
                                          buffer.size(), label, strlen(label),
                                          nullptr, 0, 0));

  // Send all the server's handshake messages.
  int server_ret = SSL_do_handshake(server.get());
  EXPECT_EQ(SSL_get_error(server.get(), server_ret), SSL_ERROR_WANT_READ);

  // At this point in the handshake, the server should have the exporter key
  // derived since it's sent its Finished message. The client hasn't yet
  // processed the server's handshake messages, so the exporter shouldn't be
  // available to the client.
  EXPECT_FALSE(SSL_export_keying_material(client.get(), buffer.data(),
                                          buffer.size(), label, strlen(label),
                                          nullptr, 0, 0));
  EXPECT_TRUE(SSL_export_keying_material(server.get(), buffer.data(),
                                         buffer.size(), label, strlen(label),
                                         nullptr, 0, 0));

  // Finish the handshake on the client.
  EXPECT_EQ(SSL_do_handshake(client.get()), 1);

  // The exporter should be available on both endpoints.
  EXPECT_TRUE(SSL_export_keying_material(client.get(), buffer.data(),
                                         buffer.size(), label, strlen(label),
                                         nullptr, 0, 0));
  EXPECT_TRUE(SSL_export_keying_material(server.get(), buffer.data(),
                                         buffer.size(), label, strlen(label),
                                         nullptr, 0, 0));

  // Finish the handshake on the server.
  EXPECT_EQ(SSL_do_handshake(server.get()), 1);

  // The exporter should still be available on both endpoints.
  EXPECT_TRUE(SSL_export_keying_material(client.get(), buffer.data(),
                                         buffer.size(), label, strlen(label),
                                         nullptr, 0, 0));
  EXPECT_TRUE(SSL_export_keying_material(server.get(), buffer.data(),
                                         buffer.size(), label, strlen(label),
                                         nullptr, 0, 0));
}

static void AppendSession(SSL_SESSION *session, void *arg) {
  std::vector<SSL_SESSION *> *out =
      reinterpret_cast<std::vector<SSL_SESSION *> *>(arg);
  out->push_back(session);
}

// CacheEquals returns true if |ctx|'s session cache consists of |expected|, in
// order.
static bool CacheEquals(SSL_CTX *ctx,
                        const std::vector<SSL_SESSION *> &expected) {
  // Check the linked list.
  SSL_SESSION *ptr = ctx->session_cache_head;
  for (SSL_SESSION *session : expected) {
    if (ptr != session) {
      return false;
    }
    // TODO(davidben): This is an absurd way to denote the end of the list.
    if (ptr->next ==
        reinterpret_cast<SSL_SESSION *>(&ctx->session_cache_tail)) {
      ptr = nullptr;
    } else {
      ptr = ptr->next;
    }
  }
  if (ptr != nullptr) {
    return false;
  }

  // Check the hash table.
  std::vector<SSL_SESSION *> actual, expected_copy;
  lh_SSL_SESSION_doall_arg(ctx->sessions, AppendSession, &actual);
  expected_copy = expected;

  std::sort(actual.begin(), actual.end());
  std::sort(expected_copy.begin(), expected_copy.end());

  return actual == expected_copy;
}

static bssl::UniquePtr<SSL_SESSION> CreateTestSession(uint32_t number) {
  bssl::UniquePtr<SSL_CTX> ssl_ctx(SSL_CTX_new(TLS_method()));
  if (!ssl_ctx) {
    return nullptr;
  }
  bssl::UniquePtr<SSL_SESSION> ret(SSL_SESSION_new(ssl_ctx.get()));
  if (!ret) {
    return nullptr;
  }

  uint8_t id[SSL3_SSL_SESSION_ID_LENGTH] = {0};
  OPENSSL_memcpy(id, &number, sizeof(number));
  if (!SSL_SESSION_set1_id(ret.get(), id, sizeof(id))) {
    return nullptr;
  }
  return ret;
}

// Test that the internal session cache behaves as expected.
TEST(SSLTest, InternalSessionCache) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Prepare 10 test sessions.
  std::vector<bssl::UniquePtr<SSL_SESSION>> sessions;
  for (int i = 0; i < 10; i++) {
    bssl::UniquePtr<SSL_SESSION> session = CreateTestSession(i);
    ASSERT_TRUE(session);
    sessions.push_back(std::move(session));
  }

  SSL_CTX_sess_set_cache_size(ctx.get(), 5);

  // Insert all the test sessions.
  for (const auto &session : sessions) {
    ASSERT_TRUE(SSL_CTX_add_session(ctx.get(), session.get()));
  }

  // Only the last five should be in the list.
  ASSERT_TRUE(CacheEquals(
      ctx.get(), {sessions[9].get(), sessions[8].get(), sessions[7].get(),
                  sessions[6].get(), sessions[5].get()}));

  // Inserting an element already in the cache should fail and leave the cache
  // unchanged.
  ASSERT_FALSE(SSL_CTX_add_session(ctx.get(), sessions[7].get()));
  ASSERT_TRUE(CacheEquals(
      ctx.get(), {sessions[9].get(), sessions[8].get(), sessions[7].get(),
                  sessions[6].get(), sessions[5].get()}));

  // Although collisions should be impossible (256-bit session IDs), the cache
  // must handle them gracefully.
  bssl::UniquePtr<SSL_SESSION> collision(CreateTestSession(7));
  ASSERT_TRUE(collision);
  ASSERT_TRUE(SSL_CTX_add_session(ctx.get(), collision.get()));
  ASSERT_TRUE(CacheEquals(
      ctx.get(), {collision.get(), sessions[9].get(), sessions[8].get(),
                  sessions[6].get(), sessions[5].get()}));

  // Removing sessions behaves correctly.
  ASSERT_TRUE(SSL_CTX_remove_session(ctx.get(), sessions[6].get()));
  ASSERT_TRUE(CacheEquals(ctx.get(), {collision.get(), sessions[9].get(),
                                      sessions[8].get(), sessions[5].get()}));

  // Removing sessions requires an exact match.
  ASSERT_FALSE(SSL_CTX_remove_session(ctx.get(), sessions[0].get()));
  ASSERT_FALSE(SSL_CTX_remove_session(ctx.get(), sessions[7].get()));

  // The cache remains unchanged.
  ASSERT_TRUE(CacheEquals(ctx.get(), {collision.get(), sessions[9].get(),
                                      sessions[8].get(), sessions[5].get()}));
}

static uint16_t EpochFromSequence(uint64_t seq) {
  return static_cast<uint16_t>(seq >> 48);
}

static const uint8_t kTestName[] = {
    0x30, 0x45, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55, 0x04, 0x06, 0x13,
    0x02, 0x41, 0x55, 0x31, 0x13, 0x30, 0x11, 0x06, 0x03, 0x55, 0x04, 0x08,
    0x0c, 0x0a, 0x53, 0x6f, 0x6d, 0x65, 0x2d, 0x53, 0x74, 0x61, 0x74, 0x65,
    0x31, 0x21, 0x30, 0x1f, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x0c, 0x18, 0x49,
    0x6e, 0x74, 0x65, 0x72, 0x6e, 0x65, 0x74, 0x20, 0x57, 0x69, 0x64, 0x67,
    0x69, 0x74, 0x73, 0x20, 0x50, 0x74, 0x79, 0x20, 0x4c, 0x74, 0x64,
};

// SSLVersionTest executes its test cases under all available protocol versions.
// Test cases call |Connect| to create a connection using context objects with
// the protocol version fixed to the current version under test.
class SSLVersionTest : public ::testing::TestWithParam<VersionParam> {
 protected:
  SSLVersionTest() : cert_(GetTestCertificate()), key_(GetTestKey()) {}

  void SetUp() { ResetContexts(); }

  bssl::UniquePtr<SSL_CTX> CreateContext() const {
    const SSL_METHOD *method = is_dtls() ? DTLS_method() : TLS_method();
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(method));
    if (!ctx || !SSL_CTX_set_min_proto_version(ctx.get(), version()) ||
        !SSL_CTX_set_max_proto_version(ctx.get(), version())) {
      return nullptr;
    }
    return ctx;
  }

  void ResetContexts() {
    ASSERT_TRUE(cert_);
    ASSERT_TRUE(key_);
    client_ctx_ = CreateContext();
    ASSERT_TRUE(client_ctx_);
    server_ctx_ = CreateContext();
    ASSERT_TRUE(server_ctx_);
    // Set up a server cert. Client certs can be set up explicitly.
    ASSERT_TRUE(UseCertAndKey(server_ctx_.get()));
  }

  bool UseCertAndKey(SSL_CTX *ctx) const {
    return SSL_CTX_use_certificate(ctx, cert_.get()) &&
           SSL_CTX_use_PrivateKey(ctx, key_.get());
  }

  bool Connect(const ClientConfig &config = ClientConfig()) {
    return ConnectClientAndServer(&client_, &server_, client_ctx_.get(),
                                  server_ctx_.get(), config,
                                  shed_handshake_config_);
  }

  uint16_t version() const { return GetParam().version; }

  bool is_tls13() const {
    return version() == TLS1_3_VERSION || version() == DTLS1_3_VERSION;
  }

  bool is_dtls() const {
    return GetParam().ssl_method == VersionParam::is_dtls;
  }

  bool shed_handshake_config_ = true;
  bssl::UniquePtr<SSL> client_, server_;
  bssl::UniquePtr<SSL_CTX> server_ctx_, client_ctx_;
  bssl::UniquePtr<X509> cert_;
  bssl::UniquePtr<EVP_PKEY> key_;
};

INSTANTIATE_TEST_SUITE_P(WithVersion, SSLVersionTest,
                         testing::ValuesIn(kAllVersions),
                         [](const testing::TestParamInfo<VersionParam> &i) {
                           return i.param.name;
                         });

TEST_P(SSLVersionTest, SequenceNumber) {
  // TODO(crbug.com/42290608): Once |SSL_get_read_sequence| and
  // |SSL_get_write_sequence| are no longer implemented in DTLS 1.3, make this
  // test TLS-only and remove the DTLS cases. For now, since we still care about
  // their behavior in DTLS 1.2, continue testing this behavior.
  if (is_dtls() && is_tls13()) {
    return;
  }

  ASSERT_TRUE(Connect());

  // Drain any post-handshake messages to ensure there are no unread records
  // on either end.
  ASSERT_TRUE(FlushNewSessionTickets(client_.get(), server_.get()));

  uint64_t client_read_seq = SSL_get_read_sequence(client_.get());
  uint64_t client_write_seq = SSL_get_write_sequence(client_.get());
  uint64_t server_read_seq = SSL_get_read_sequence(server_.get());
  uint64_t server_write_seq = SSL_get_write_sequence(server_.get());

  if (is_dtls()) {
    // Both client and server must be at epoch 1.
    EXPECT_EQ(EpochFromSequence(client_read_seq), 1);
    EXPECT_EQ(EpochFromSequence(client_write_seq), 1);
    EXPECT_EQ(EpochFromSequence(server_read_seq), 1);
    EXPECT_EQ(EpochFromSequence(server_write_seq), 1);

    // The next record to be written should exceed the largest received.
    EXPECT_GT(client_write_seq, server_read_seq);
    EXPECT_GT(server_write_seq, client_read_seq);
  } else {
    // The next record to be written should equal the next to be received.
    EXPECT_EQ(client_write_seq, server_read_seq);
    EXPECT_EQ(server_write_seq, client_read_seq);
  }

  // Send a record from client to server.
  uint8_t byte = 0;
  EXPECT_EQ(SSL_write(client_.get(), &byte, 1), 1);
  EXPECT_EQ(SSL_read(server_.get(), &byte, 1), 1);

  // The client write and server read sequence numbers should have
  // incremented.
  EXPECT_EQ(client_write_seq + 1, SSL_get_write_sequence(client_.get()));
  EXPECT_EQ(server_read_seq + 1, SSL_get_read_sequence(server_.get()));
}

TEST_P(SSLVersionTest, RecordStateDTLS) {
  if (!is_dtls()) {
    return;
  }

  SSL_CTX_set_current_time_cb(client_ctx_.get(), CurrentTimeCallback);
  SSL_CTX_set_current_time_cb(server_ctx_.get(), CurrentTimeCallback);

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  // The handshake is incomplete.
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(client_.get()));
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(server_.get()));

  // The initial epoch is zero.
  EXPECT_EQ(SSL_get_dtls_read_epoch(client_.get()), 0);
  EXPECT_EQ(SSL_get_dtls_write_epoch(server_.get()), 0);
  EXPECT_EQ(SSL_get_dtls_read_epoch(server_.get()), 0);
  EXPECT_EQ(SSL_get_dtls_write_epoch(client_.get()), 0);

  // We have not sent or received any records.
  EXPECT_EQ(SSL_get_dtls_read_sequence(client_.get(), 0), 0u);
  EXPECT_EQ(SSL_get_dtls_write_sequence(server_.get(), 0), 0u);
  EXPECT_EQ(SSL_get_dtls_read_sequence(server_.get(), 0), 0u);
  EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 0), 0u);

  // We have not sent or received any handshake messages.
  EXPECT_EQ(SSL_get_dtls_handshake_read_seq(client_.get()), 0u);
  EXPECT_EQ(SSL_get_dtls_handshake_write_seq(server_.get()), 0u);
  EXPECT_EQ(SSL_get_dtls_handshake_read_seq(server_.get()), 0u);
  EXPECT_EQ(SSL_get_dtls_handshake_write_seq(client_.get()), 0u);

  // Though it exists, epoch zero is unencrypted and does not have traffic
  // secrets.
  const uint8_t *data;
  size_t len;
  EXPECT_FALSE(SSL_get_dtls_read_traffic_secret(client_.get(), &data, &len, 0));
  EXPECT_FALSE(
      SSL_get_dtls_write_traffic_secret(client_.get(), &data, &len, 0));
  EXPECT_FALSE(SSL_get_dtls_read_traffic_secret(server_.get(), &data, &len, 0));
  EXPECT_FALSE(
      SSL_get_dtls_write_traffic_secret(server_.get(), &data, &len, 0));

  // Other epochs do not exist yet.
  EXPECT_EQ(SSL_get_dtls_read_sequence(client_.get(), 1), UINT64_MAX);
  EXPECT_EQ(SSL_get_dtls_write_sequence(server_.get(), 1), UINT64_MAX);
  EXPECT_EQ(SSL_get_dtls_read_sequence(server_.get(), 1), UINT64_MAX);
  EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 1), UINT64_MAX);
  EXPECT_FALSE(SSL_get_dtls_read_traffic_secret(client_.get(), &data, &len, 1));
  EXPECT_FALSE(
      SSL_get_dtls_write_traffic_secret(server_.get(), &data, &len, 1));
  EXPECT_FALSE(SSL_get_dtls_read_traffic_secret(server_.get(), &data, &len, 1));
  EXPECT_FALSE(
      SSL_get_dtls_write_traffic_secret(client_.get(), &data, &len, 1));

  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));

  // DTLS 1.0 and 1.2 are relative simple.
  if (!is_tls13()) {
    // This handshake is now idle.
    EXPECT_TRUE(SSL_is_dtls_handshake_idle(client_.get()));
    EXPECT_TRUE(SSL_is_dtls_handshake_idle(server_.get()));

    // Both sides of both channels are at epoch 1.
    EXPECT_EQ(SSL_get_dtls_read_epoch(client_.get()), 1);
    EXPECT_EQ(SSL_get_dtls_write_epoch(server_.get()), 1);
    EXPECT_EQ(SSL_get_dtls_read_epoch(server_.get()), 1);
    EXPECT_EQ(SSL_get_dtls_write_epoch(client_.get()), 1);

    // Both sides have sent one record at epoch 1 each (Finished).
    EXPECT_EQ(SSL_get_dtls_read_sequence(client_.get(), 1), 1u);
    EXPECT_EQ(SSL_get_dtls_write_sequence(server_.get(), 1), 1u);
    EXPECT_EQ(SSL_get_dtls_read_sequence(server_.get(), 1), 1u);
    EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 1), 1u);

    // DTLS 1.2 does not use traffic secrets.
    EXPECT_FALSE(
        SSL_get_dtls_read_traffic_secret(client_.get(), &data, &len, 1));
    EXPECT_FALSE(
        SSL_get_dtls_write_traffic_secret(server_.get(), &data, &len, 1));
    EXPECT_FALSE(
        SSL_get_dtls_read_traffic_secret(server_.get(), &data, &len, 1));
    EXPECT_FALSE(
        SSL_get_dtls_write_traffic_secret(client_.get(), &data, &len, 1));

    // Send a record from client to server.
    uint8_t byte = 0;
    EXPECT_EQ(SSL_write(client_.get(), &byte, 1), 1);
    EXPECT_EQ(SSL_read(server_.get(), &byte, 1), 1);

    // Sequence numbers should have updated.
    EXPECT_EQ(SSL_get_dtls_read_sequence(client_.get(), 1), 1u);
    EXPECT_EQ(SSL_get_dtls_write_sequence(server_.get(), 1), 1u);
    EXPECT_EQ(SSL_get_dtls_read_sequence(server_.get(), 1), 2u);
    EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 1), 2u);
    return;
  }

  // The client sent Finished, which the server ACKed, but the client hasn't
  // consumed the ACK.
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(client_.get()));
  // The server sent NewSessionTicket, which the client hasn't consumed yet.
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(server_.get()));

  // Both sides of both channels are at epoch 3.
  EXPECT_EQ(SSL_get_dtls_read_epoch(client_.get()), 3);
  EXPECT_EQ(SSL_get_dtls_write_epoch(server_.get()), 3);
  EXPECT_EQ(SSL_get_dtls_read_epoch(server_.get()), 3);
  EXPECT_EQ(SSL_get_dtls_write_epoch(client_.get()), 3);

  auto check_matching_secret = [&](SSL *reader, SSL *writer, uint16_t epoch) {
    ASSERT_TRUE(SSL_get_dtls_read_traffic_secret(reader, &data, &len, epoch));
    auto read_secret = Span(data, len);
    ASSERT_TRUE(SSL_get_dtls_write_traffic_secret(writer, &data, &len, epoch));
    auto write_secret = Span(data, len);
    EXPECT_EQ(Bytes(read_secret), Bytes(write_secret));
  };

  // Traffic secrets at epoch 3 should match.
  check_matching_secret(client_.get(), server_.get(), 3);
  check_matching_secret(server_.get(), client_.get(), 3);

  // Both sides retain read epoch 2 (but not write epoch 2). The server must
  // retain epoch 2 because it does not know the client has seen the ACK and
  // therefore must respond to retransmissions of the client's final flight.
  // The client could discard epoch 2, but our implementation happens not to.
  EXPECT_LT(SSL_get_dtls_read_sequence(client_.get(), 2), UINT64_MAX);
  EXPECT_LT(SSL_get_dtls_read_sequence(server_.get(), 2), UINT64_MAX);
  EXPECT_TRUE(SSL_get_dtls_read_traffic_secret(client_.get(), &data, &len, 2));
  EXPECT_TRUE(SSL_get_dtls_read_traffic_secret(server_.get(), &data, &len, 2));

  // The client has not sent anything over epoch 3.
  EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 3), 0u);
  EXPECT_EQ(SSL_get_dtls_read_sequence(server_.get(), 3), 0u);

  // The server has (ACK and NewSessionTicket), but the client has not seen it.
  EXPECT_GT(SSL_get_dtls_write_sequence(server_.get(), 3), 0u);
  EXPECT_EQ(SSL_get_dtls_read_sequence(client_.get(), 3), 0u);

  // Read from the client. No application data, but this will consume the
  // records. We send ACKs on a timer, so advance the clock to flush it.
  uint8_t byte;
  EXPECT_EQ(SSL_read(client_.get(), &byte, 1), -1);
  EXPECT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_READ);
  g_current_time.tv_sec++;
  EXPECT_EQ(DTLSv1_handle_timeout(client_.get()), 1);

  // The client has now picked up the ACK and is idle.
  EXPECT_TRUE(SSL_is_dtls_handshake_idle(client_.get()));

  // The client has caught up to what the server wrote.
  EXPECT_EQ(SSL_get_dtls_write_sequence(server_.get(), 3),
            SSL_get_dtls_read_sequence(client_.get(), 3));

  // The client saw NewSessionTicket and sent an ACK.
  EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 3), 1u);

  // Pick up the ACK from the server.
  EXPECT_EQ(SSL_read(server_.get(), &byte, 1), -1);
  EXPECT_EQ(SSL_get_error(server_.get(), -1), SSL_ERROR_WANT_READ);

  // Now the server is also idle.
  EXPECT_TRUE(SSL_is_dtls_handshake_idle(server_.get()));

  // The server has seen the ACK and has caught up to the client.
  EXPECT_EQ(SSL_get_dtls_write_sequence(client_.get(), 3),
            SSL_get_dtls_read_sequence(server_.get(), 3));

  // Exchange some data. Sequence numbers should increment.
  uint64_t old_seq = SSL_get_dtls_write_sequence(server_.get(), 3);
  byte = 42;
  ASSERT_EQ(SSL_write(server_.get(), &byte, 1), 1);
  ASSERT_EQ(SSL_read(client_.get(), &byte, 1), 1);
  EXPECT_EQ(SSL_get_dtls_write_sequence(server_.get(), 3), old_seq + 1);
  EXPECT_EQ(SSL_get_dtls_read_sequence(client_.get(), 3), old_seq + 1);

  // Now that everyone's caught up, handshake sequence numbers should be
  // non-zero and match.
  uint32_t client_hs_seq = SSL_get_dtls_handshake_write_seq(client_.get());
  EXPECT_NE(client_hs_seq, 0u);
  EXPECT_EQ(client_hs_seq, SSL_get_dtls_handshake_read_seq(server_.get()));
  uint32_t server_hs_seq = SSL_get_dtls_handshake_write_seq(server_.get());
  EXPECT_NE(server_hs_seq, 0u);
  EXPECT_EQ(server_hs_seq, SSL_get_dtls_handshake_read_seq(client_.get()));

  // Enqueue a KeyUpdate that requests the peer do the same. The client is now
  // busy.
  ASSERT_TRUE(SSL_key_update(client_.get(), SSL_KEY_UPDATE_REQUESTED));
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(client_.get()));
  // Flush the KeyUpdate to the transport. (We currently flush incidental
  // traffic on read because callers are expected to be constantly reading.)
  // The client has an unacked message, so it is still busy.
  EXPECT_EQ(SSL_read(client_.get(), &byte, 1), -1);
  EXPECT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_READ);
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(client_.get()));

  // KeyUpdates are driven by ACKs, so the client is still at epoch 3.
  EXPECT_EQ(SSL_get_dtls_write_epoch(client_.get()), 3);

  // Consume the KeyUpdate on the server and wait for the ACK timer. The server
  // has now ACKed the KeyUpdate, advanced to read epoch 4, and sent a KeyUpdate
  // of its own.
  EXPECT_EQ(SSL_read(server_.get(), &byte, 1), -1);
  EXPECT_EQ(SSL_get_error(server_.get(), -1), SSL_ERROR_WANT_READ);
  g_current_time.tv_sec++;
  EXPECT_EQ(DTLSv1_handle_timeout(server_.get()), 1);
  EXPECT_EQ(SSL_get_dtls_read_epoch(server_.get()), 4);
  EXPECT_EQ(SSL_get_dtls_read_sequence(server_.get(), 4), 0u);

  // The server has an outstanding unacked KeyUpdate, so it is busy.
  EXPECT_FALSE(SSL_is_dtls_handshake_idle(server_.get()));
  EXPECT_EQ(SSL_get_dtls_write_epoch(server_.get()), 3);

  // Consume the ACK and new KeyUpdate on the client. Wait the ACK timer for the
  // client to flush its ACK.
  EXPECT_EQ(SSL_read(client_.get(), &byte, 1), -1);
  EXPECT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_READ);
  g_current_time.tv_sec++;
  EXPECT_EQ(DTLSv1_handle_timeout(client_.get()), 1);

  // The client has now seen the ACK to its KeyUpdate, advancing its write
  // state, and seen the server's KeyUpdate, advancing its read state. It is
  // now idle.
  EXPECT_TRUE(SSL_is_dtls_handshake_idle(client_.get()));
  EXPECT_EQ(SSL_get_dtls_read_epoch(client_.get()), 4);
  EXPECT_EQ(SSL_get_dtls_write_epoch(client_.get()), 4);

  // Both sides now have epoch 4 of the client write channel.
  check_matching_secret(/*reader=*/server_.get(), /*writer=*/client_.get(), 4);

  // Finally, consume the ACK on the server. The server applies the KeyUpdate
  // and is also idle.
  EXPECT_EQ(SSL_read(server_.get(), &byte, 1), -1);
  EXPECT_EQ(SSL_get_error(server_.get(), -1), SSL_ERROR_WANT_READ);
  EXPECT_TRUE(SSL_is_dtls_handshake_idle(server_.get()));
  EXPECT_EQ(SSL_get_dtls_read_epoch(server_.get()), 4);
  EXPECT_EQ(SSL_get_dtls_write_epoch(server_.get()), 4);

  // Both sides now have epoch 4 of the server write channel.
  check_matching_secret(/*reader=*/client_.get(), /*writer=*/server_.get(), 4);

  // Both sides still retain read epoch 3 because neither side has received data
  // at epoch 4 and cannot be sure the ACK has gotten through.
  EXPECT_TRUE(SSL_get_dtls_read_traffic_secret(client_.get(), &data, &len, 3));
  EXPECT_TRUE(SSL_get_dtls_read_traffic_secret(server_.get(), &data, &len, 3));

  // Handshake sequence numbers should have incremented.
  EXPECT_EQ(SSL_get_dtls_handshake_write_seq(client_.get()), client_hs_seq + 1);
  EXPECT_EQ(SSL_get_dtls_handshake_read_seq(server_.get()), client_hs_seq + 1);
  EXPECT_EQ(SSL_get_dtls_handshake_write_seq(server_.get()), server_hs_seq + 1);
  EXPECT_EQ(SSL_get_dtls_handshake_read_seq(client_.get()), server_hs_seq + 1);
}

TEST_P(SSLVersionTest, OneSidedShutdown) {
  // SSL_shutdown is a no-op in DTLS.
  if (is_dtls()) {
    return;
  }
  ASSERT_TRUE(Connect());

  // Shut down half the connection. |SSL_shutdown| will return 0 to signal only
  // one side has shut down.
  ASSERT_EQ(SSL_shutdown(client_.get()), 0);

  // Reading from the server should consume the EOF.
  uint8_t byte;
  ASSERT_EQ(SSL_read(server_.get(), &byte, 1), 0);
  ASSERT_EQ(SSL_get_error(server_.get(), 0), SSL_ERROR_ZERO_RETURN);

  // However, the server may continue to write data and then shut down the
  // connection.
  byte = 42;
  ASSERT_EQ(SSL_write(server_.get(), &byte, 1), 1);
  ASSERT_EQ(SSL_read(client_.get(), &byte, 1), 1);
  ASSERT_EQ(byte, 42);

  // The server may then shutdown the connection.
  EXPECT_EQ(SSL_shutdown(server_.get()), 1);
  EXPECT_EQ(SSL_shutdown(client_.get()), 1);
}

// Test that, after calling |SSL_shutdown|, |SSL_write| fails.
TEST_P(SSLVersionTest, WriteAfterShutdown) {
  ASSERT_TRUE(Connect());

  for (SSL *ssl : {client_.get(), server_.get()}) {
    SCOPED_TRACE(SSL_is_server(ssl) ? "server" : "client");

    bssl::UniquePtr<BIO> mem(BIO_new(BIO_s_mem()));
    ASSERT_TRUE(mem);
    SSL_set0_wbio(ssl, bssl::UpRef(mem).release());

    // Shut down half the connection. |SSL_shutdown| will return 0 to signal
    // only one side has shut down.
    ASSERT_EQ(SSL_shutdown(ssl), 0);

    // |ssl| should have written an alert to the transport.
    const uint8_t *unused;
    size_t len;
    ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
    EXPECT_NE(0u, len);
    EXPECT_TRUE(BIO_reset(mem.get()));

    // Writing should fail.
    EXPECT_EQ(-1, SSL_write(ssl, "a", 1));

    // Nothing should be written to the transport.
    ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
    EXPECT_EQ(0u, len);
  }
}

// Test that, after sending a fatal alert in a failed |SSL_read|, |SSL_write|
// fails.
TEST_P(SSLVersionTest, WriteAfterReadSentFatalAlert) {
  // Decryption failures are not fatal in DTLS.
  if (is_dtls()) {
    return;
  }

  ASSERT_TRUE(Connect());

  // Save the write |BIO|s as the test will overwrite them.
  bssl::UniquePtr<BIO> client_wbio = bssl::UpRef(SSL_get_wbio(client_.get()));
  bssl::UniquePtr<BIO> server_wbio = bssl::UpRef(SSL_get_wbio(server_.get()));

  for (bool test_server : {false, true}) {
    SCOPED_TRACE(test_server ? "server" : "client");
    SSL *ssl = test_server ? server_.get() : client_.get();
    BIO *other_wbio = test_server ? client_wbio.get() : server_wbio.get();

    bssl::UniquePtr<BIO> mem(BIO_new(BIO_s_mem()));
    ASSERT_TRUE(mem);
    SSL_set0_wbio(ssl, bssl::UpRef(mem).release());

    // Read an invalid record from the peer.
    static const uint8_t kInvalidRecord[] = "invalid record";
    EXPECT_EQ(int{sizeof(kInvalidRecord)},
              BIO_write(other_wbio, kInvalidRecord, sizeof(kInvalidRecord)));
    char buf[256];
    EXPECT_EQ(-1, SSL_read(ssl, buf, sizeof(buf)));

    // |ssl| should have written an alert to the transport.
    const uint8_t *unused;
    size_t len;
    ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
    EXPECT_NE(0u, len);
    EXPECT_TRUE(BIO_reset(mem.get()));

    // Writing should fail.
    EXPECT_EQ(-1, SSL_write(ssl, "a", 1));

    // Nothing should be written to the transport.
    ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
    EXPECT_EQ(0u, len);
  }
}

// Test that, after sending a fatal alert from the handshake, |SSL_write| fails.
TEST_P(SSLVersionTest, WriteAfterHandshakeSentFatalAlert) {
  for (bool test_server : {false, true}) {
    SCOPED_TRACE(test_server ? "server" : "client");

    bssl::UniquePtr<SSL> ssl(
        SSL_new(test_server ? server_ctx_.get() : client_ctx_.get()));
    ASSERT_TRUE(ssl);
    if (test_server) {
      SSL_set_accept_state(ssl.get());
    } else {
      SSL_set_connect_state(ssl.get());
    }

    std::vector<uint8_t> invalid;
    if (is_dtls()) {
      // In DTLS, invalid records are discarded. To cause the handshake to fail,
      // use a valid handshake record with invalid contents.
      invalid.push_back(SSL3_RT_HANDSHAKE);
      invalid.push_back(DTLS1_VERSION >> 8);
      invalid.push_back(DTLS1_VERSION & 0xff);
      // epoch and sequence_number
      for (int i = 0; i < 8; i++) {
        invalid.push_back(0);
      }
      // A one-byte fragment is invalid.
      invalid.push_back(0);
      invalid.push_back(1);
      // Arbitrary contents.
      invalid.push_back(0);
    } else {
      invalid = {'i', 'n', 'v', 'a', 'l', 'i', 'd'};
    }
    bssl::UniquePtr<BIO> rbio(BIO_new_mem_buf(invalid.data(), invalid.size()));
    ASSERT_TRUE(rbio);
    SSL_set0_rbio(ssl.get(), rbio.release());

    bssl::UniquePtr<BIO> mem(BIO_new(BIO_s_mem()));
    ASSERT_TRUE(mem);
    SSL_set0_wbio(ssl.get(), bssl::UpRef(mem).release());

    // The handshake should fail.
    EXPECT_EQ(-1, SSL_do_handshake(ssl.get()));
    EXPECT_EQ(SSL_ERROR_SSL, SSL_get_error(ssl.get(), -1));
    uint32_t err = ERR_get_error();

    // |ssl| should have written an alert (and, in the client's case, a
    // ClientHello) to the transport.
    const uint8_t *unused;
    size_t len;
    ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
    EXPECT_NE(0u, len);
    EXPECT_TRUE(BIO_reset(mem.get()));

    // Writing should fail, with the same error as the handshake.
    EXPECT_EQ(-1, SSL_write(ssl.get(), "a", 1));
    EXPECT_EQ(SSL_ERROR_SSL, SSL_get_error(ssl.get(), -1));
    EXPECT_EQ(err, ERR_get_error());

    // Nothing should be written to the transport.
    ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
    EXPECT_EQ(0u, len);
  }
}

// Test that, after seeing TLS 1.2 in response to early data, |SSL_write|
// continues to report |SSL_R_WRONG_VERSION_ON_EARLY_DATA|. See
// https://crbug.com/1078515.
TEST(SSLTest, WriteAfterWrongVersionOnEarlyData) {
  // Set up some 0-RTT-enabled contexts.
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  SSL_CTX_set_early_data_enabled(client_ctx.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx.get(), 1);
  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx.get(), SSL_SESS_CACHE_BOTH);

  // Get an early-data-capable session.
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx.get(), server_ctx.get());
  ASSERT_TRUE(session);
  EXPECT_TRUE(SSL_SESSION_early_data_capable(session.get()));

  // Offer the session to the server, but now the server speaks TLS 1.2.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  SSL_set_session(client.get(), session.get());
  EXPECT_TRUE(SSL_set_max_proto_version(server.get(), TLS1_2_VERSION));

  // The client handshake initially succeeds in the early data state.
  EXPECT_EQ(1, SSL_do_handshake(client.get()));
  EXPECT_TRUE(SSL_in_early_data(client.get()));

  // The server processes the ClientHello and negotiates TLS 1.2.
  EXPECT_EQ(-1, SSL_do_handshake(server.get()));
  EXPECT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(server.get(), -1));
  EXPECT_EQ(TLS1_2_VERSION, SSL_version(server.get()));

  // Capture the client's output.
  bssl::UniquePtr<BIO> mem(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(mem);
  SSL_set0_wbio(client.get(), bssl::UpRef(mem).release());

  // The client processes the ServerHello and fails.
  EXPECT_EQ(-1, SSL_do_handshake(client.get()));
  EXPECT_EQ(SSL_ERROR_SSL, SSL_get_error(client.get(), -1));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_WRONG_VERSION_ON_EARLY_DATA));

  // The client should have written an alert to the transport.
  const uint8_t *unused;
  size_t len;
  ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
  EXPECT_NE(0u, len);
  EXPECT_TRUE(BIO_reset(mem.get()));

  // Writing should fail, with the same error as the handshake.
  EXPECT_EQ(-1, SSL_write(client.get(), "a", 1));
  EXPECT_EQ(SSL_ERROR_SSL, SSL_get_error(client.get(), -1));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_WRONG_VERSION_ON_EARLY_DATA));

  // Nothing should be written to the transport.
  ASSERT_TRUE(BIO_mem_contents(mem.get(), &unused, &len));
  EXPECT_EQ(0u, len);
}

TEST(SSLTest, SessionDuplication) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));

  SSL_SESSION *session0 = SSL_get_session(client.get());
  bssl::UniquePtr<SSL_SESSION> session1 =
      bssl::SSL_SESSION_dup(session0, SSL_SESSION_DUP_ALL);
  ASSERT_TRUE(session1);

  session1->not_resumable = false;

  uint8_t *s0_bytes, *s1_bytes;
  size_t s0_len, s1_len;

  ASSERT_TRUE(SSL_SESSION_to_bytes(session0, &s0_bytes, &s0_len));
  bssl::UniquePtr<uint8_t> free_s0(s0_bytes);

  ASSERT_TRUE(SSL_SESSION_to_bytes(session1.get(), &s1_bytes, &s1_len));
  bssl::UniquePtr<uint8_t> free_s1(s1_bytes);

  EXPECT_EQ(Bytes(s0_bytes, s0_len), Bytes(s1_bytes, s1_len));
}

static void ExpectFDs(const SSL *ssl, int rfd, int wfd) {
  EXPECT_EQ(rfd, SSL_get_fd(ssl));
  EXPECT_EQ(rfd, SSL_get_rfd(ssl));
  EXPECT_EQ(wfd, SSL_get_wfd(ssl));

  // The wrapper BIOs are always equal when fds are equal, even if set
  // individually.
  if (rfd == wfd) {
    EXPECT_EQ(SSL_get_rbio(ssl), SSL_get_wbio(ssl));
  }
}

TEST(SSLTest, SetFD) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Test setting different read and write FDs.
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_rfd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_wfd(ssl.get(), 2));
  ExpectFDs(ssl.get(), 1, 2);

  // Test setting the same FD.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_fd(ssl.get(), 1));
  ExpectFDs(ssl.get(), 1, 1);

  // Test setting the same FD one side at a time.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_rfd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_wfd(ssl.get(), 1));
  ExpectFDs(ssl.get(), 1, 1);

  // Test setting the same FD in the other order.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_wfd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_rfd(ssl.get(), 1));
  ExpectFDs(ssl.get(), 1, 1);

  // Test changing the read FD partway through.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_fd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_rfd(ssl.get(), 2));
  ExpectFDs(ssl.get(), 2, 1);

  // Test changing the write FD partway through.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_fd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_wfd(ssl.get(), 2));
  ExpectFDs(ssl.get(), 1, 2);

  // Test a no-op change to the read FD partway through.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_fd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_rfd(ssl.get(), 1));
  ExpectFDs(ssl.get(), 1, 1);

  // Test a no-op change to the write FD partway through.
  ssl.reset(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  EXPECT_TRUE(SSL_set_fd(ssl.get(), 1));
  EXPECT_TRUE(SSL_set_wfd(ssl.get(), 1));
  ExpectFDs(ssl.get(), 1, 1);

  // ASan builds will implicitly test that the internal |BIO| reference-counting
  // is correct.
}

TEST(SSLTest, SetBIO) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  bssl::UniquePtr<BIO> bio1(BIO_new(BIO_s_mem())), bio2(BIO_new(BIO_s_mem())),
      bio3(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(ssl);
  ASSERT_TRUE(bio1);
  ASSERT_TRUE(bio2);
  ASSERT_TRUE(bio3);

  // SSL_set_bio takes one reference when the parameters are the same.
  BIO_up_ref(bio1.get());
  SSL_set_bio(ssl.get(), bio1.get(), bio1.get());

  // Repeating the call does nothing.
  SSL_set_bio(ssl.get(), bio1.get(), bio1.get());

  // It takes one reference each when the parameters are different.
  BIO_up_ref(bio2.get());
  BIO_up_ref(bio3.get());
  SSL_set_bio(ssl.get(), bio2.get(), bio3.get());

  // Repeating the call does nothing.
  SSL_set_bio(ssl.get(), bio2.get(), bio3.get());

  // It takes one reference when changing only wbio.
  BIO_up_ref(bio1.get());
  SSL_set_bio(ssl.get(), bio2.get(), bio1.get());

  // It takes one reference when changing only rbio and the two are different.
  BIO_up_ref(bio3.get());
  SSL_set_bio(ssl.get(), bio3.get(), bio1.get());

  // If setting wbio to rbio, it takes no additional references.
  SSL_set_bio(ssl.get(), bio3.get(), bio3.get());

  // From there, wbio may be switched to something else.
  BIO_up_ref(bio1.get());
  SSL_set_bio(ssl.get(), bio3.get(), bio1.get());

  // If setting rbio to wbio, it takes no additional references.
  SSL_set_bio(ssl.get(), bio1.get(), bio1.get());

  // From there, rbio may be switched to something else, but, for historical
  // reasons, it takes a reference to both parameters.
  BIO_up_ref(bio1.get());
  BIO_up_ref(bio2.get());
  SSL_set_bio(ssl.get(), bio2.get(), bio1.get());

  // ASAN builds will implicitly test that the internal |BIO| reference-counting
  // is correct.
}

static int VerifySucceed(X509_STORE_CTX *store_ctx, void *arg) { return 1; }

TEST_P(SSLVersionTest, GetPeerCertificate) {
  ASSERT_TRUE(UseCertAndKey(client_ctx_.get()));

  // Configure both client and server to accept any certificate.
  SSL_CTX_set_verify(client_ctx_.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  SSL_CTX_set_cert_verify_callback(client_ctx_.get(), VerifySucceed, nullptr);
  SSL_CTX_set_verify(server_ctx_.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  SSL_CTX_set_cert_verify_callback(server_ctx_.get(), VerifySucceed, nullptr);

  ASSERT_TRUE(Connect());

  // Client and server should both see the leaf certificate.
  bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(server_.get()));
  ASSERT_TRUE(peer);
  ASSERT_EQ(X509_cmp(cert_.get(), peer.get()), 0);

  peer.reset(SSL_get_peer_certificate(client_.get()));
  ASSERT_TRUE(peer);
  ASSERT_EQ(X509_cmp(cert_.get(), peer.get()), 0);

  // However, for historical reasons, the X509 chain includes the leaf on the
  // client, but does not on the server.
  EXPECT_EQ(sk_X509_num(SSL_get_peer_cert_chain(client_.get())), 1u);
  EXPECT_EQ(sk_CRYPTO_BUFFER_num(SSL_get0_peer_certificates(client_.get())),
            1u);

  EXPECT_EQ(sk_X509_num(SSL_get_peer_cert_chain(server_.get())), 0u);
  EXPECT_EQ(sk_CRYPTO_BUFFER_num(SSL_get0_peer_certificates(server_.get())),
            1u);
}

TEST_P(SSLVersionTest, NoPeerCertificate) {
  SSL_CTX_set_verify(server_ctx_.get(), SSL_VERIFY_PEER, nullptr);
  SSL_CTX_set_cert_verify_callback(server_ctx_.get(), VerifySucceed, nullptr);
  SSL_CTX_set_cert_verify_callback(client_ctx_.get(), VerifySucceed, nullptr);

  ASSERT_TRUE(Connect());

  // Server should not see a peer certificate.
  bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(server_.get()));
  ASSERT_FALSE(peer);
  ASSERT_FALSE(SSL_get0_peer_certificates(server_.get()));
}

TEST_P(SSLVersionTest, RetainOnlySHA256OfCerts) {
  uint8_t *cert_der = nullptr;
  int cert_der_len = i2d_X509(cert_.get(), &cert_der);
  ASSERT_GE(cert_der_len, 0);
  bssl::UniquePtr<uint8_t> free_cert_der(cert_der);

  uint8_t cert_sha256[SHA256_DIGEST_LENGTH];
  SHA256(cert_der, cert_der_len, cert_sha256);

  ASSERT_TRUE(UseCertAndKey(client_ctx_.get()));

  // Configure both client and server to accept any certificate, but the
  // server must retain only the SHA-256 of the peer.
  SSL_CTX_set_verify(client_ctx_.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  SSL_CTX_set_verify(server_ctx_.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  SSL_CTX_set_cert_verify_callback(client_ctx_.get(), VerifySucceed, nullptr);
  SSL_CTX_set_cert_verify_callback(server_ctx_.get(), VerifySucceed, nullptr);
  SSL_CTX_set_retain_only_sha256_of_client_certs(server_ctx_.get(), 1);

  ASSERT_TRUE(Connect());

  // The peer certificate has been dropped.
  bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(server_.get()));
  EXPECT_FALSE(peer);

  SSL_SESSION *session = SSL_get_session(server_.get());
  EXPECT_TRUE(SSL_SESSION_has_peer_sha256(session));

  const uint8_t *peer_sha256;
  size_t peer_sha256_len;
  SSL_SESSION_get0_peer_sha256(session, &peer_sha256, &peer_sha256_len);
  EXPECT_EQ(Bytes(cert_sha256), Bytes(peer_sha256, peer_sha256_len));
}

// Tests that our ClientHellos do not change unexpectedly. These are purely
// change detection tests. If they fail as part of an intentional ClientHello
// change, update the test vector.
TEST(SSLTest, ClientHello) {
  struct {
    uint16_t max_version;
    std::vector<uint8_t> expected;
  } kTests[] = {
      {TLS1_VERSION,
       {0x16, 0x03, 0x01, 0x00, 0x58, 0x01, 0x00, 0x00, 0x54, 0x03, 0x01, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0xc0, 0x09,
        0xc0, 0x13, 0xc0, 0x0a, 0xc0, 0x14, 0x00, 0x2f, 0x00, 0x35, 0x01, 0x00,
        0x00, 0x1f, 0x00, 0x17, 0x00, 0x00, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00,
        0x0a, 0x00, 0x08, 0x00, 0x06, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18, 0x00,
        0x0b, 0x00, 0x02, 0x01, 0x00, 0x00, 0x23, 0x00, 0x00}},
      {TLS1_1_VERSION,
       {0x16, 0x03, 0x01, 0x00, 0x58, 0x01, 0x00, 0x00, 0x54, 0x03, 0x02, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0c, 0xc0, 0x09,
        0xc0, 0x13, 0xc0, 0x0a, 0xc0, 0x14, 0x00, 0x2f, 0x00, 0x35, 0x01, 0x00,
        0x00, 0x1f, 0x00, 0x17, 0x00, 0x00, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00,
        0x0a, 0x00, 0x08, 0x00, 0x06, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18, 0x00,
        0x0b, 0x00, 0x02, 0x01, 0x00, 0x00, 0x23, 0x00, 0x00}},
      {TLS1_2_VERSION,
       {0x16, 0x03, 0x01, 0x00, 0x80, 0x01, 0x00, 0x00, 0x7c, 0x03, 0x03, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x1c, 0xcc, 0xa9,
        0xcc, 0xa8, 0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30, 0xc0, 0x09,
        0xc0, 0x13, 0xc0, 0x0a, 0xc0, 0x14, 0x00, 0x9c, 0x00, 0x9d, 0x00, 0x2f,
        0x00, 0x35, 0x01, 0x00, 0x00, 0x37, 0x00, 0x17, 0x00, 0x00, 0xff, 0x01,
        0x00, 0x01, 0x00, 0x00, 0x0a, 0x00, 0x08, 0x00, 0x06, 0x00, 0x1d, 0x00,
        0x17, 0x00, 0x18, 0x00, 0x0b, 0x00, 0x02, 0x01, 0x00, 0x00, 0x23, 0x00,
        0x00, 0x00, 0x0d, 0x00, 0x14, 0x00, 0x12, 0x04, 0x03, 0x08, 0x04, 0x04,
        0x01, 0x05, 0x03, 0x08, 0x05, 0x05, 0x01, 0x08, 0x06, 0x06, 0x01, 0x02,
        0x01}},
      // TODO(davidben): Add a change detector for TLS 1.3 once the spec and our
      // implementation has settled enough that it won't change.
  };

  for (const auto &t : kTests) {
    SCOPED_TRACE(t.max_version);

    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx);
    // Our default cipher list varies by CPU capabilities, so manually place the
    // ChaCha20 ciphers in front.
    const char *cipher_list = "CHACHA20:ALL";
    ASSERT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), TLS1_VERSION));
    ASSERT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), t.max_version));
    ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(ctx.get(), cipher_list));

    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    ASSERT_TRUE(ssl);
    std::vector<uint8_t> client_hello;
    ASSERT_TRUE(GetClientHello(ssl.get(), &client_hello));

    // Zero the client_random.
    constexpr size_t kRandomOffset = 1 + 2 + 2 +  // record header
                                     1 + 3 +      // handshake message header
                                     2;           // client_version
    ASSERT_GE(client_hello.size(), kRandomOffset + SSL3_RANDOM_SIZE);
    OPENSSL_memset(client_hello.data() + kRandomOffset, 0, SSL3_RANDOM_SIZE);

    if (client_hello != t.expected) {
      ADD_FAILURE() << "ClientHellos did not match.";
      // Print the value manually so it is easier to update the test vector.
      for (size_t i = 0; i < client_hello.size(); i += 12) {
        printf("     %c", i == 0 ? '{' : ' ');
        for (size_t j = i; j < client_hello.size() && j < i + 12; j++) {
          if (j > i) {
            printf(" ");
          }
          printf("0x%02x", client_hello[j]);
          if (j < client_hello.size() - 1) {
            printf(",");
          }
        }
        if (i + 12 >= client_hello.size()) {
          printf("}},");
        }
        printf("\n");
      }
    }
  }
}

static void ExpectSessionReused(SSL_CTX *client_ctx, SSL_CTX *server_ctx,
                                SSL_SESSION *session, bool want_reused) {
  bssl::UniquePtr<SSL> client, server;
  ClientConfig config;
  config.session = session;
  ASSERT_TRUE(
      ConnectClientAndServer(&client, &server, client_ctx, server_ctx, config));

  EXPECT_EQ(SSL_session_reused(client.get()), SSL_session_reused(server.get()));

  bool was_reused = !!SSL_session_reused(client.get());
  EXPECT_EQ(was_reused, want_reused);
}

static bssl::UniquePtr<SSL_SESSION> ExpectSessionRenewed(SSL_CTX *client_ctx,
                                                         SSL_CTX *server_ctx,
                                                         SSL_SESSION *session) {
  g_last_session = nullptr;
  SSL_CTX_sess_set_new_cb(client_ctx, SaveLastSession);

  bssl::UniquePtr<SSL> client, server;
  ClientConfig config;
  config.session = session;
  if (!ConnectClientAndServer(&client, &server, client_ctx, server_ctx,
                              config) ||
      !FlushNewSessionTickets(client.get(), server.get())) {
    fprintf(stderr, "Failed to connect client and server.\n");
    return nullptr;
  }

  if (SSL_session_reused(client.get()) != SSL_session_reused(server.get())) {
    fprintf(stderr, "Client and server were inconsistent.\n");
    return nullptr;
  }

  if (!SSL_session_reused(client.get())) {
    fprintf(stderr, "Session was not reused.\n");
    return nullptr;
  }

  SSL_CTX_sess_set_new_cb(client_ctx, nullptr);

  if (!g_last_session) {
    fprintf(stderr, "Client did not receive a renewed session.\n");
    return nullptr;
  }
  return std::move(g_last_session);
}

static void ExpectTicketKeyChanged(SSL_CTX *ctx, uint8_t *inout_key,
                                   bool changed) {
  uint8_t new_key[kTicketKeyLen];
  // May return 0, 1 or 48.
  ASSERT_EQ(SSL_CTX_get_tlsext_ticket_keys(ctx, new_key, kTicketKeyLen), 1);
  if (changed) {
    ASSERT_NE(Bytes(inout_key, kTicketKeyLen), Bytes(new_key));
  } else {
    ASSERT_EQ(Bytes(inout_key, kTicketKeyLen), Bytes(new_key));
  }
  OPENSSL_memcpy(inout_key, new_key, kTicketKeyLen);
}

static int SwitchSessionIDContextSNI(SSL *ssl, int *out_alert, void *arg) {
  static const uint8_t kContext[] = {3};

  if (!SSL_set_session_id_context(ssl, kContext, sizeof(kContext))) {
    return SSL_TLSEXT_ERR_ALERT_FATAL;
  }

  return SSL_TLSEXT_ERR_OK;
}

TEST_P(SSLVersionTest, SessionIDContext) {
  static const uint8_t kContext1[] = {1};
  static const uint8_t kContext2[] = {2};

  ASSERT_TRUE(SSL_CTX_set_session_id_context(server_ctx_.get(), kContext1,
                                             sizeof(kContext1)));

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);

  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(),
                                  true /* expect session reused */));

  // Change the session ID context.
  ASSERT_TRUE(SSL_CTX_set_session_id_context(server_ctx_.get(), kContext2,
                                             sizeof(kContext2)));

  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(),
                                  false /* expect session not reused */));

  // Change the session ID context back and install an SNI callback to switch
  // it.
  ASSERT_TRUE(SSL_CTX_set_session_id_context(server_ctx_.get(), kContext1,
                                             sizeof(kContext1)));

  SSL_CTX_set_tlsext_servername_callback(server_ctx_.get(),
                                         SwitchSessionIDContextSNI);

  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(),
                                  false /* expect session not reused */));

  // Switch the session ID context with the early callback instead.
  SSL_CTX_set_tlsext_servername_callback(server_ctx_.get(), nullptr);
  SSL_CTX_set_select_certificate_cb(
      server_ctx_.get(),
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        static const uint8_t kContext[] = {3};

        if (!SSL_set_session_id_context(client_hello->ssl, kContext,
                                        sizeof(kContext))) {
          return ssl_select_cert_error;
        }

        return ssl_select_cert_success;
      });

  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(),
                                  false /* expect session not reused */));
}

static int RenewTicketCallback(SSL *ssl, uint8_t *key_name, uint8_t *iv,
                               EVP_CIPHER_CTX *ctx, HMAC_CTX *hmac_ctx,
                               int encrypt) {
  static const uint8_t kZeros[16] = {0};

  if (encrypt) {
    OPENSSL_memcpy(key_name, kZeros, sizeof(kZeros));
    RAND_bytes(iv, 16);
  } else if (OPENSSL_memcmp(key_name, kZeros, 16) != 0) {
    return 0;
  }

  if (!HMAC_Init_ex(hmac_ctx, kZeros, sizeof(kZeros), EVP_sha256(), nullptr) ||
      !EVP_CipherInit_ex(ctx, EVP_aes_128_cbc(), nullptr, kZeros, iv,
                         encrypt)) {
    return -1;
  }

  // Returning two from the callback in decrypt mode renews the
  // session in TLS 1.2 and below.
  return encrypt ? 1 : 2;
}

static bool GetServerTicketTime(long *out, const SSL_SESSION *session) {
  const uint8_t *ticket;
  size_t ticket_len;
  SSL_SESSION_get0_ticket(session, &ticket, &ticket_len);
  if (ticket_len < 16 + 16 + SHA256_DIGEST_LENGTH) {
    return false;
  }

  const uint8_t *ciphertext = ticket + 16 + 16;
  size_t len = ticket_len - 16 - 16 - SHA256_DIGEST_LENGTH;
  auto plaintext = std::make_unique<uint8_t[]>(len);

  static const uint8_t kZeros[16] = {0};
  const uint8_t *iv = ticket + 16;
  bssl::ScopedEVP_CIPHER_CTX ctx;
  int len1, len2;
  if (len > INT_MAX ||
      !EVP_DecryptInit_ex(ctx.get(), EVP_aes_128_cbc(), nullptr, kZeros, iv) ||
      !EVP_DecryptUpdate(ctx.get(), plaintext.get(), &len1, ciphertext,
                         static_cast<int>(len)) ||
      !EVP_DecryptFinal_ex(ctx.get(), plaintext.get() + len1, &len2)) {
    return false;
  }

  len = static_cast<size_t>(len1 + len2);

  bssl::UniquePtr<SSL_CTX> ssl_ctx(SSL_CTX_new(TLS_method()));
  if (!ssl_ctx) {
    return false;
  }
  bssl::UniquePtr<SSL_SESSION> server_session(
      SSL_SESSION_from_bytes(plaintext.get(), len, ssl_ctx.get()));
  if (!server_session) {
    return false;
  }

  *out = SSL_SESSION_get_time(server_session.get());
  return true;
}

TEST_P(SSLVersionTest, SessionTimeout) {
  for (bool server_test : {false, true}) {
    SCOPED_TRACE(server_test);

    ASSERT_NO_FATAL_FAILURE(ResetContexts());
    SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
    SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

    static const time_t kStartTime = 1000;
    g_current_time.tv_sec = kStartTime;

    // We are willing to use a longer lifetime for TLS 1.3 sessions as
    // resumptions still perform ECDHE.
    const time_t timeout = is_tls13() ? SSL_DEFAULT_SESSION_PSK_DHE_TIMEOUT
                                      : SSL_DEFAULT_SESSION_TIMEOUT;

    // Both client and server must enforce session timeouts. We configure the
    // other side with a frozen clock so it never expires tickets.
    if (server_test) {
      SSL_CTX_set_current_time_cb(client_ctx_.get(), FrozenTimeCallback);
      SSL_CTX_set_current_time_cb(server_ctx_.get(), CurrentTimeCallback);
    } else {
      SSL_CTX_set_current_time_cb(client_ctx_.get(), CurrentTimeCallback);
      SSL_CTX_set_current_time_cb(server_ctx_.get(), FrozenTimeCallback);
    }

    // Configure a ticket callback which renews tickets.
    SSL_CTX_set_tlsext_ticket_key_cb(server_ctx_.get(), RenewTicketCallback);

    bssl::UniquePtr<SSL_SESSION> session =
        CreateClientSession(client_ctx_.get(), server_ctx_.get());
    ASSERT_TRUE(session);

    // Advance the clock just behind the timeout.
    g_current_time.tv_sec += timeout - 1;

    TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                    session.get(),
                                    true /* expect session reused */));

    // Advance the clock one more second.
    g_current_time.tv_sec++;

    TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                    session.get(),
                                    false /* expect session not reused */));

    // Rewind the clock to before the session was minted.
    g_current_time.tv_sec = kStartTime - 1;

    TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                    session.get(),
                                    false /* expect session not reused */));

    // Renew the session 10 seconds before expiration.
    time_t new_start_time = kStartTime + timeout - 10;
    g_current_time.tv_sec = new_start_time;
    bssl::UniquePtr<SSL_SESSION> new_session = ExpectSessionRenewed(
        client_ctx_.get(), server_ctx_.get(), session.get());
    ASSERT_TRUE(new_session);

    // This new session is not the same object as before.
    EXPECT_NE(session.get(), new_session.get());

    // Check the sessions have timestamps measured from issuance.
    long session_time = 0;
    if (server_test) {
      ASSERT_TRUE(GetServerTicketTime(&session_time, new_session.get()));
    } else {
      session_time = SSL_SESSION_get_time(new_session.get());
    }

    ASSERT_EQ(session_time, g_current_time.tv_sec);

    if (is_tls13()) {
      // Renewal incorporates fresh key material in TLS 1.3, so we extend the
      // lifetime TLS 1.3.
      g_current_time.tv_sec = new_start_time + timeout - 1;
      TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                      new_session.get(),
                                      true /* expect session reused */));

      // The new session expires after the new timeout.
      g_current_time.tv_sec = new_start_time + timeout + 1;
      TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                      new_session.get(),
                                      false /* expect session not reused */));

      // Renew the session until it begins just past the auth timeout.
      time_t auth_end_time = kStartTime + SSL_DEFAULT_SESSION_AUTH_TIMEOUT;
      while (new_start_time < auth_end_time - 1000) {
        // Get as close as possible to target start time.
        new_start_time =
            std::min(auth_end_time - 1000, new_start_time + timeout - 1);
        g_current_time.tv_sec = new_start_time;
        new_session = ExpectSessionRenewed(client_ctx_.get(), server_ctx_.get(),
                                           new_session.get());
        ASSERT_TRUE(new_session);
      }

      // Now the session's lifetime is bound by the auth timeout.
      g_current_time.tv_sec = auth_end_time - 1;
      TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                      new_session.get(),
                                      true /* expect session reused */));

      g_current_time.tv_sec = auth_end_time + 1;
      TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                      new_session.get(),
                                      false /* expect session not reused */));
    } else {
      // The new session is usable just before the old expiration.
      g_current_time.tv_sec = kStartTime + timeout - 1;
      TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                      new_session.get(),
                                      true /* expect session reused */));

      // Renewal does not extend the lifetime, so it is not usable beyond the
      // old expiration.
      g_current_time.tv_sec = kStartTime + timeout + 1;
      TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                      new_session.get(),
                                      false /* expect session not reused */));
    }
  }
}

TEST_P(SSLVersionTest, DefaultTicketKeyInitialization) {
  static const uint8_t kZeroKey[kTicketKeyLen] = {};
  uint8_t ticket_key[kTicketKeyLen];
  ASSERT_EQ(1, SSL_CTX_get_tlsext_ticket_keys(server_ctx_.get(), ticket_key,
                                              kTicketKeyLen));
  ASSERT_NE(0, OPENSSL_memcmp(ticket_key, kZeroKey, kTicketKeyLen));
}

TEST_P(SSLVersionTest, DefaultTicketKeyRotation) {
  static const time_t kStartTime = 1001;
  g_current_time.tv_sec = kStartTime;

  // We use session reuse as a proxy for ticket decryption success, hence
  // disable session timeouts.
  SSL_CTX_set_timeout(server_ctx_.get(), std::numeric_limits<uint32_t>::max());
  SSL_CTX_set_session_psk_dhe_timeout(server_ctx_.get(),
                                      std::numeric_limits<uint32_t>::max());

  SSL_CTX_set_current_time_cb(client_ctx_.get(), FrozenTimeCallback);
  SSL_CTX_set_current_time_cb(server_ctx_.get(), CurrentTimeCallback);

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_OFF);

  // Initialize ticket_key with the current key and check that it was
  // initialized to something, not all zeros.
  uint8_t ticket_key[kTicketKeyLen] = {0};
  TRACED_CALL(ExpectTicketKeyChanged(server_ctx_.get(), ticket_key,
                                     true /* changed */));

  // Verify ticket resumption actually works.
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);
  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(), true /* reused */));

  // Advance time to just before key rotation.
  g_current_time.tv_sec += SSL_DEFAULT_TICKET_KEY_ROTATION_INTERVAL - 1;
  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(), true /* reused */));
  TRACED_CALL(ExpectTicketKeyChanged(server_ctx_.get(), ticket_key,
                                     false /* NOT changed */));

  // Force key rotation.
  g_current_time.tv_sec += 1;
  bssl::UniquePtr<SSL_SESSION> new_session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  TRACED_CALL(ExpectTicketKeyChanged(server_ctx_.get(), ticket_key,
                                     true /* changed */));

  // Resumption with both old and new ticket should work.
  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(), true /* reused */));
  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  new_session.get(), true /* reused */));
  TRACED_CALL(ExpectTicketKeyChanged(server_ctx_.get(), ticket_key,
                                     false /* NOT changed */));

  // Force key rotation again. Resumption with the old ticket now fails.
  g_current_time.tv_sec += SSL_DEFAULT_TICKET_KEY_ROTATION_INTERVAL;
  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  session.get(), false /* NOT reused */));
  TRACED_CALL(ExpectTicketKeyChanged(server_ctx_.get(), ticket_key,
                                     true /* changed */));

  // But resumption with the newer session still works.
  TRACED_CALL(ExpectSessionReused(client_ctx_.get(), server_ctx_.get(),
                                  new_session.get(), true /* reused */));
}

static int SwitchContext(SSL *ssl, int *out_alert, void *arg) {
  SSL_CTX *ctx = reinterpret_cast<SSL_CTX *>(arg);
  SSL_set_SSL_CTX(ssl, ctx);
  return SSL_TLSEXT_ERR_OK;
}

TEST_P(SSLVersionTest, SNICallback) {
  bssl::UniquePtr<X509> cert2 = GetECDSATestCertificate();
  ASSERT_TRUE(cert2);
  bssl::UniquePtr<EVP_PKEY> key2 = GetECDSATestKey();
  ASSERT_TRUE(key2);

  // Test that switching the |SSL_CTX| at the SNI callback behaves correctly.
  static const uint16_t kECDSAWithSHA256 = SSL_SIGN_ECDSA_SECP256R1_SHA256;

  static const uint8_t kSCTList[] = {0, 6, 0, 4, 5, 6, 7, 8};
  static const uint8_t kOCSPResponse[] = {1, 2, 3, 4};

  bssl::UniquePtr<SSL_CTX> server_ctx2 = CreateContext();
  ASSERT_TRUE(server_ctx2);
  ASSERT_TRUE(SSL_CTX_use_certificate(server_ctx2.get(), cert2.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(server_ctx2.get(), key2.get()));
  ASSERT_TRUE(SSL_CTX_set_signed_cert_timestamp_list(
      server_ctx2.get(), kSCTList, sizeof(kSCTList)));
  ASSERT_TRUE(SSL_CTX_set_ocsp_response(server_ctx2.get(), kOCSPResponse,
                                        sizeof(kOCSPResponse)));
  // Historically signing preferences would be lost in some cases with the
  // SNI callback, which triggers the TLS 1.2 SHA-1 default. To ensure
  // this doesn't happen when |version| is TLS 1.2, configure the private
  // key to only sign SHA-256.
  ASSERT_TRUE(SSL_CTX_set_signing_algorithm_prefs(server_ctx2.get(),
                                                  &kECDSAWithSHA256, 1));

  SSL_CTX_set_tlsext_servername_callback(server_ctx_.get(), SwitchContext);
  SSL_CTX_set_tlsext_servername_arg(server_ctx_.get(), server_ctx2.get());

  SSL_CTX_enable_signed_cert_timestamps(client_ctx_.get());
  SSL_CTX_enable_ocsp_stapling(client_ctx_.get());

  ASSERT_TRUE(Connect());

  // The client should have received |cert2|.
  bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(client_.get()));
  ASSERT_TRUE(peer);
  EXPECT_EQ(X509_cmp(peer.get(), cert2.get()), 0);

  // The client should have received |server_ctx2|'s SCT list.
  const uint8_t *data;
  size_t len;
  SSL_get0_signed_cert_timestamp_list(client_.get(), &data, &len);
  EXPECT_EQ(Bytes(kSCTList), Bytes(data, len));

  // The client should have received |server_ctx2|'s OCSP response.
  SSL_get0_ocsp_response(client_.get(), &data, &len);
  EXPECT_EQ(Bytes(kOCSPResponse), Bytes(data, len));
}

// Test that the early callback can swap the maximum version.
TEST(SSLTest, EarlyCallbackVersionSwitch) {
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(server_ctx);
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_3_VERSION));

  SSL_CTX_set_select_certificate_cb(
      server_ctx.get(),
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        if (!SSL_set_max_proto_version(client_hello->ssl, TLS1_2_VERSION)) {
          return ssl_select_cert_error;
        }

        return ssl_select_cert_success;
      });

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
  EXPECT_EQ(TLS1_2_VERSION, SSL_version(client.get()));
}

TEST(SSLTest, SetVersion) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Set valid TLS versions.
  for (const auto &vers : kAllVersions) {
    SCOPED_TRACE(vers.name);
    if (vers.ssl_method == VersionParam::is_tls) {
      EXPECT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), vers.version));
      EXPECT_EQ(SSL_CTX_get_max_proto_version(ctx.get()), vers.version);
      EXPECT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), vers.version));
      EXPECT_EQ(SSL_CTX_get_min_proto_version(ctx.get()), vers.version);
    }
  }

  // Invalid TLS versions are rejected.
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), DTLS1_VERSION));
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), 0x0200));
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), 0x1234));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), DTLS1_VERSION));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), 0x0200));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), 0x1234));

  // Zero is the default version.
  EXPECT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), 0));
  EXPECT_EQ(TLS1_3_VERSION, SSL_CTX_get_max_proto_version(ctx.get()));
  EXPECT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), 0));
  EXPECT_EQ(TLS1_2_VERSION, SSL_CTX_get_min_proto_version(ctx.get()));

  // SSL 3.0 is not available.
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), SSL3_VERSION));

  ctx.reset(SSL_CTX_new(DTLS_method()));
  ASSERT_TRUE(ctx);

  // Set valid DTLS versions.
  for (const auto &vers : kAllVersions) {
    SCOPED_TRACE(vers.name);
    if (vers.ssl_method == VersionParam::is_dtls) {
      EXPECT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), vers.version));
      EXPECT_EQ(SSL_CTX_get_max_proto_version(ctx.get()), vers.version);
      EXPECT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), vers.version));
      EXPECT_EQ(SSL_CTX_get_min_proto_version(ctx.get()), vers.version);
    }
  }

  // Invalid DTLS versions are rejected.
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), TLS1_VERSION));
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), 0xfefe /* DTLS 1.1 */));
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), 0xfffe /* DTLS 0.1 */));
  EXPECT_FALSE(SSL_CTX_set_max_proto_version(ctx.get(), 0x1234));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), TLS1_VERSION));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), 0xfefe /* DTLS 1.1 */));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), 0xfffe /* DTLS 0.1 */));
  EXPECT_FALSE(SSL_CTX_set_min_proto_version(ctx.get(), 0x1234));

  // Zero is the default version.
  EXPECT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), 0));
  EXPECT_EQ(DTLS1_2_VERSION, SSL_CTX_get_max_proto_version(ctx.get()));
  EXPECT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), 0));
  EXPECT_EQ(DTLS1_2_VERSION, SSL_CTX_get_min_proto_version(ctx.get()));
}

static const char *GetVersionName(uint16_t version) {
  switch (version) {
    case TLS1_VERSION:
      return "TLSv1";
    case TLS1_1_VERSION:
      return "TLSv1.1";
    case TLS1_2_VERSION:
      return "TLSv1.2";
    case TLS1_3_VERSION:
      return "TLSv1.3";
    case DTLS1_VERSION:
      return "DTLSv1";
    case DTLS1_2_VERSION:
      return "DTLSv1.2";
    case DTLS1_3_VERSION:
      return "DTLSv1.3";
    default:
      return "???";
  }
}

TEST_P(SSLVersionTest, Version) {
  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));
  // Before the handshake, |SSL_version| reports some placeholder value.
  const uint16_t placeholder = is_dtls() ? DTLS1_2_VERSION : TLS1_2_VERSION;
  EXPECT_EQ(SSL_version(client_.get()), placeholder);
  EXPECT_EQ(SSL_version(server_.get()), placeholder);

  // After the handshake, |SSL_version| reports the version.
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  EXPECT_EQ(SSL_version(client_.get()), version());
  EXPECT_EQ(SSL_version(server_.get()), version());

  // Test the version name is reported as expected.
  const char *version_name = GetVersionName(version());
  EXPECT_EQ(strcmp(version_name, SSL_get_version(client_.get())), 0);
  EXPECT_EQ(strcmp(version_name, SSL_get_version(server_.get())), 0);

  // Test SSL_SESSION reports the same name.
  const char *client_name =
      SSL_SESSION_get_version(SSL_get_session(client_.get()));
  const char *server_name =
      SSL_SESSION_get_version(SSL_get_session(server_.get()));
  EXPECT_EQ(strcmp(version_name, client_name), 0);
  EXPECT_EQ(strcmp(version_name, server_name), 0);

  // |SSL_clear| should reset the |SSL|s to the original state.
  ASSERT_TRUE(SSL_clear(client_.get()));
  ASSERT_TRUE(SSL_clear(server_.get()));
  EXPECT_EQ(SSL_version(client_.get()), placeholder);
  EXPECT_EQ(SSL_version(server_.get()), placeholder);
}

// Tests that that |SSL_get_pending_cipher| is available during the ALPN
// selection callback.
TEST_P(SSLVersionTest, ALPNCipherAvailable) {
  ASSERT_TRUE(UseCertAndKey(client_ctx_.get()));

  static const uint8_t kALPNProtos[] = {0x03, 'f', 'o', 'o'};
  ASSERT_EQ(SSL_CTX_set_alpn_protos(client_ctx_.get(), kALPNProtos,
                                    sizeof(kALPNProtos)),
            0);

  // The ALPN callback does not fail the handshake on error, so have the
  // callback write a boolean.
  std::pair<uint16_t, bool> callback_state(version(), false);
  SSL_CTX_set_alpn_select_cb(
      server_ctx_.get(),
      [](SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in,
         unsigned in_len, void *arg) -> int {
        auto state = reinterpret_cast<std::pair<uint16_t, bool> *>(arg);
        if (SSL_get_pending_cipher(ssl) != nullptr &&
            SSL_version(ssl) == state->first) {
          state->second = true;
        }
        return SSL_TLSEXT_ERR_NOACK;
      },
      &callback_state);

  ASSERT_TRUE(Connect());

  ASSERT_TRUE(callback_state.second);
}

TEST_P(SSLVersionTest, SSLClearSessionResumption) {
  // Skip this for TLS 1.3. TLS 1.3's ticket mechanism is incompatible with this
  // API pattern.
  if (is_tls13()) {
    return;
  }

  shed_handshake_config_ = false;
  ASSERT_TRUE(Connect());

  EXPECT_FALSE(SSL_session_reused(client_.get()));
  EXPECT_FALSE(SSL_session_reused(server_.get()));

  // Reset everything.
  ASSERT_TRUE(SSL_clear(client_.get()));
  ASSERT_TRUE(SSL_clear(server_.get()));

  // Attempt to connect a second time.
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));

  // |SSL_clear| should implicitly offer the previous session to the server.
  EXPECT_TRUE(SSL_session_reused(client_.get()));
  EXPECT_TRUE(SSL_session_reused(server_.get()));
}

TEST_P(SSLVersionTest, SSLClearFailsWithShedding) {
  shed_handshake_config_ = false;
  ASSERT_TRUE(Connect());
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));

  // Reset everything.
  ASSERT_TRUE(SSL_clear(client_.get()));
  ASSERT_TRUE(SSL_clear(server_.get()));

  // Now enable shedding, and connect a second time.
  shed_handshake_config_ = true;
  ASSERT_TRUE(Connect());
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));

  // |SSL_clear| should now fail.
  ASSERT_FALSE(SSL_clear(client_.get()));
  ASSERT_FALSE(SSL_clear(server_.get()));
}

static bool ChainsEqual(const STACK_OF(X509) *chain,
                        const std::vector<X509 *> &expected) {
  if (sk_X509_num(chain) != expected.size()) {
    return false;
  }

  for (size_t i = 0; i < expected.size(); i++) {
    if (X509_cmp(sk_X509_value(chain, i), expected[i]) != 0) {
      return false;
    }
  }

  return true;
}

static bool BuffersEqual(const STACK_OF(CRYPTO_BUFFER) *chain,
                         const std::vector<CRYPTO_BUFFER *> &expected) {
  if (sk_CRYPTO_BUFFER_num(chain) != expected.size()) {
    return false;
  }

  for (size_t i = 0; i < expected.size(); i++) {
    const CRYPTO_BUFFER *buf = sk_CRYPTO_BUFFER_value(chain, i);
    if (Bytes(CRYPTO_BUFFER_data(buf), CRYPTO_BUFFER_len(buf)) !=
        Bytes(CRYPTO_BUFFER_data(expected[i]),
              CRYPTO_BUFFER_len(expected[i]))) {
      return false;
    }
  }

  return true;
}

TEST_P(SSLVersionTest, AutoChain) {
  cert_ = GetChainTestCertificate();
  ASSERT_TRUE(cert_);
  key_ = GetChainTestKey();
  ASSERT_TRUE(key_);
  bssl::UniquePtr<X509> intermediate = GetChainTestIntermediate();
  ASSERT_TRUE(intermediate);

  ASSERT_TRUE(UseCertAndKey(client_ctx_.get()));
  ASSERT_TRUE(UseCertAndKey(server_ctx_.get()));

  // Configure both client and server to accept any certificate. Add
  // |intermediate| to the cert store.
  ASSERT_TRUE(X509_STORE_add_cert(SSL_CTX_get_cert_store(client_ctx_.get()),
                                  intermediate.get()));
  ASSERT_TRUE(X509_STORE_add_cert(SSL_CTX_get_cert_store(server_ctx_.get()),
                                  intermediate.get()));
  SSL_CTX_set_verify(client_ctx_.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  SSL_CTX_set_verify(server_ctx_.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  SSL_CTX_set_cert_verify_callback(client_ctx_.get(), VerifySucceed, nullptr);
  SSL_CTX_set_cert_verify_callback(server_ctx_.get(), VerifySucceed, nullptr);

  // By default, the client and server should each only send the leaf.
  ASSERT_TRUE(Connect());

  EXPECT_TRUE(
      ChainsEqual(SSL_get_peer_full_cert_chain(client_.get()), {cert_.get()}));
  EXPECT_TRUE(
      ChainsEqual(SSL_get_peer_full_cert_chain(server_.get()), {cert_.get()}));

  // If auto-chaining is enabled, then the intermediate is sent.
  SSL_CTX_clear_mode(client_ctx_.get(), SSL_MODE_NO_AUTO_CHAIN);
  SSL_CTX_clear_mode(server_ctx_.get(), SSL_MODE_NO_AUTO_CHAIN);
  ASSERT_TRUE(Connect());

  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(client_.get()),
                          {cert_.get(), intermediate.get()}));
  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(server_.get()),
                          {cert_.get(), intermediate.get()}));

  // Auto-chaining does not override explicitly-configured intermediates.
  ASSERT_TRUE(SSL_CTX_add1_chain_cert(client_ctx_.get(), cert_.get()));
  ASSERT_TRUE(SSL_CTX_add1_chain_cert(server_ctx_.get(), cert_.get()));
  ASSERT_TRUE(Connect());

  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(client_.get()),
                          {cert_.get(), cert_.get()}));
  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(server_.get()),
                          {cert_.get(), cert_.get()}));

  // Auto-chaining does not override explicitly-configured intermediates that
  // are configured as late as cert_cb. If this fails, something in the
  // handshake is likely auto-chaining too early.
  SSL_CTX_clear_chain_certs(client_ctx_.get());
  SSL_CTX_clear_chain_certs(server_ctx_.get());
  auto install_intermediate = [](SSL *ssl, void *arg) -> int {
    return SSL_add1_chain_cert(ssl, static_cast<X509 *>(arg));
  };
  SSL_CTX_set_cert_cb(client_ctx_.get(), install_intermediate, cert_.get());
  SSL_CTX_set_cert_cb(server_ctx_.get(), install_intermediate, cert_.get());
  ASSERT_TRUE(Connect());

  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(client_.get()),
                          {cert_.get(), cert_.get()}));
  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(server_.get()),
                          {cert_.get(), cert_.get()}));
}

static bool ExpectSingleError(int lib, int reason) {
  const char *expected = ERR_reason_error_string(ERR_PACK(lib, reason));
  uint32_t err = ERR_get_error();
  if (!ERR_equals(err, lib, reason)) {
    char buf[ERR_ERROR_STRING_BUF_LEN];
    ERR_error_string_n(err, buf, sizeof(buf));
    fprintf(stderr, "Wanted %s, got: %s.\n", expected, buf);
    return false;
  }

  if (ERR_peek_error() != 0) {
    fprintf(stderr, "Unexpected error following %s.\n", expected);
    return false;
  }

  return true;
}

TEST_P(SSLVersionTest, SSLWriteRetry) {
  if (is_dtls()) {
    return;
  }

  for (bool enable_partial_write : {false, true}) {
    SCOPED_TRACE(enable_partial_write);

    // Connect a client and server.
    ASSERT_TRUE(Connect());

    if (enable_partial_write) {
      SSL_set_mode(client_.get(), SSL_MODE_ENABLE_PARTIAL_WRITE);
    }

    // Write without reading until the buffer is full and we have an unfinished
    // write. Keep a count so we may reread it again later. "hello!" will be
    // written in two chunks, "hello" and "!".
    char data[] = "hello!";
    static const int kChunkLen = 5;  // The length of "hello".
    unsigned count = 0;
    for (;;) {
      int ret = SSL_write(client_.get(), data, kChunkLen);
      if (ret <= 0) {
        ASSERT_EQ(SSL_get_error(client_.get(), ret), SSL_ERROR_WANT_WRITE);
        break;
      }
      ASSERT_EQ(ret, 5);
      count++;
    }

    // Retrying with the same parameters is legal.
    ASSERT_EQ(
        SSL_get_error(client_.get(), SSL_write(client_.get(), data, kChunkLen)),
        SSL_ERROR_WANT_WRITE);

    // Retrying with the same buffer but shorter length is not legal.
    ASSERT_EQ(SSL_get_error(client_.get(),
                            SSL_write(client_.get(), data, kChunkLen - 1)),
              SSL_ERROR_SSL);
    ASSERT_TRUE(ExpectSingleError(ERR_LIB_SSL, SSL_R_BAD_WRITE_RETRY));

    // Retrying with a different buffer pointer is not legal.
    char data2[] = "hello";
    ASSERT_EQ(SSL_get_error(client_.get(),
                            SSL_write(client_.get(), data2, kChunkLen)),
              SSL_ERROR_SSL);
    ASSERT_TRUE(ExpectSingleError(ERR_LIB_SSL, SSL_R_BAD_WRITE_RETRY));

    // With |SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER|, the buffer may move.
    SSL_set_mode(client_.get(), SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER);
    ASSERT_EQ(SSL_get_error(client_.get(),
                            SSL_write(client_.get(), data2, kChunkLen)),
              SSL_ERROR_WANT_WRITE);

    // |SSL_MODE_ACCEPT_MOVING_WRITE_BUFFER| does not disable length checks.
    ASSERT_EQ(SSL_get_error(client_.get(),
                            SSL_write(client_.get(), data2, kChunkLen - 1)),
              SSL_ERROR_SSL);
    ASSERT_TRUE(ExpectSingleError(ERR_LIB_SSL, SSL_R_BAD_WRITE_RETRY));

    // Retrying with a larger buffer is legal.
    ASSERT_EQ(SSL_get_error(client_.get(),
                            SSL_write(client_.get(), data, kChunkLen + 1)),
              SSL_ERROR_WANT_WRITE);

    // Drain the buffer.
    char buf[20];
    for (unsigned i = 0; i < count; i++) {
      ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
      ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
    }

    // Now that there is space, a retry with a larger buffer should flush the
    // pending record, skip over that many bytes of input (on assumption they
    // are the same), and write the remainder. If SSL_MODE_ENABLE_PARTIAL_WRITE
    // is set, this will complete in two steps.
    char data_longer[] = "_____!!!!!";
    if (enable_partial_write) {
      ASSERT_EQ(SSL_write(client_.get(), data_longer, 2 * kChunkLen),
                kChunkLen);
      ASSERT_EQ(SSL_write(client_.get(), data_longer + kChunkLen, kChunkLen),
                kChunkLen);
    } else {
      ASSERT_EQ(SSL_write(client_.get(), data_longer, 2 * kChunkLen),
                2 * kChunkLen);
    }

    // Check the last write was correct. The data will be spread over two
    // records, so SSL_read returns twice.
    ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
    ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
    ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
    ASSERT_EQ(OPENSSL_memcmp(buf, "!!!!!", kChunkLen), 0);

    // Fill the transport buffer again. This time only leave room for one
    // record.
    count = 0;
    for (;;) {
      int ret = SSL_write(client_.get(), data, kChunkLen);
      if (ret <= 0) {
        ASSERT_EQ(SSL_get_error(client_.get(), ret), SSL_ERROR_WANT_WRITE);
        break;
      }
      ASSERT_EQ(ret, 5);
      count++;
    }
    ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
    ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
    count--;

    // Retry the last write, with a longer input. The first half is the most
    // recently failed write, from filling the buffer. |SSL_write| should write
    // that to the transport, and then attempt to write the second half.
    int ret = SSL_write(client_.get(), data_longer, 2 * kChunkLen);
    if (enable_partial_write) {
      // If partial writes are allowed, the write will succeed partially.
      ASSERT_EQ(ret, kChunkLen);

      // Check the first half and make room for another record.
      ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
      ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
      count--;

      // Finish writing the input.
      ASSERT_EQ(SSL_write(client_.get(), data_longer + kChunkLen, kChunkLen),
                kChunkLen);
    } else {
      // Otherwise, although the first half made it to the transport, the second
      // half is blocked.
      ASSERT_EQ(ret, -1);
      ASSERT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_WRITE);

      // Check the first half and make room for another record.
      ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
      ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
      count--;

      // Retrying with fewer bytes than previously attempted is an error. If the
      // input length is less than the number of bytes successfully written, the
      // check happens at a different point, with a different error.
      //
      // TODO(davidben): Should these cases use the same error?
      ASSERT_EQ(
          SSL_get_error(client_.get(),
                        SSL_write(client_.get(), data_longer, kChunkLen - 1)),
          SSL_ERROR_SSL);
      ASSERT_TRUE(ExpectSingleError(ERR_LIB_SSL, SSL_R_BAD_LENGTH));

      // Complete the write with the correct retry.
      ASSERT_EQ(SSL_write(client_.get(), data_longer, 2 * kChunkLen),
                2 * kChunkLen);
    }

    // Drain the input and ensure everything was written correctly.
    for (unsigned i = 0; i < count; i++) {
      ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
      ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
    }

    // The final write is spread over two records.
    ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
    ASSERT_EQ(OPENSSL_memcmp(buf, "hello", kChunkLen), 0);
    ASSERT_EQ(SSL_read(server_.get(), buf, sizeof(buf)), kChunkLen);
    ASSERT_EQ(OPENSSL_memcmp(buf, "!!!!!", kChunkLen), 0);
  }
}

TEST_P(SSLVersionTest, RecordCallback) {
  if (version() == DTLS1_3_VERSION) {
    // The DTLS 1.3 record header is vastly different than the TLS or DTLS < 1.3
    // header format. Instead of checking that the record header is formatted as
    // expected here, the runner implementation in dtls.go is strict about what
    // it accepts.
    return;
  }
  for (bool test_server : {true, false}) {
    SCOPED_TRACE(test_server);
    ASSERT_NO_FATAL_FAILURE(ResetContexts());

    bool read_seen = false;
    bool write_seen = false;
    auto cb = [&](int is_write, int cb_version, int cb_type, const void *buf,
                  size_t len, SSL *ssl) {
      if (cb_type != SSL3_RT_HEADER) {
        return;
      }

      // The callback does not report a version for records.
      EXPECT_EQ(0, cb_version);

      if (is_write) {
        write_seen = true;
      } else {
        read_seen = true;
      }

      // Sanity-check that the record header is plausible.
      CBS cbs;
      CBS_init(&cbs, reinterpret_cast<const uint8_t *>(buf), len);
      uint8_t type;
      uint16_t record_version, length;
      ASSERT_TRUE(CBS_get_u8(&cbs, &type));
      ASSERT_TRUE(CBS_get_u16(&cbs, &record_version));
      EXPECT_EQ(record_version >> 8, is_dtls() ? 0xfe : 0x03);
      if (is_dtls()) {
        uint16_t epoch;
        ASSERT_TRUE(CBS_get_u16(&cbs, &epoch));
        uint16_t max_epoch = 1;
        EXPECT_LE(epoch, max_epoch) << "Invalid epoch: " << epoch;
        ASSERT_TRUE(CBS_skip(&cbs, 6));
      }
      ASSERT_TRUE(CBS_get_u16(&cbs, &length));
      EXPECT_EQ(0u, CBS_len(&cbs));
    };
    using CallbackType = decltype(cb);
    SSL_CTX *ctx = test_server ? server_ctx_.get() : client_ctx_.get();
    SSL_CTX_set_msg_callback(
        ctx, [](int is_write, int cb_version, int cb_type, const void *buf,
                size_t len, SSL *ssl, void *arg) {
          CallbackType *cb_ptr = reinterpret_cast<CallbackType *>(arg);
          (*cb_ptr)(is_write, cb_version, cb_type, buf, len, ssl);
        });
    SSL_CTX_set_msg_callback_arg(ctx, &cb);

    ASSERT_TRUE(Connect());

    EXPECT_TRUE(read_seen);
    EXPECT_TRUE(write_seen);
  }
}

TEST_P(SSLVersionTest, GetServerName) {
  ClientConfig config;
  config.servername = "host1";

  SSL_CTX_set_tlsext_servername_callback(
      server_ctx_.get(), [](SSL *ssl, int *out_alert, void *arg) -> int {
        // During the handshake, |SSL_get_servername| must match |config|.
        ClientConfig *config_p = reinterpret_cast<ClientConfig *>(arg);
        EXPECT_STREQ(config_p->servername.c_str(),
                     SSL_get_servername(ssl, TLSEXT_NAMETYPE_host_name));
        return SSL_TLSEXT_ERR_OK;
      });
  SSL_CTX_set_tlsext_servername_arg(server_ctx_.get(), &config);

  ASSERT_TRUE(Connect(config));
  // After the handshake, it must also be available.
  EXPECT_STREQ(config.servername.c_str(),
               SSL_get_servername(server_.get(), TLSEXT_NAMETYPE_host_name));

  // Establish a session under host1.
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get(), config);

  // If the client resumes a session with a different name, |SSL_get_servername|
  // must return the new name.
  ASSERT_TRUE(session);
  config.session = session.get();
  config.servername = "host2";
  ASSERT_TRUE(Connect(config));
  EXPECT_STREQ(config.servername.c_str(),
               SSL_get_servername(server_.get(), TLSEXT_NAMETYPE_host_name));
}

// Test that session cache mode bits are honored in the client session callback.
TEST_P(SSLVersionTest, ClientSessionCacheMode) {
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_OFF);
  EXPECT_FALSE(CreateClientSession(client_ctx_.get(), server_ctx_.get()));

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_CLIENT);
  EXPECT_TRUE(CreateClientSession(client_ctx_.get(), server_ctx_.get()));

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_SERVER);
  EXPECT_FALSE(CreateClientSession(client_ctx_.get(), server_ctx_.get()));
}

// Test that all versions survive tiny write buffers. In particular, TLS 1.3
// NewSessionTickets are written post-handshake. Servers that block
// |SSL_do_handshake| on writing them will deadlock if clients are not draining
// the buffer. Test that we do not do this.
TEST_P(SSLVersionTest, SmallBuffer) {
  // DTLS is a datagram protocol and requires packet-sized buffers.
  if (is_dtls()) {
    return;
  }

  // Test both flushing NewSessionTickets with a zero-sized write and
  // non-zero-sized write.
  for (bool use_zero_write : {false, true}) {
    SCOPED_TRACE(use_zero_write);

    g_last_session = nullptr;
    SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
    SSL_CTX_sess_set_new_cb(client_ctx_.get(), SaveLastSession);

    bssl::UniquePtr<SSL> client(SSL_new(client_ctx_.get())),
        server(SSL_new(server_ctx_.get()));
    ASSERT_TRUE(client);
    ASSERT_TRUE(server);
    SSL_set_connect_state(client.get());
    SSL_set_accept_state(server.get());

    // Use a tiny buffer.
    BIO *bio1, *bio2;
    ASSERT_TRUE(BIO_new_bio_pair(&bio1, 1, &bio2, 1));

    // SSL_set_bio takes ownership.
    SSL_set_bio(client.get(), bio1, bio1);
    SSL_set_bio(server.get(), bio2, bio2);

    ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));
    if (version() >= TLS1_3_VERSION) {
      // The post-handshake ticket should not have been processed yet.
      EXPECT_FALSE(g_last_session);
    }

    if (use_zero_write) {
      ASSERT_TRUE(FlushNewSessionTickets(client.get(), server.get()));
      EXPECT_TRUE(g_last_session);
    }

    // Send some data from server to client. If |use_zero_write| is false, this
    // will also flush the NewSessionTickets.
    static const char kMessage[] = "hello world";
    char buf[sizeof(kMessage)];
    for (;;) {
      int server_ret = SSL_write(server.get(), kMessage, sizeof(kMessage));
      int server_err = SSL_get_error(server.get(), server_ret);
      int client_ret = SSL_read(client.get(), buf, sizeof(buf));
      int client_err = SSL_get_error(client.get(), client_ret);

      // The server will write a single record, so every iteration should see
      // |SSL_ERROR_WANT_WRITE| and |SSL_ERROR_WANT_READ|, until the final
      // iteration, where both will complete.
      if (server_ret > 0) {
        EXPECT_EQ(server_ret, static_cast<int>(sizeof(kMessage)));
        EXPECT_EQ(client_ret, static_cast<int>(sizeof(kMessage)));
        EXPECT_EQ(Bytes(buf), Bytes(kMessage));
        break;
      }

      ASSERT_EQ(server_ret, -1);
      ASSERT_EQ(server_err, SSL_ERROR_WANT_WRITE);
      ASSERT_EQ(client_ret, -1);
      ASSERT_EQ(client_err, SSL_ERROR_WANT_READ);
    }

    // The NewSessionTickets should have been flushed and processed.
    EXPECT_TRUE(g_last_session);
  }
}

TEST(SSLTest, AddChainCertHack) {
  // Ensure that we don't accidentally break the hack that we have in place to
  // keep curl and serf happy when they use an |X509| even after transferring
  // ownership.

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  X509 *cert = GetTestCertificate().release();
  ASSERT_TRUE(cert);
  SSL_CTX_add0_chain_cert(ctx.get(), cert);

  // This should not trigger a use-after-free.
  X509_cmp(cert, cert);
}

TEST(SSLTest, GetCertificate) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  ASSERT_TRUE(cert);
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), cert.get()));
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);

  X509 *cert2 = SSL_CTX_get0_certificate(ctx.get());
  ASSERT_TRUE(cert2);
  X509 *cert3 = SSL_get_certificate(ssl.get());
  ASSERT_TRUE(cert3);

  // The old and new certificates must be identical.
  EXPECT_EQ(0, X509_cmp(cert.get(), cert2));
  EXPECT_EQ(0, X509_cmp(cert.get(), cert3));

  uint8_t *der = nullptr;
  long der_len = i2d_X509(cert.get(), &der);
  ASSERT_LT(0, der_len);
  bssl::UniquePtr<uint8_t> free_der(der);

  uint8_t *der2 = nullptr;
  long der2_len = i2d_X509(cert2, &der2);
  ASSERT_LT(0, der2_len);
  bssl::UniquePtr<uint8_t> free_der2(der2);

  uint8_t *der3 = nullptr;
  long der3_len = i2d_X509(cert3, &der3);
  ASSERT_LT(0, der3_len);
  bssl::UniquePtr<uint8_t> free_der3(der3);

  // They must also encode identically.
  EXPECT_EQ(Bytes(der, der_len), Bytes(der2, der2_len));
  EXPECT_EQ(Bytes(der, der_len), Bytes(der3, der3_len));
}

TEST(SSLTest, SetChainAndKeyMismatch) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  std::vector<CRYPTO_BUFFER *> chain = {
      leaf.get(),
  };

  // Should fail because |GetTestKey| doesn't match the chain-test certificate.
  ASSERT_FALSE(SSL_CTX_set_chain_and_key(ctx.get(), chain.data(), chain.size(),
                                         key.get(), nullptr));
  ERR_clear_error();
}

TEST(SSLTest, CertThenKeyMismatch) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<X509> leaf = GetChainTestCertificate();
  ASSERT_TRUE(leaf);

  // There is no key or certificate, so |SSL_CTX_check_private_key| fails.
  EXPECT_FALSE(SSL_CTX_check_private_key(ctx.get()));

  // With only a certificate, |SSL_CTX_check_private_key| still fails.
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), leaf.get()));
  EXPECT_FALSE(SSL_CTX_check_private_key(ctx.get()));

  // The private key does not match the certificate, so it should fail.
  EXPECT_FALSE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));

  // Checking the private key fails, but this is really because there is still
  // no private key.
  EXPECT_FALSE(SSL_CTX_check_private_key(ctx.get()));
  EXPECT_EQ(nullptr, SSL_CTX_get0_privatekey(ctx.get()));
}

TEST(SSLTest, KeyThenCertMismatch) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<X509> leaf = GetChainTestCertificate();
  ASSERT_TRUE(leaf);

  // There is no key or certificate, so |SSL_CTX_check_private_key| fails.
  EXPECT_FALSE(SSL_CTX_check_private_key(ctx.get()));

  // With only a key, |SSL_CTX_check_private_key| still fails.
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));
  EXPECT_FALSE(SSL_CTX_check_private_key(ctx.get()));

  // If configuring a certificate that doesn't match the key, configuration
  // actually succeeds. We just silently drop the private key.
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), leaf.get()));
  EXPECT_EQ(nullptr, SSL_CTX_get0_privatekey(ctx.get()));

  // Some callers configure the private key, then the certificate, and then
  // expect |SSL_CTX_check_private_key| to check consistency. It does, but only
  // by way of noticing there is no private key. The actual consistency check
  // happened in |SSL_CTX_use_certificate|.
  EXPECT_FALSE(SSL_CTX_check_private_key(ctx.get()));
}

TEST(SSLTest, OverrideCertAndKey) {
  // It is possible to override an existing certificate by configuring
  // certificate, then key, due to |SSL_CTX_use_certificate|'s above silent
  // dropping behavior.
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<X509> leaf = GetTestCertificate();
  ASSERT_TRUE(leaf);
  bssl::UniquePtr<EVP_PKEY> key2 = GetChainTestKey();
  ASSERT_TRUE(key2);
  bssl::UniquePtr<X509> leaf2 = GetChainTestCertificate();
  ASSERT_TRUE(leaf2);

  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), leaf.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));

  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), leaf2.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key2.get()));
}

TEST(SSLTest, OverrideKeyMethodWithKey) {
  // Make an SSL_PRIVATE_KEY_METHOD that should never be called.
  static const SSL_PRIVATE_KEY_METHOD kErrorMethod = {
      [](SSL *ssl, uint8_t *out, size_t *out_len, size_t max_out,
         uint16_t signature_algorithm, const uint8_t *in,
         size_t in_len) { return ssl_private_key_failure; },
      [](SSL *ssl, uint8_t *out, size_t *out_len, size_t max_out,
         const uint8_t *in, size_t in_len) { return ssl_private_key_failure; },
      [](SSL *ssl, uint8_t *out, size_t *out_len, size_t max_oun) {
        return ssl_private_key_failure;
      },
  };

  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<X509> leaf = GetTestCertificate();
  ASSERT_TRUE(leaf);

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), leaf.get()));

  // Configuring an |SSL_PRIVATE_KEY_METHOD| and then overwriting it with an
  // |EVP_PKEY| should clear the |SSL_PRIVATE_KEY_METHOD|.
  SSL_CTX_set_private_key_method(ctx.get(), &kErrorMethod);
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, ctx.get(), ctx.get()));
}

// Configuring a chain and then overwriting it with a different chain should
// clear the old one.
TEST(SSLTest, OverrideChain) {
  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<X509> leaf = GetChainTestCertificate();
  ASSERT_TRUE(leaf);
  bssl::UniquePtr<X509> ca = GetChainTestIntermediate();
  ASSERT_TRUE(ca);

  bssl::UniquePtr<STACK_OF(X509)> chain(sk_X509_new_null());
  ASSERT_TRUE(chain);
  ASSERT_TRUE(bssl::PushToStack(chain.get(), bssl::UpRef(ca)));

  bssl::UniquePtr<STACK_OF(X509)> wrong_chain(sk_X509_new_null());
  ASSERT_TRUE(wrong_chain);
  ASSERT_TRUE(bssl::PushToStack(wrong_chain.get(), bssl::UpRef(leaf)));
  ASSERT_TRUE(bssl::PushToStack(wrong_chain.get(), bssl::UpRef(leaf)));

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), leaf.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));

  // Configure one chain, then replace it with another. Note this API considers
  // the chain to exclude the leaf.
  ASSERT_TRUE(SSL_CTX_set1_chain(ctx.get(), wrong_chain.get()));
  ASSERT_TRUE(SSL_CTX_set1_chain(ctx.get(), chain.get()));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, ctx.get(), ctx.get()));
  EXPECT_TRUE(ChainsEqual(SSL_get_peer_full_cert_chain(client.get()),
                          {leaf.get(), ca.get()}));
}

TEST(SSLTest, OverrideChainAndKey) {
  bssl::UniquePtr<EVP_PKEY> key1 = GetChainTestKey();
  ASSERT_TRUE(key1);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf1 = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf1);
  bssl::UniquePtr<CRYPTO_BUFFER> ca1 = GetChainTestIntermediateBuffer();
  ASSERT_TRUE(ca1);
  bssl::UniquePtr<EVP_PKEY> key2 = GetECDSATestKey();
  ASSERT_TRUE(key2);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf2 = GetECDSATestCertificateBuffer();
  ASSERT_TRUE(leaf2);

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Configure one cert and key pair, then replace it with noather.
  std::vector<CRYPTO_BUFFER *> certs = {leaf1.get(), ca1.get()};
  ASSERT_TRUE(SSL_CTX_set_chain_and_key(ctx.get(), certs.data(), certs.size(),
                                        key1.get(), nullptr));
  certs = {leaf2.get()};
  ASSERT_TRUE(SSL_CTX_set_chain_and_key(ctx.get(), certs.data(), certs.size(),
                                        key2.get(), nullptr));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, ctx.get(), ctx.get()));
  EXPECT_TRUE(
      BuffersEqual(SSL_get0_peer_certificates(client.get()), {leaf2.get()}));
}

TEST(SSLTest, CredentialChains) {
  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  bssl::UniquePtr<CRYPTO_BUFFER> ca = GetChainTestIntermediateBuffer();
  ASSERT_TRUE(ca);
  bssl::UniquePtr<CRYPTO_BUFFER> ca_subject =
      GetChainTestIntermediateIssuerBuffer();
  ASSERT_TRUE(ca_subject);

  bssl::UniquePtr<CRYPTO_BUFFER> testcert = GetTestCertificateBuffer();
  ASSERT_TRUE(testcert);
  bssl::UniquePtr<EVP_PKEY> testkey = GetTestKey();
  ASSERT_TRUE(testkey);

  std::vector<CRYPTO_BUFFER *> test_chain = {testcert.get()};
  std::vector<CRYPTO_BUFFER *> chain = {leaf.get(), ca.get()};
  std::vector<CRYPTO_BUFFER *> wrong_chain = {leaf.get(), leaf.get(),
                                              leaf.get()};

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<SSL_CREDENTIAL> cred(SSL_CREDENTIAL_new_x509());
  ASSERT_TRUE(cred);
  bssl::UniquePtr<SSL_CREDENTIAL> cred2(SSL_CREDENTIAL_new_x509());
  ASSERT_TRUE(cred2);

  // Configure one chain (including the leaf), then replace it with another.
  ASSERT_TRUE(SSL_CREDENTIAL_set1_cert_chain(cred.get(), wrong_chain.data(),
                                             wrong_chain.size()));
  CBS ca_subject_cbs, ca_cbs;
  CRYPTO_BUFFER_init_CBS(ca.get(), &ca_cbs);
  ASSERT_TRUE(ssl_cert_extract_issuer(&ca_cbs, &ca_subject_cbs));
  bssl::UniquePtr<CRYPTO_BUFFER> subject_buf(
      CRYPTO_BUFFER_new_from_CBS(&ca_subject_cbs, nullptr));
  EXPECT_EQ(Bytes(CRYPTO_BUFFER_data(ca_subject.get()),
                  CRYPTO_BUFFER_len(ca_subject.get())),
            Bytes(CRYPTO_BUFFER_data(subject_buf.get()),
                  CRYPTO_BUFFER_len(subject_buf.get())));
#if !defined(BORINGSSL_SHARED_LIBRARY)
  ASSERT_FALSE(
      cred->ChainContainsIssuer(Span(CRYPTO_BUFFER_data(subject_buf.get()),
                                     CRYPTO_BUFFER_len(subject_buf.get()))));
#endif

  ASSERT_TRUE(
      SSL_CREDENTIAL_set1_cert_chain(cred.get(), chain.data(), chain.size()));

#if !defined(BORINGSSL_SHARED_LIBRARY)
  ASSERT_TRUE(
      cred->ChainContainsIssuer(Span(CRYPTO_BUFFER_data(subject_buf.get()),
                                     CRYPTO_BUFFER_len(subject_buf.get()))));
#endif

  ASSERT_TRUE(SSL_CREDENTIAL_set1_cert_chain(cred2.get(), test_chain.data(),
                                             test_chain.size()));

  ASSERT_TRUE(SSL_CREDENTIAL_set1_private_key(cred.get(), key.get()));
  ASSERT_TRUE(SSL_CREDENTIAL_set1_private_key(cred2.get(), testkey.get()));
  SSL_CREDENTIAL_set_must_match_issuer(cred.get(), 1);
  SSL_CREDENTIAL_set_must_match_issuer(cred2.get(), 1);
  ASSERT_TRUE(SSL_CTX_add1_credential(ctx.get(), cred.get()));
  ASSERT_TRUE(SSL_CTX_add1_credential(ctx.get(), cred2.get()));

  bssl::UniquePtr<SSL> client, server;

  // With no CA requested by client, we should fail with only cred1 and cred2
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, ctx.get(), ctx.get()));

  // Have the client request a bogus name that will not match
  bssl::UniquePtr<CRYPTO_BUFFER> bogus_subject = GetBogusIssuerBuffer();
  ASSERT_TRUE(bogus_subject);
  bssl::UniquePtr<SSL> client2, server2;
  ClientConfig bogus_subject_config;
  bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> bogus_subjects(
      sk_CRYPTO_BUFFER_new_null());
  ASSERT_TRUE(bogus_subjects);
  ASSERT_TRUE(PushToStack(bogus_subjects.get(), std::move(bogus_subject)));
  bogus_subject_config.ca_names = bogus_subjects.get();
  bogus_subjects.release();
  // A bogus issuer that does not match should fail
  ASSERT_FALSE(ConnectClientAndServer(&client2, &server2, ctx.get(), ctx.get(),
                                      bogus_subject_config));

  // Have the client request the name of the chain ca.
  bssl::UniquePtr<CRYPTO_BUFFER> chain_subject =
      GetChainTestIntermediateIssuerBuffer();
  ASSERT_TRUE(chain_subject);
  bssl::UniquePtr<SSL> client3, server3;
  ClientConfig chain_subject_config;
  bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> chain_subjects(
      sk_CRYPTO_BUFFER_new_null());
  ASSERT_TRUE(chain_subjects);
  ASSERT_TRUE(PushToStack(chain_subjects.get(), std::move(chain_subject)));
  chain_subject_config.ca_names = chain_subjects.get();
  chain_subjects.release();
  // If we ask for the chain ca subject, we should get it
  ASSERT_TRUE(ConnectClientAndServer(&client3, &server3, ctx.get(), ctx.get(),
                                     chain_subject_config));
  EXPECT_TRUE(BuffersEqual(SSL_get0_peer_certificates(client3.get()),
                           {leaf.get(), ca.get()}));

  // Have the client request the name of the test ca.
  bssl::UniquePtr<CRYPTO_BUFFER> test_subject = GetTestCertIssuerBuffer();
  ASSERT_TRUE(test_subject);
  bssl::UniquePtr<SSL> client4, server4;
  ClientConfig test_subject_config;
  bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> test_subjects(
      sk_CRYPTO_BUFFER_new_null());
  ASSERT_TRUE(test_subjects);
  ASSERT_TRUE(PushToStack(test_subjects.get(), std::move(test_subject)));
  test_subject_config.ca_names = test_subjects.get();
  test_subjects.release();
  // If we ask for the test ca subject, we should get it
  ASSERT_TRUE(ConnectClientAndServer(&client4, &server4, ctx.get(), ctx.get(),
                                     test_subject_config));
  EXPECT_TRUE(BuffersEqual(SSL_get0_peer_certificates(client4.get()),
                           {testcert.get()}));

  // Add cred3 to the CTX so we have an ubiquitous credential
  bssl::UniquePtr<SSL_CREDENTIAL> cred3(SSL_CREDENTIAL_new_x509());
  ASSERT_TRUE(cred3);
  ASSERT_TRUE(
      SSL_CREDENTIAL_set1_cert_chain(cred3.get(), chain.data(), chain.size()));
  ASSERT_TRUE(SSL_CREDENTIAL_set1_private_key(cred3.get(), key.get()));
  ASSERT_TRUE(SSL_CTX_add1_credential(ctx.get(), cred3.get()));

  // With no CA sent, we should now succeed.
  bssl::UniquePtr<SSL> client5, server5;
  ASSERT_TRUE(ConnectClientAndServer(&client5, &server5, ctx.get(), ctx.get()));
  EXPECT_TRUE(BuffersEqual(SSL_get0_peer_certificates(client5.get()),
                           {leaf.get(), ca.get()}));
}

TEST(SSLTest, CredentialCertProperties) {
  // A CertificatePropertyList containing a trust_anchors property, and an
  // unknown property 0xbb with 0 bytes of data.
  bssl::UniquePtr<SSL_CREDENTIAL> cred(SSL_CREDENTIAL_new_x509());
  ASSERT_TRUE(cred);
  static const uint8_t kTestProperties1[] = {0x00, 0x0b, 0x00, 0x00, 0x00,
                                             0x03, 0xba, 0xdb, 0x0b, 0x00,
                                             0xbb, 0x00, 0x00};
  bssl::UniquePtr<CRYPTO_BUFFER> pl(
      CRYPTO_BUFFER_new(kTestProperties1, sizeof(kTestProperties1), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_TRUE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));

  // A CertificatePropertyList containing a trust_anchors property, and an
  // unknown property 0xbb with 1 byte of data.
  static const uint8_t kTestProperties2[] = {0x00, 0x0c, 0x00, 0x00, 0x00,
                                             0x03, 0xba, 0xdb, 0x0b, 0x00,
                                             0xbb, 0x00, 0x01, 0xba};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties2, sizeof(kTestProperties2), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_TRUE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));

  // A CertificatePropertyList containing a trust_anchors property, and an
  // unknown but malformed property 0xbb with missing data.
  static const uint8_t kTestProperties3[] = {0x00, 0x09, 0x00, 0x00, 0x00, 0x03,
                                      0xba, 0xdb, 0x0b, 0x00, 0xbb};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties3, sizeof(kTestProperties3), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_FALSE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_INVALID_CERTIFICATE_PROPERTY_LIST));

  // A CertificatePropertyList containing a trust_anchors property, and an
  // unknown but malformed property 0xbb with incorrect length data.
  static const uint8_t kTestProperties4[] = {0x00, 0x0c, 0x00, 0x00, 0x00,
                                             0x03, 0xba, 0xdb, 0x0b, 0x00,
                                             0xbb, 0x00, 0x03, 0xba};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties4, sizeof(kTestProperties4), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_FALSE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_INVALID_CERTIFICATE_PROPERTY_LIST));

  // A CertificatePropertyList containing a trust_anchors property with 0 bytes
  // of data.
  static const uint8_t kTestProperties5[] = {0x00, 0x04, 0x00,
                                             0x00, 0x00, 0x00};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties5, sizeof(kTestProperties5), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_FALSE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_INVALID_TRUST_ANCHOR_LIST));

  // A CertificatePropertyList containing a trust_anchors property with extra
  // data.
  static const uint8_t kTestProperties6[] = {0x00, 0x08, 0x00, 0x00, 0x00,
                                             0x03, 0xba, 0xdb, 0x0b, 0xbb};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties6, sizeof(kTestProperties6), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_FALSE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_INVALID_CERTIFICATE_PROPERTY_LIST));

  // A CertificatePropertyList containing a trust_anchors property with missing
  // data.
  static const uint8_t kTestProperties7[] = {0x00, 0x06, 0x00, 0x00,
                                             0x00, 0x03, 0xba, 0xdb};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties7, sizeof(kTestProperties7), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_FALSE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_INVALID_CERTIFICATE_PROPERTY_LIST));

  // A CertificatePropertyList containing only a trust_anchors property.
  static const uint8_t kTestProperties8[] = {0x00, 0x07, 0x00, 0x00, 0x00,
                                             0x03, 0xba, 0xdb, 0x0b};
  pl.reset(
      CRYPTO_BUFFER_new(kTestProperties8, sizeof(kTestProperties8), nullptr));
  ASSERT_TRUE(pl);
  EXPECT_TRUE(
      SSL_CREDENTIAL_set1_certificate_properties(cred.get(), pl.get()));
}

TEST(SSLTest, SetChainAndKeyCtx) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(server_ctx);

  ASSERT_EQ(nullptr, SSL_CTX_get0_chain(server_ctx.get()));

  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  bssl::UniquePtr<CRYPTO_BUFFER> intermediate =
      GetChainTestIntermediateBuffer();
  ASSERT_TRUE(intermediate);
  std::vector<CRYPTO_BUFFER *> chain = {
      leaf.get(),
      intermediate.get(),
  };
  ASSERT_TRUE(SSL_CTX_set_chain_and_key(server_ctx.get(), chain.data(),
                                        chain.size(), key.get(), nullptr));

  ASSERT_EQ(chain.size(),
            sk_CRYPTO_BUFFER_num(SSL_CTX_get0_chain(server_ctx.get())));

  SSL_CTX_set_custom_verify(
      client_ctx.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
}

TEST(SSLTest, SetChainAndKeySSL) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(server_ctx);

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  SSL_set_shed_handshake_config(client.get(), true);
  SSL_set_shed_handshake_config(server.get(), true);

  ASSERT_EQ(nullptr, SSL_get0_chain(server.get()));

  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  bssl::UniquePtr<CRYPTO_BUFFER> intermediate =
      GetChainTestIntermediateBuffer();
  ASSERT_TRUE(intermediate);
  std::vector<CRYPTO_BUFFER *> chain = {
      leaf.get(),
      intermediate.get(),
  };
  ASSERT_TRUE(SSL_set_chain_and_key(server.get(), chain.data(), chain.size(),
                                    key.get(), nullptr));

  ASSERT_EQ(chain.size(), sk_CRYPTO_BUFFER_num(SSL_get0_chain(server.get())));

  SSL_set_custom_verify(
      client.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });

  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  // The server is configured to shed handshake config, so the certificate is no
  // longer available after the handshake.
  ASSERT_EQ(nullptr, SSL_get0_chain(server.get()));
}

TEST(SSLTest, BuffersFailWithoutCustomVerify) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(server_ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  std::vector<CRYPTO_BUFFER *> chain = {leaf.get()};
  ASSERT_TRUE(SSL_CTX_set_chain_and_key(server_ctx.get(), chain.data(),
                                        chain.size(), key.get(), nullptr));

  // Without SSL_CTX_set_custom_verify(), i.e. with everything in the default
  // configuration, certificate verification should fail.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));

  // Whereas with a verifier, the connection should succeed.
  SSL_CTX_set_custom_verify(
      client_ctx.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
}

TEST(SSLTest, CustomVerify) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(server_ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  std::vector<CRYPTO_BUFFER *> chain = {leaf.get()};
  ASSERT_TRUE(SSL_CTX_set_chain_and_key(server_ctx.get(), chain.data(),
                                        chain.size(), key.get(), nullptr));

  SSL_CTX_set_custom_verify(
      client_ctx.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));

  // With SSL_VERIFY_PEER, ssl_verify_invalid should result in a dropped
  // connection.
  SSL_CTX_set_custom_verify(
      client_ctx.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_invalid;
      });

  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));

  // But with SSL_VERIFY_NONE, ssl_verify_invalid should not cause a dropped
  // connection.
  SSL_CTX_set_custom_verify(
      client_ctx.get(), SSL_VERIFY_NONE,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_invalid;
      });

  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
}

TEST(SSLTest, ClientCABuffers) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_with_buffers_method()));
  ASSERT_TRUE(server_ctx);

  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<CRYPTO_BUFFER> leaf = GetChainTestCertificateBuffer();
  ASSERT_TRUE(leaf);
  bssl::UniquePtr<CRYPTO_BUFFER> intermediate =
      GetChainTestIntermediateBuffer();
  ASSERT_TRUE(intermediate);
  std::vector<CRYPTO_BUFFER *> chain = {
      leaf.get(),
      intermediate.get(),
  };
  ASSERT_TRUE(SSL_CTX_set_chain_and_key(server_ctx.get(), chain.data(),
                                        chain.size(), key.get(), nullptr));

  bssl::UniquePtr<CRYPTO_BUFFER> ca_name(
      CRYPTO_BUFFER_new(kTestName, sizeof(kTestName), nullptr));
  ASSERT_TRUE(ca_name);
  bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> ca_names(
      sk_CRYPTO_BUFFER_new_null());
  ASSERT_TRUE(ca_names);
  ASSERT_TRUE(PushToStack(ca_names.get(), std::move(ca_name)));
  SSL_CTX_set0_client_CAs(server_ctx.get(), ca_names.release());

  // Configure client and server to accept all certificates.
  SSL_CTX_set_custom_verify(
      client_ctx.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });
  SSL_CTX_set_custom_verify(
      server_ctx.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });

  bool cert_cb_called = false;
  SSL_CTX_set_cert_cb(
      client_ctx.get(),
      [](SSL *ssl, void *arg) -> int {
        const STACK_OF(CRYPTO_BUFFER) *peer_names =
            SSL_get0_server_requested_CAs(ssl);
        EXPECT_EQ(1u, sk_CRYPTO_BUFFER_num(peer_names));
        CRYPTO_BUFFER *peer_name = sk_CRYPTO_BUFFER_value(peer_names, 0);
        EXPECT_EQ(Bytes(kTestName), Bytes(CRYPTO_BUFFER_data(peer_name),
                                          CRYPTO_BUFFER_len(peer_name)));
        *reinterpret_cast<bool *>(arg) = true;
        return 1;
      },
      &cert_cb_called);

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
  EXPECT_TRUE(cert_cb_called);
}

// Configuring the empty cipher list, though an error, should still modify the
// configuration.
TEST(SSLTest, EmptyCipherList) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Initially, the cipher list is not empty.
  EXPECT_NE(0u, sk_SSL_CIPHER_num(SSL_CTX_get_ciphers(ctx.get())));

  // Configuring the empty cipher list fails.
  EXPECT_FALSE(SSL_CTX_set_cipher_list(ctx.get(), ""));
  ERR_clear_error();

  // But the cipher list is still updated to empty.
  EXPECT_EQ(0u, sk_SSL_CIPHER_num(SSL_CTX_get_ciphers(ctx.get())));
}

// ssl_test_ticket_aead_failure_mode enumerates the possible ways in which the
// test |SSL_TICKET_AEAD_METHOD| can fail.
enum ssl_test_ticket_aead_failure_mode {
  ssl_test_ticket_aead_ok = 0,
  ssl_test_ticket_aead_seal_fail,
  ssl_test_ticket_aead_open_soft_fail,
  ssl_test_ticket_aead_open_hard_fail,
};

struct ssl_test_ticket_aead_state {
  unsigned retry_count = 0;
  ssl_test_ticket_aead_failure_mode failure_mode = ssl_test_ticket_aead_ok;
};

static int ssl_test_ticket_aead_ex_index_dup(CRYPTO_EX_DATA *to,
                                             const CRYPTO_EX_DATA *from,
                                             void **from_d, int index,
                                             long argl, void *argp) {
  abort();
}

static void ssl_test_ticket_aead_ex_index_free(void *parent, void *ptr,
                                               CRYPTO_EX_DATA *ad, int index,
                                               long argl, void *argp) {
  delete reinterpret_cast<ssl_test_ticket_aead_state *>(ptr);
}

static CRYPTO_once_t g_ssl_test_ticket_aead_ex_index_once = CRYPTO_ONCE_INIT;
static int g_ssl_test_ticket_aead_ex_index;

static int ssl_test_ticket_aead_get_ex_index() {
  CRYPTO_once(&g_ssl_test_ticket_aead_ex_index_once, [] {
    g_ssl_test_ticket_aead_ex_index = SSL_get_ex_new_index(
        0, nullptr, nullptr, ssl_test_ticket_aead_ex_index_dup,
        ssl_test_ticket_aead_ex_index_free);
  });
  return g_ssl_test_ticket_aead_ex_index;
}

static size_t ssl_test_ticket_aead_max_overhead(SSL *ssl) { return 1; }

static int ssl_test_ticket_aead_seal(SSL *ssl, uint8_t *out, size_t *out_len,
                                     size_t max_out_len, const uint8_t *in,
                                     size_t in_len) {
  auto state = reinterpret_cast<ssl_test_ticket_aead_state *>(
      SSL_get_ex_data(ssl, ssl_test_ticket_aead_get_ex_index()));

  if (state->failure_mode == ssl_test_ticket_aead_seal_fail ||
      max_out_len < in_len + 1) {
    return 0;
  }

  OPENSSL_memmove(out, in, in_len);
  out[in_len] = 0xff;
  *out_len = in_len + 1;

  return 1;
}

static ssl_ticket_aead_result_t ssl_test_ticket_aead_open(
    SSL *ssl, uint8_t *out, size_t *out_len, size_t max_out_len,
    const uint8_t *in, size_t in_len) {
  auto state = reinterpret_cast<ssl_test_ticket_aead_state *>(
      SSL_get_ex_data(ssl, ssl_test_ticket_aead_get_ex_index()));

  if (state->retry_count > 0) {
    state->retry_count--;
    return ssl_ticket_aead_retry;
  }

  switch (state->failure_mode) {
    case ssl_test_ticket_aead_ok:
      break;
    case ssl_test_ticket_aead_seal_fail:
      // If |seal| failed then there shouldn't be any ticket to try and
      // decrypt.
      abort();
      break;
    case ssl_test_ticket_aead_open_soft_fail:
      return ssl_ticket_aead_ignore_ticket;
    case ssl_test_ticket_aead_open_hard_fail:
      return ssl_ticket_aead_error;
  }

  if (in_len == 0 || in[in_len - 1] != 0xff) {
    return ssl_ticket_aead_ignore_ticket;
  }

  if (max_out_len < in_len - 1) {
    return ssl_ticket_aead_error;
  }

  OPENSSL_memmove(out, in, in_len - 1);
  *out_len = in_len - 1;
  return ssl_ticket_aead_success;
}

static const SSL_TICKET_AEAD_METHOD kSSLTestTicketMethod = {
    ssl_test_ticket_aead_max_overhead,
    ssl_test_ticket_aead_seal,
    ssl_test_ticket_aead_open,
};

static void ConnectClientAndServerWithTicketMethod(
    bssl::UniquePtr<SSL> *out_client, bssl::UniquePtr<SSL> *out_server,
    SSL_CTX *client_ctx, SSL_CTX *server_ctx, unsigned retry_count,
    ssl_test_ticket_aead_failure_mode failure_mode, SSL_SESSION *session) {
  bssl::UniquePtr<SSL> client(SSL_new(client_ctx)), server(SSL_new(server_ctx));
  ASSERT_TRUE(client);
  ASSERT_TRUE(server);
  SSL_set_connect_state(client.get());
  SSL_set_accept_state(server.get());

  auto state = new ssl_test_ticket_aead_state;
  state->retry_count = retry_count;
  state->failure_mode = failure_mode;

  ASSERT_GE(ssl_test_ticket_aead_get_ex_index(), 0);
  ASSERT_TRUE(SSL_set_ex_data(server.get(), ssl_test_ticket_aead_get_ex_index(),
                              state));

  SSL_set_session(client.get(), session);

  BIO *bio1, *bio2;
  ASSERT_TRUE(BIO_new_bio_pair(&bio1, 0, &bio2, 0));

  // SSL_set_bio takes ownership.
  SSL_set_bio(client.get(), bio1, bio1);
  SSL_set_bio(server.get(), bio2, bio2);

  if (CompleteHandshakes(client.get(), server.get())) {
    *out_client = std::move(client);
    *out_server = std::move(server);
  } else {
    out_client->reset();
    out_server->reset();
  }
}

using TicketAEADMethodParam =
    testing::tuple<uint16_t, unsigned, ssl_test_ticket_aead_failure_mode>;

class TicketAEADMethodTest
    : public ::testing::TestWithParam<TicketAEADMethodParam> {};

TEST_P(TicketAEADMethodTest, Resume) {
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);

  const uint16_t version = testing::get<0>(GetParam());
  const unsigned retry_count = testing::get<1>(GetParam());
  const ssl_test_ticket_aead_failure_mode failure_mode =
      testing::get<2>(GetParam());

  ASSERT_TRUE(SSL_CTX_set_min_proto_version(client_ctx.get(), version));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), version));
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(server_ctx.get(), version));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), version));

  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_current_time_cb(client_ctx.get(), FrozenTimeCallback);
  SSL_CTX_set_current_time_cb(server_ctx.get(), FrozenTimeCallback);
  SSL_CTX_sess_set_new_cb(client_ctx.get(), SaveLastSession);

  SSL_CTX_set_ticket_aead_method(server_ctx.get(), &kSSLTestTicketMethod);

  bssl::UniquePtr<SSL> client, server;
  ASSERT_NO_FATAL_FAILURE(ConnectClientAndServerWithTicketMethod(
      &client, &server, client_ctx.get(), server_ctx.get(), retry_count,
      failure_mode, nullptr));
  switch (failure_mode) {
    case ssl_test_ticket_aead_ok:
    case ssl_test_ticket_aead_open_hard_fail:
    case ssl_test_ticket_aead_open_soft_fail:
      ASSERT_TRUE(client);
      break;
    case ssl_test_ticket_aead_seal_fail:
      EXPECT_FALSE(client);
      return;
  }
  EXPECT_FALSE(SSL_session_reused(client.get()));
  EXPECT_FALSE(SSL_session_reused(server.get()));

  ASSERT_TRUE(FlushNewSessionTickets(client.get(), server.get()));
  bssl::UniquePtr<SSL_SESSION> session = std::move(g_last_session);
  ASSERT_NO_FATAL_FAILURE(ConnectClientAndServerWithTicketMethod(
      &client, &server, client_ctx.get(), server_ctx.get(), retry_count,
      failure_mode, session.get()));
  switch (failure_mode) {
    case ssl_test_ticket_aead_ok:
      ASSERT_TRUE(client);
      EXPECT_TRUE(SSL_session_reused(client.get()));
      EXPECT_TRUE(SSL_session_reused(server.get()));
      break;
    case ssl_test_ticket_aead_seal_fail:
      abort();
      break;
    case ssl_test_ticket_aead_open_hard_fail:
      EXPECT_FALSE(client);
      break;
    case ssl_test_ticket_aead_open_soft_fail:
      ASSERT_TRUE(client);
      EXPECT_FALSE(SSL_session_reused(client.get()));
      EXPECT_FALSE(SSL_session_reused(server.get()));
  }
}

std::string TicketAEADMethodParamToString(
    const testing::TestParamInfo<TicketAEADMethodParam> &params) {
  std::string ret = GetVersionName(std::get<0>(params.param));
  // GTest only allows alphanumeric characters and '_' in the parameter
  // string. Additionally filter out the 'v' to get "TLS13" over "TLSv13".
  for (auto it = ret.begin(); it != ret.end();) {
    if (*it == '.' || *it == 'v') {
      it = ret.erase(it);
    } else {
      ++it;
    }
  }
  char retry_count[256];
  snprintf(retry_count, sizeof(retry_count), "%u", std::get<1>(params.param));
  ret += "_";
  ret += retry_count;
  ret += "Retries_";
  switch (std::get<2>(params.param)) {
    case ssl_test_ticket_aead_ok:
      ret += "OK";
      break;
    case ssl_test_ticket_aead_seal_fail:
      ret += "SealFail";
      break;
    case ssl_test_ticket_aead_open_soft_fail:
      ret += "OpenSoftFail";
      break;
    case ssl_test_ticket_aead_open_hard_fail:
      ret += "OpenHardFail";
      break;
  }
  return ret;
}

INSTANTIATE_TEST_SUITE_P(
    TicketAEADMethodTests, TicketAEADMethodTest,
    testing::Combine(testing::Values(TLS1_2_VERSION, TLS1_3_VERSION),
                     testing::Values(0, 1, 2),
                     testing::Values(ssl_test_ticket_aead_ok,
                                     ssl_test_ticket_aead_seal_fail,
                                     ssl_test_ticket_aead_open_soft_fail,
                                     ssl_test_ticket_aead_open_hard_fail)),
    TicketAEADMethodParamToString);

TEST(SSLTest, SelectNextProto) {
  uint8_t *result;
  uint8_t result_len;

  // If there is an overlap, it should be returned.
  EXPECT_EQ(OPENSSL_NPN_NEGOTIATED,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\1x\1y\1a\1z", 8));
  EXPECT_EQ(Bytes("a"), Bytes(result, result_len));

  EXPECT_EQ(OPENSSL_NPN_NEGOTIATED,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\1x\1y\2bb\1z", 9));
  EXPECT_EQ(Bytes("bb"), Bytes(result, result_len));

  EXPECT_EQ(OPENSSL_NPN_NEGOTIATED,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\1x\1y\3ccc\1z", 10));
  EXPECT_EQ(Bytes("ccc"), Bytes(result, result_len));

  // Peer preference order takes precedence over local.
  EXPECT_EQ(OPENSSL_NPN_NEGOTIATED,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\3ccc\2bb\1a", 9));
  EXPECT_EQ(Bytes("a"), Bytes(result, result_len));

  // If there is no overlap, opportunistically select the first local protocol.
  // ALPN callers should ignore this, but NPN callers may use this per
  // draft-agl-tls-nextprotoneg-03, section 6.
  EXPECT_EQ(OPENSSL_NPN_NO_OVERLAP,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\1x\2yy\3zzz", 9));
  EXPECT_EQ(Bytes("x"), Bytes(result, result_len));

  // The peer preference order may be empty in NPN. This should be treated as no
  // overlap and continue to select an opportunistic protocol.
  EXPECT_EQ(OPENSSL_NPN_NO_OVERLAP,
            SSL_select_next_proto(&result, &result_len, nullptr, 0,
                                  (const uint8_t *)"\1x\2yy\3zzz", 9));
  EXPECT_EQ(Bytes("x"), Bytes(result, result_len));

  // Although calling this function with no local protocols is a caller error,
  // it should cleanly return an empty protocol.
  EXPECT_EQ(
      OPENSSL_NPN_NO_OVERLAP,
      SSL_select_next_proto(&result, &result_len,
                            (const uint8_t *)"\1a\2bb\3ccc", 9, nullptr, 0));
  EXPECT_EQ(Bytes(""), Bytes(result, result_len));

  // Syntax errors are similarly caller errors.
  EXPECT_EQ(
      OPENSSL_NPN_NO_OVERLAP,
      SSL_select_next_proto(&result, &result_len, (const uint8_t *)"\4aaa", 4,
                            (const uint8_t *)"\1a\2bb\3ccc", 9));
  EXPECT_EQ(Bytes(""), Bytes(result, result_len));
  EXPECT_EQ(OPENSSL_NPN_NO_OVERLAP,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\4aaa", 4));
  EXPECT_EQ(Bytes(""), Bytes(result, result_len));

  // Protocols in protocol lists may not be empty.
  EXPECT_EQ(OPENSSL_NPN_NO_OVERLAP,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\0\2bb\3ccc", 8,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9));
  EXPECT_EQ(OPENSSL_NPN_NO_OVERLAP,
            SSL_select_next_proto(&result, &result_len,
                                  (const uint8_t *)"\1a\2bb\3ccc", 9,
                                  (const uint8_t *)"\0\2bb\3ccc", 8));
  EXPECT_EQ(Bytes(""), Bytes(result, result_len));
}

// The client should gracefully handle no suitable ciphers being enabled.
TEST(SSLTest, NoCiphersAvailable) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Configure |client_ctx| with a cipher list that does not intersect with its
  // version configuration.
  ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(
      ctx.get(), "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"));
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), TLS1_1_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), TLS1_1_VERSION));

  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  SSL_set_connect_state(ssl.get());

  UniquePtr<BIO> rbio(BIO_new(BIO_s_mem())), wbio(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(rbio);
  ASSERT_TRUE(wbio);
  SSL_set0_rbio(ssl.get(), rbio.release());
  SSL_set0_wbio(ssl.get(), wbio.release());

  int ret = SSL_do_handshake(ssl.get());
  EXPECT_EQ(-1, ret);
  EXPECT_EQ(SSL_ERROR_SSL, SSL_get_error(ssl.get(), ret));
  EXPECT_TRUE(
      ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_NO_CIPHERS_AVAILABLE));
}

TEST_P(SSLVersionTest, SessionVersion) {
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);
  EXPECT_EQ(version(), SSL_SESSION_get_protocol_version(session.get()));

  // Sessions in TLS 1.3 and later should be single-use.
  EXPECT_EQ(is_tls13(), !!SSL_SESSION_should_be_single_use(session.get()));

  // Making fake sessions for testing works.
  session.reset(SSL_SESSION_new(client_ctx_.get()));
  ASSERT_TRUE(session);
  ASSERT_TRUE(SSL_SESSION_set_protocol_version(session.get(), version()));
  EXPECT_EQ(version(), SSL_SESSION_get_protocol_version(session.get()));
}

TEST_P(SSLVersionTest, SSLPending) {
  UniquePtr<SSL> ssl(SSL_new(client_ctx_.get()));
  ASSERT_TRUE(ssl);
  EXPECT_EQ(0, SSL_pending(ssl.get()));

  ASSERT_TRUE(Connect());
  EXPECT_EQ(0, SSL_pending(client_.get()));
  EXPECT_EQ(0, SSL_has_pending(client_.get()));

  ASSERT_EQ(5, SSL_write(server_.get(), "hello", 5));
  ASSERT_EQ(5, SSL_write(server_.get(), "world", 5));
  EXPECT_EQ(0, SSL_pending(client_.get()));
  EXPECT_EQ(0, SSL_has_pending(client_.get()));

  char buf[10];
  ASSERT_EQ(1, SSL_peek(client_.get(), buf, 1));
  EXPECT_EQ(5, SSL_pending(client_.get()));
  EXPECT_EQ(1, SSL_has_pending(client_.get()));

  ASSERT_EQ(1, SSL_read(client_.get(), buf, 1));
  EXPECT_EQ(4, SSL_pending(client_.get()));
  EXPECT_EQ(1, SSL_has_pending(client_.get()));

  ASSERT_EQ(4, SSL_read(client_.get(), buf, 10));
  EXPECT_EQ(0, SSL_pending(client_.get()));
  if (is_dtls()) {
    // In DTLS, the two records would have been read as a single datagram and
    // buffered inside |client_|. Thus, |SSL_has_pending| should return true.
    //
    // This test is slightly unrealistic. It relies on |ConnectClientAndServer|
    // using a |BIO| pair, which does not preserve datagram boundaries. Reading
    // 1 byte, then 4 bytes, from the first record also relies on
    // https://crbug.com/boringssl/65. But it does test the codepaths. When
    // fixing either of these bugs, this test may need to be redone.
    EXPECT_EQ(1, SSL_has_pending(client_.get()));
  } else {
    // In TLS, we do not overread, so |SSL_has_pending| should report no data is
    // buffered.
    EXPECT_EQ(0, SSL_has_pending(client_.get()));
  }

  ASSERT_EQ(2, SSL_read(client_.get(), buf, 2));
  EXPECT_EQ(3, SSL_pending(client_.get()));
  EXPECT_EQ(1, SSL_has_pending(client_.get()));
}

// Test that post-handshake tickets consumed by |SSL_shutdown| are ignored.
TEST(SSLTest, ShutdownIgnoresTickets) {
  bssl::UniquePtr<SSL_CTX> ctx(CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(ctx);
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), TLS1_3_VERSION));

  SSL_CTX_set_session_cache_mode(ctx.get(), SSL_SESS_CACHE_BOTH);

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, ctx.get(), ctx.get()));

  SSL_CTX_sess_set_new_cb(ctx.get(), [](SSL *ssl, SSL_SESSION *session) -> int {
    ADD_FAILURE() << "New session callback called during SSL_shutdown";
    return 0;
  });

  // Send close_notify.
  EXPECT_EQ(0, SSL_shutdown(server.get()));
  EXPECT_EQ(0, SSL_shutdown(client.get()));

  // Receive close_notify.
  EXPECT_EQ(1, SSL_shutdown(server.get()));
  EXPECT_EQ(1, SSL_shutdown(client.get()));
}

TEST(SSLTest, SignatureAlgorithmProperties) {
  EXPECT_EQ(EVP_PKEY_NONE, SSL_get_signature_algorithm_key_type(0x1234));
  EXPECT_EQ(nullptr, SSL_get_signature_algorithm_digest(0x1234));
  EXPECT_FALSE(SSL_is_signature_algorithm_rsa_pss(0x1234));

  EXPECT_EQ(EVP_PKEY_RSA,
            SSL_get_signature_algorithm_key_type(SSL_SIGN_RSA_PKCS1_MD5_SHA1));
  EXPECT_EQ(EVP_md5_sha1(),
            SSL_get_signature_algorithm_digest(SSL_SIGN_RSA_PKCS1_MD5_SHA1));
  EXPECT_FALSE(SSL_is_signature_algorithm_rsa_pss(SSL_SIGN_RSA_PKCS1_MD5_SHA1));

  EXPECT_EQ(EVP_PKEY_EC, SSL_get_signature_algorithm_key_type(
                             SSL_SIGN_ECDSA_SECP256R1_SHA256));
  EXPECT_EQ(EVP_sha256(), SSL_get_signature_algorithm_digest(
                              SSL_SIGN_ECDSA_SECP256R1_SHA256));
  EXPECT_FALSE(
      SSL_is_signature_algorithm_rsa_pss(SSL_SIGN_ECDSA_SECP256R1_SHA256));

  EXPECT_EQ(EVP_PKEY_RSA,
            SSL_get_signature_algorithm_key_type(SSL_SIGN_RSA_PSS_RSAE_SHA384));
  EXPECT_EQ(EVP_sha384(),
            SSL_get_signature_algorithm_digest(SSL_SIGN_RSA_PSS_RSAE_SHA384));
  EXPECT_TRUE(SSL_is_signature_algorithm_rsa_pss(SSL_SIGN_RSA_PSS_RSAE_SHA384));
}

static int XORCompressFunc(SSL *ssl, CBB *out, const uint8_t *in,
                           size_t in_len) {
  for (size_t i = 0; i < in_len; i++) {
    if (!CBB_add_u8(out, in[i] ^ 0x55)) {
      return 0;
    }
  }

  SSL_set_app_data(ssl, XORCompressFunc);

  return 1;
}

static int XORDecompressFunc(SSL *ssl, CRYPTO_BUFFER **out,
                             size_t uncompressed_len, const uint8_t *in,
                             size_t in_len) {
  if (in_len != uncompressed_len) {
    return 0;
  }

  uint8_t *data;
  *out = CRYPTO_BUFFER_alloc(&data, uncompressed_len);
  if (*out == nullptr) {
    return 0;
  }

  for (size_t i = 0; i < in_len; i++) {
    data[i] = in[i] ^ 0x55;
  }

  SSL_set_app_data(ssl, XORDecompressFunc);

  return 1;
}

TEST(SSLTest, CertCompression) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);

  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_add_cert_compression_alg(
      client_ctx.get(), 0x1234, XORCompressFunc, XORDecompressFunc));
  ASSERT_TRUE(SSL_CTX_add_cert_compression_alg(
      server_ctx.get(), 0x1234, XORCompressFunc, XORDecompressFunc));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));

  EXPECT_TRUE(SSL_get_app_data(client.get()) == XORDecompressFunc);
  EXPECT_TRUE(SSL_get_app_data(server.get()) == XORCompressFunc);
}

void MoveBIOs(SSL *dest, SSL *src) {
  BIO *rbio = SSL_get_rbio(src);
  BIO_up_ref(rbio);
  SSL_set0_rbio(dest, rbio);

  BIO *wbio = SSL_get_wbio(src);
  BIO_up_ref(wbio);
  SSL_set0_wbio(dest, wbio);

  SSL_set0_rbio(src, nullptr);
  SSL_set0_wbio(src, nullptr);
}

void VerifyHandoff(bool use_new_alps_codepoint) {
  static const uint8_t alpn[] = {0x03, 'f', 'o', 'o'};
  static const uint8_t proto[] = {'f', 'o', 'o'};
  static const uint8_t alps[] = {0x04, 'a', 'l', 'p', 's'};

  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> handshaker_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  ASSERT_TRUE(handshaker_ctx);

  if (!use_new_alps_codepoint) {
    SetUpExpectedOldCodePoint(server_ctx.get());
  } else {
    SetUpExpectedNewCodePoint(server_ctx.get());
  }

  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_CLIENT);
  SSL_CTX_sess_set_new_cb(client_ctx.get(), SaveLastSession);
  SSL_CTX_set_handoff_mode(server_ctx.get(), true);
  uint8_t keys[48];
  SSL_CTX_get_tlsext_ticket_keys(server_ctx.get(), &keys, sizeof(keys));
  SSL_CTX_set_tlsext_ticket_keys(handshaker_ctx.get(), &keys, sizeof(keys));

  for (bool early_data : {false, true}) {
    SCOPED_TRACE(early_data);
    for (bool is_resume : {false, true}) {
      SCOPED_TRACE(is_resume);
      bssl::UniquePtr<SSL> client, server;
      ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                        server_ctx.get()));
      SSL_set_early_data_enabled(client.get(), early_data);

      // Set up client ALPS settings.
      SSL_set_alps_use_new_codepoint(client.get(), use_new_alps_codepoint);
      ASSERT_TRUE(SSL_set_alpn_protos(client.get(), alpn, sizeof(alpn)) == 0);
      ASSERT_TRUE(SSL_add_application_settings(client.get(), proto,
                                               sizeof(proto), nullptr, 0));
      if (is_resume) {
        ASSERT_TRUE(g_last_session);
        SSL_set_session(client.get(), g_last_session.get());
        if (early_data) {
          EXPECT_GT(g_last_session->ticket_max_early_data, 0u);
        }
      }


      int client_ret = SSL_do_handshake(client.get());
      int client_err = SSL_get_error(client.get(), client_ret);

      uint8_t byte_written;
      if (early_data && is_resume) {
        ASSERT_EQ(client_err, 0);
        EXPECT_TRUE(SSL_in_early_data(client.get()));
        // Attempt to write early data.
        byte_written = 43;
        EXPECT_EQ(SSL_write(client.get(), &byte_written, 1), 1);
      } else {
        ASSERT_EQ(client_err, SSL_ERROR_WANT_READ);
      }

      int server_ret = SSL_do_handshake(server.get());
      int server_err = SSL_get_error(server.get(), server_ret);
      ASSERT_EQ(server_err, SSL_ERROR_HANDOFF);

      ScopedCBB cbb;
      Array<uint8_t> handoff;
      SSL_CLIENT_HELLO hello;
      ASSERT_TRUE(CBB_init(cbb.get(), 256));
      ASSERT_TRUE(SSL_serialize_handoff(server.get(), cbb.get(), &hello));
      ASSERT_TRUE(CBBFinishArray(cbb.get(), &handoff));

      bssl::UniquePtr<SSL> handshaker(SSL_new(handshaker_ctx.get()));
      ASSERT_TRUE(handshaker);
      // Note split handshakes determines 0-RTT support, for both the current
      // handshake and newly-issued tickets, entirely by |handshaker|. There is
      // no need to call |SSL_set_early_data_enabled| on |server|.
      SSL_set_early_data_enabled(handshaker.get(), 1);

      // Set up handshaker ALPS settings.
      SSL_set_alps_use_new_codepoint(handshaker.get(), use_new_alps_codepoint);
      SSL_CTX_set_alpn_select_cb(
          handshaker_ctx.get(),
          [](SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in,
             unsigned in_len, void *arg) -> int {
            return SSL_select_next_proto(const_cast<uint8_t **>(out), out_len,
                                         in, in_len, alpn,
                                         sizeof(alpn)) == OPENSSL_NPN_NEGOTIATED
                       ? SSL_TLSEXT_ERR_OK
                       : SSL_TLSEXT_ERR_NOACK;
          },
          nullptr);
      ASSERT_TRUE(SSL_add_application_settings(
          handshaker.get(), proto, sizeof(proto), alps, sizeof(alps)));

      ASSERT_TRUE(SSL_apply_handoff(handshaker.get(), handoff));

      MoveBIOs(handshaker.get(), server.get());

      int handshake_ret = SSL_do_handshake(handshaker.get());
      int handshake_err = SSL_get_error(handshaker.get(), handshake_ret);
      ASSERT_EQ(handshake_err, SSL_ERROR_HANDBACK);

      // Double-check that additional calls to |SSL_do_handshake| continue
      // to get |SSL_ERROR_HANDBACK|.
      handshake_ret = SSL_do_handshake(handshaker.get());
      handshake_err = SSL_get_error(handshaker.get(), handshake_ret);
      ASSERT_EQ(handshake_err, SSL_ERROR_HANDBACK);

      ScopedCBB cbb_handback;
      Array<uint8_t> handback;
      ASSERT_TRUE(CBB_init(cbb_handback.get(), 1024));
      ASSERT_TRUE(SSL_serialize_handback(handshaker.get(), cbb_handback.get()));
      ASSERT_TRUE(CBBFinishArray(cbb_handback.get(), &handback));

      bssl::UniquePtr<SSL> server2(SSL_new(server_ctx.get()));
      ASSERT_TRUE(server2);
      ASSERT_TRUE(SSL_apply_handback(server2.get(), handback));

      MoveBIOs(server2.get(), handshaker.get());
      ASSERT_TRUE(CompleteHandshakes(client.get(), server2.get()));
      EXPECT_EQ(is_resume, SSL_session_reused(client.get()));
      // Verify application settings.
      ASSERT_TRUE(SSL_has_application_settings(client.get()));

      if (early_data && is_resume) {
        // In this case, one byte of early data has already been written above.
        EXPECT_TRUE(SSL_early_data_accepted(client.get()));
      } else {
        byte_written = 42;
        EXPECT_EQ(SSL_write(client.get(), &byte_written, 1), 1);
      }
      uint8_t byte;
      EXPECT_EQ(SSL_read(server2.get(), &byte, 1), 1);
      EXPECT_EQ(byte_written, byte);

      byte = 44;
      EXPECT_EQ(SSL_write(server2.get(), &byte, 1), 1);
      EXPECT_EQ(SSL_read(client.get(), &byte, 1), 1);
      EXPECT_EQ(44, byte);
    }
  }
}

TEST(SSLTest, Handoff) {
  for (bool use_new_alps_codepoint : {false, true}) {
    SCOPED_TRACE(use_new_alps_codepoint);
    VerifyHandoff(use_new_alps_codepoint);
  }
}

TEST(SSLTest, HandoffDeclined) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);

  SSL_CTX_set_handoff_mode(server_ctx.get(), true);
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_2_VERSION));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));

  int client_ret = SSL_do_handshake(client.get());
  int client_err = SSL_get_error(client.get(), client_ret);
  ASSERT_EQ(client_err, SSL_ERROR_WANT_READ);

  int server_ret = SSL_do_handshake(server.get());
  int server_err = SSL_get_error(server.get(), server_ret);
  ASSERT_EQ(server_err, SSL_ERROR_HANDOFF);

  ScopedCBB cbb;
  SSL_CLIENT_HELLO hello;
  ASSERT_TRUE(CBB_init(cbb.get(), 256));
  ASSERT_TRUE(SSL_serialize_handoff(server.get(), cbb.get(), &hello));

  ASSERT_TRUE(SSL_decline_handoff(server.get()));

  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  uint8_t byte = 42;
  EXPECT_EQ(SSL_write(client.get(), &byte, 1), 1);
  EXPECT_EQ(SSL_read(server.get(), &byte, 1), 1);
  EXPECT_EQ(42, byte);

  byte = 43;
  EXPECT_EQ(SSL_write(server.get(), &byte, 1), 1);
  EXPECT_EQ(SSL_read(client.get(), &byte, 1), 1);
  EXPECT_EQ(43, byte);
}

static std::string SigAlgsToString(Span<const uint16_t> sigalgs) {
  std::string ret = "{";

  for (uint16_t v : sigalgs) {
    if (ret.size() > 1) {
      ret += ", ";
    }

    char buf[8];
    snprintf(buf, sizeof(buf) - 1, "0x%02x", v);
    buf[sizeof(buf) - 1] = 0;
    ret += std::string(buf);
  }

  ret += "}";
  return ret;
}

void ExpectSigAlgsEqual(Span<const uint16_t> expected,
                        Span<const uint16_t> actual) {
  bool matches = false;
  if (expected.size() == actual.size()) {
    matches = true;

    for (size_t i = 0; i < expected.size(); i++) {
      if (expected[i] != actual[i]) {
        matches = false;
        break;
      }
    }
  }

  if (!matches) {
    ADD_FAILURE() << "expected: " << SigAlgsToString(expected)
                  << " got: " << SigAlgsToString(actual);
  }
}

TEST(SSLTest, SigAlgs) {
  static const struct {
    std::vector<int> input;
    bool ok;
    std::vector<uint16_t> expected;
  } kTests[] = {
      {{}, true, {}},
      {{1}, false, {}},
      {{1, 2, 3}, false, {}},
      {{NID_sha256, EVP_PKEY_ED25519}, false, {}},
      {{NID_sha256, EVP_PKEY_RSA, NID_sha256, EVP_PKEY_RSA}, false, {}},

      {{NID_sha256, EVP_PKEY_RSA}, true, {SSL_SIGN_RSA_PKCS1_SHA256}},
      {{NID_sha512, EVP_PKEY_RSA}, true, {SSL_SIGN_RSA_PKCS1_SHA512}},
      {{NID_sha256, EVP_PKEY_RSA_PSS}, true, {SSL_SIGN_RSA_PSS_RSAE_SHA256}},
      {{NID_undef, EVP_PKEY_ED25519}, true, {SSL_SIGN_ED25519}},
      {{NID_undef, EVP_PKEY_ED25519, NID_sha384, EVP_PKEY_EC},
       true,
       {SSL_SIGN_ED25519, SSL_SIGN_ECDSA_SECP384R1_SHA384}},
  };

  UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  unsigned n = 1;
  for (const auto &test : kTests) {
    SCOPED_TRACE(n++);

    const bool ok =
        SSL_CTX_set1_sigalgs(ctx.get(), test.input.data(), test.input.size());
    EXPECT_EQ(ok, test.ok);

    if (!ok) {
      ERR_clear_error();
    }

    if (!test.ok) {
      continue;
    }

    ExpectSigAlgsEqual(test.expected, ctx->cert->legacy_credential->sigalgs);
  }
}

TEST(SSLTest, SigAlgsList) {
  static const struct {
    const char *input;
    bool ok;
    std::vector<uint16_t> expected;
  } kTests[] = {
      {"", false, {}},
      {":", false, {}},
      {"+", false, {}},
      {"RSA", false, {}},
      {"RSA+", false, {}},
      {"RSA+SHA256:", false, {}},
      {":RSA+SHA256:", false, {}},
      {":RSA+SHA256+:", false, {}},
      {"!", false, {}},
      {"\x01", false, {}},
      {"RSA+SHA256:RSA+SHA384:RSA+SHA256", false, {}},
      {"RSA-PSS+SHA256:rsa_pss_rsae_sha256", false, {}},

      {"RSA+SHA256", true, {SSL_SIGN_RSA_PKCS1_SHA256}},
      {"RSA+SHA256:ed25519",
       true,
       {SSL_SIGN_RSA_PKCS1_SHA256, SSL_SIGN_ED25519}},
      {"ECDSA+SHA256:RSA+SHA512",
       true,
       {SSL_SIGN_ECDSA_SECP256R1_SHA256, SSL_SIGN_RSA_PKCS1_SHA512}},
      {"ecdsa_secp256r1_sha256:rsa_pss_rsae_sha256",
       true,
       {SSL_SIGN_ECDSA_SECP256R1_SHA256, SSL_SIGN_RSA_PSS_RSAE_SHA256}},
      {"RSA-PSS+SHA256", true, {SSL_SIGN_RSA_PSS_RSAE_SHA256}},
      {"PSS+SHA256", true, {SSL_SIGN_RSA_PSS_RSAE_SHA256}},
  };

  UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  unsigned n = 1;
  for (const auto &test : kTests) {
    SCOPED_TRACE(n++);

    const bool ok = SSL_CTX_set1_sigalgs_list(ctx.get(), test.input);
    EXPECT_EQ(ok, test.ok);

    if (!ok) {
      if (test.ok) {
        ERR_print_errors_fp(stderr);
      }
      ERR_clear_error();
    }

    if (!test.ok) {
      continue;
    }

    ExpectSigAlgsEqual(test.expected, ctx->cert->legacy_credential->sigalgs);
  }
}

TEST(SSLTest, ApplyHandoffRemovesUnsupportedCiphers) {
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL> server(SSL_new(server_ctx.get()));
  ASSERT_TRUE(server);

  // handoff is a handoff message that has been artificially modified to pretend
  // that only TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256 (0xc02f) is supported. When
  // it is applied to |server|, all ciphers but that one should be removed.
  //
  // To make a new one of these, try sticking this in the |Handoff| test above:
  //
  // hexdump(stderr, "", handoff.data(), handoff.size());
  // sed -e 's/\(..\)/0x\1, /g'
  //
  // and modify serialize_features() to emit only cipher 0x0A.

  uint8_t handoff[] = {
      0x30, 0x81, 0x9a, 0x02, 0x01, 0x00, 0x04, 0x00, 0x04, 0x81, 0x82, 0x01,
      0x00, 0x00, 0x7e, 0x03, 0x03, 0x30, 0x8e, 0x8f, 0x79, 0xd2, 0x87, 0x39,
      0xc2, 0x23, 0x23, 0x13, 0xca, 0x3c, 0x80, 0x44, 0xfd, 0x80, 0x83, 0x62,
      0x3c, 0xcc, 0xf8, 0x76, 0xd3, 0x62, 0xbb, 0x54, 0xe3, 0xc4, 0x39, 0x24,
      0xa5, 0x00, 0x00, 0x1e, 0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30,
      0xcc, 0xa9, 0xcc, 0xa8, 0xc0, 0x09, 0xc0, 0x13, 0xc0, 0x0a, 0xc0, 0x14,
      0x00, 0x9c, 0x00, 0x9d, 0x00, 0x2f, 0x00, 0x35, 0x00, 0x0a, 0x01, 0x00,
      0x00, 0x37, 0x00, 0x17, 0x00, 0x00, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x0a, 0x00, 0x08, 0x00, 0x06, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18, 0x00,
      0x0b, 0x00, 0x02, 0x01, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00, 0x0d, 0x00,
      0x14, 0x00, 0x12, 0x04, 0x03, 0x08, 0x04, 0x04, 0x01, 0x05, 0x03, 0x08,
      0x05, 0x05, 0x01, 0x08, 0x06, 0x06, 0x01, 0x02, 0x01, 0x04, 0x02, 0xc0,
      0x2f, 0x04, 0x0a, 0x00, 0x15, 0x00, 0x17, 0x00, 0x18, 0x00, 0x19, 0x00,
      0x1d,
  };

  EXPECT_LT(1u, sk_SSL_CIPHER_num(SSL_get_ciphers(server.get())));
  ASSERT_TRUE(SSL_apply_handoff(server.get(), handoff));
  EXPECT_EQ(1u, sk_SSL_CIPHER_num(SSL_get_ciphers(server.get())));
}

TEST(SSLTest, ApplyHandoffRemovesUnsupportedCurves) {
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL> server(SSL_new(server_ctx.get()));
  ASSERT_TRUE(server);

  // handoff is a handoff message that has been artificially modified to pretend
  // that only one ECDH group is supported.  When it is applied to |server|, all
  // groups but that one should be removed.
  //
  // See |ApplyHandoffRemovesUnsupportedCiphers| for how to make a new one of
  // these.
  uint8_t handoff[] = {
      0x30, 0x81, 0xc0, 0x02, 0x01, 0x00, 0x04, 0x00, 0x04, 0x81, 0x82, 0x01,
      0x00, 0x00, 0x7e, 0x03, 0x03, 0x98, 0x30, 0xce, 0xd9, 0xb0, 0xdf, 0x5f,
      0x82, 0x05, 0x4a, 0x43, 0x67, 0x7e, 0xdb, 0x6a, 0x4f, 0x21, 0x18, 0x4e,
      0x0d, 0x94, 0x63, 0x18, 0x8b, 0x54, 0x89, 0xdb, 0x8b, 0x1d, 0x84, 0xbc,
      0x09, 0x00, 0x00, 0x1e, 0xc0, 0x2b, 0xc0, 0x2f, 0xc0, 0x2c, 0xc0, 0x30,
      0xcc, 0xa9, 0xcc, 0xa8, 0xc0, 0x09, 0xc0, 0x13, 0xc0, 0x0a, 0xc0, 0x14,
      0x00, 0x9c, 0x00, 0x9d, 0x00, 0x2f, 0x00, 0x35, 0x00, 0x0a, 0x01, 0x00,
      0x00, 0x37, 0x00, 0x17, 0x00, 0x00, 0xff, 0x01, 0x00, 0x01, 0x00, 0x00,
      0x0a, 0x00, 0x08, 0x00, 0x06, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18, 0x00,
      0x0b, 0x00, 0x02, 0x01, 0x00, 0x00, 0x23, 0x00, 0x00, 0x00, 0x0d, 0x00,
      0x14, 0x00, 0x12, 0x04, 0x03, 0x08, 0x04, 0x04, 0x01, 0x05, 0x03, 0x08,
      0x05, 0x05, 0x01, 0x08, 0x06, 0x06, 0x01, 0x02, 0x01, 0x04, 0x30, 0x00,
      0x02, 0x00, 0x0a, 0x00, 0x2f, 0x00, 0x35, 0x00, 0x8c, 0x00, 0x8d, 0x00,
      0x9c, 0x00, 0x9d, 0x13, 0x01, 0x13, 0x02, 0x13, 0x03, 0xc0, 0x09, 0xc0,
      0x0a, 0xc0, 0x13, 0xc0, 0x14, 0xc0, 0x2b, 0xc0, 0x2c, 0xc0, 0x2f, 0xc0,
      0x30, 0xc0, 0x35, 0xc0, 0x36, 0xcc, 0xa8, 0xcc, 0xa9, 0xcc, 0xac, 0x04,
      0x02, 0x00, 0x17,
  };

  // The default list of groups is used before applying the handoff.
  EXPECT_THAT(server->config->supported_group_list,
              ElementsAreArray({SSL_GROUP_X25519, SSL_GROUP_SECP256R1,
                                SSL_GROUP_SECP384R1}));
  ASSERT_TRUE(SSL_apply_handoff(server.get(), handoff));
  EXPECT_EQ(1u, server->config->supported_group_list.size());
  EXPECT_EQ(SSL_GROUP_SECP256R1, server->config->supported_group_list[0]);
}

TEST(SSLTest, ZeroSizedWiteFlushesHandshakeMessages) {
  // If there are pending handshake messages, an |SSL_write| of zero bytes
  // should flush them.
  bssl::UniquePtr<SSL_CTX> server_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(server_ctx);
  EXPECT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_3_VERSION));
  EXPECT_TRUE(SSL_CTX_set_min_proto_version(server_ctx.get(), TLS1_3_VERSION));

  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);
  EXPECT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), TLS1_3_VERSION));
  EXPECT_TRUE(SSL_CTX_set_min_proto_version(client_ctx.get(), TLS1_3_VERSION));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));

  BIO *client_wbio = SSL_get_wbio(client.get());
  EXPECT_EQ(0u, BIO_wpending(client_wbio));
  EXPECT_TRUE(SSL_key_update(client.get(), SSL_KEY_UPDATE_NOT_REQUESTED));
  EXPECT_EQ(0u, BIO_wpending(client_wbio));
  EXPECT_EQ(0, SSL_write(client.get(), nullptr, 0));
  EXPECT_NE(0u, BIO_wpending(client_wbio));
}

TEST_P(SSLVersionTest, VerifyBeforeCertRequest) {
  // Configure the server to request client certificates.
  SSL_CTX_set_custom_verify(
      server_ctx_.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) { return ssl_verify_ok; });

  // Configure the client to reject the server certificate.
  SSL_CTX_set_custom_verify(
      client_ctx_.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) { return ssl_verify_invalid; });

  // cert_cb should not be called. Verification should fail first.
  SSL_CTX_set_cert_cb(
      client_ctx_.get(),
      [](SSL *ssl, void *arg) {
        ADD_FAILURE() << "cert_cb unexpectedly called";
        return 0;
      },
      nullptr);

  bssl::UniquePtr<SSL> client, server;
  EXPECT_FALSE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                      server_ctx_.get()));
}

// Test that ticket-based sessions on the client get fake session IDs.
TEST_P(SSLVersionTest, FakeIDsForTickets) {
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);

  EXPECT_TRUE(SSL_SESSION_has_ticket(session.get()));
  unsigned session_id_length;
  SSL_SESSION_get_id(session.get(), &session_id_length);
  EXPECT_NE(session_id_length, 0u);
}

// These tests test multi-threaded behavior. They are intended to run with
// ThreadSanitizer.
#if defined(OPENSSL_THREADS)
TEST_P(SSLVersionTest, SessionCacheThreads) {
  SSL_CTX_set_options(server_ctx_.get(), SSL_OP_NO_TICKET);
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

  if (is_tls13()) {
    // Our TLS 1.3 implementation does not support stateful resumption.
    ASSERT_FALSE(CreateClientSession(client_ctx_.get(), server_ctx_.get()));
    return;
  }

  // Establish two client sessions to test with.
  bssl::UniquePtr<SSL_SESSION> session1 =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session1);
  bssl::UniquePtr<SSL_SESSION> session2 =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session2);

  auto connect_with_session = [&](SSL_SESSION *session) {
    ClientConfig config;
    config.session = session;
    UniquePtr<SSL> client, server;
    ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                       server_ctx_.get(), config));
  };

  // Resume sessions in parallel with establishing new ones.
  {
    std::vector<std::thread> threads;
    threads.emplace_back([&] { connect_with_session(nullptr); });
    threads.emplace_back([&] { connect_with_session(nullptr); });
    threads.emplace_back([&] { connect_with_session(session1.get()); });
    threads.emplace_back([&] { connect_with_session(session1.get()); });
    threads.emplace_back([&] { connect_with_session(session2.get()); });
    threads.emplace_back([&] { connect_with_session(session2.get()); });
    for (auto &thread : threads) {
      thread.join();
    }
  }

  // Hit the maximum session cache size across multiple threads, to test the
  // size enforcement logic.
  size_t limit = SSL_CTX_sess_number(server_ctx_.get()) + 2;
  SSL_CTX_sess_set_cache_size(server_ctx_.get(), limit);
  {
    std::vector<std::thread> threads;
    for (int i = 0; i < 4; i++) {
      threads.emplace_back([&]() {
        connect_with_session(nullptr);
        EXPECT_LE(SSL_CTX_sess_number(server_ctx_.get()), limit);
      });
    }
    for (auto &thread : threads) {
      thread.join();
    }
    EXPECT_EQ(SSL_CTX_sess_number(server_ctx_.get()), limit);
  }

  // Reset the session cache, this time with a mock clock.
  ASSERT_NO_FATAL_FAILURE(ResetContexts());
  SSL_CTX_set_options(server_ctx_.get(), SSL_OP_NO_TICKET);
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_current_time_cb(server_ctx_.get(), CurrentTimeCallback);

  // Make some sessions at an arbitrary start time. Then expire them.
  g_current_time.tv_sec = 1000;
  bssl::UniquePtr<SSL_SESSION> expired_session1 =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(expired_session1);
  bssl::UniquePtr<SSL_SESSION> expired_session2 =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(expired_session2);
  g_current_time.tv_sec += 100 * SSL_DEFAULT_SESSION_TIMEOUT;

  session1 = CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session1);

  // Every 256 connections, we flush stale sessions from the session cache. Test
  // this logic is correctly synchronized with other connection attempts.
  static const int kNumConnections = 256;
  {
    std::vector<std::thread> threads;
    threads.emplace_back([&] {
      for (int i = 0; i < kNumConnections; i++) {
        connect_with_session(nullptr);
      }
    });
    threads.emplace_back([&] {
      for (int i = 0; i < kNumConnections; i++) {
        connect_with_session(nullptr);
      }
    });
    threads.emplace_back([&] {
      // Never connect with |expired_session2|. The session cache eagerly
      // removes expired sessions when it sees them. Leaving |expired_session2|
      // untouched ensures it is instead cleared by periodic flushing.
      for (int i = 0; i < kNumConnections; i++) {
        connect_with_session(expired_session1.get());
      }
    });
    threads.emplace_back([&] {
      for (int i = 0; i < kNumConnections; i++) {
        connect_with_session(session1.get());
      }
    });
    for (auto &thread : threads) {
      thread.join();
    }
  }
}

TEST_P(SSLVersionTest, SessionTicketThreads) {
  for (bool renew_ticket : {false, true}) {
    SCOPED_TRACE(renew_ticket);
    ASSERT_NO_FATAL_FAILURE(ResetContexts());
    SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
    SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);
    if (renew_ticket) {
      SSL_CTX_set_tlsext_ticket_key_cb(server_ctx_.get(), RenewTicketCallback);
    }

    // Establish two client sessions to test with.
    bssl::UniquePtr<SSL_SESSION> session1 =
        CreateClientSession(client_ctx_.get(), server_ctx_.get());
    ASSERT_TRUE(session1);
    bssl::UniquePtr<SSL_SESSION> session2 =
        CreateClientSession(client_ctx_.get(), server_ctx_.get());
    ASSERT_TRUE(session2);

    auto connect_with_session = [&](SSL_SESSION *session) {
      ClientConfig config;
      config.session = session;
      UniquePtr<SSL> client, server;
      ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                         server_ctx_.get(), config));
    };

    // Resume sessions in parallel with establishing new ones.
    {
      std::vector<std::thread> threads;
      threads.emplace_back([&] { connect_with_session(nullptr); });
      threads.emplace_back([&] { connect_with_session(nullptr); });
      threads.emplace_back([&] { connect_with_session(session1.get()); });
      threads.emplace_back([&] { connect_with_session(session1.get()); });
      threads.emplace_back([&] { connect_with_session(session2.get()); });
      threads.emplace_back([&] { connect_with_session(session2.get()); });
      for (auto &thread : threads) {
        thread.join();
      }
    }
  }
}

// SSL_CTX_get0_certificate needs to lock internally. Test this works.
TEST(SSLTest, GetCertificateThreads) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  ASSERT_TRUE(cert);
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), cert.get()));

  // Existing code expects |SSL_CTX_get0_certificate| to be callable from two
  // threads concurrently. It originally was an immutable operation. Now we
  // implement it with a thread-safe cache, so it is worth testing.
  X509 *cert2_thread;
  std::thread thread(
      [&] { cert2_thread = SSL_CTX_get0_certificate(ctx.get()); });
  X509 *cert2 = SSL_CTX_get0_certificate(ctx.get());
  thread.join();

  ASSERT_TRUE(cert2);
  ASSERT_TRUE(cert2_thread);
  EXPECT_EQ(cert2, cert2_thread);
  EXPECT_EQ(0, X509_cmp(cert.get(), cert2));
}

// Functions which access properties on the negotiated session are thread-safe
// where needed. Prior to TLS 1.3, clients resuming sessions and servers
// performing stateful resumption will share an underlying SSL_SESSION object,
// potentially across threads.
TEST_P(SSLVersionTest, SessionPropertiesThreads) {
  if (is_tls13()) {
    // Our TLS 1.3 implementation does not support stateful resumption.
    ASSERT_FALSE(CreateClientSession(client_ctx_.get(), server_ctx_.get()));
    return;
  }

  SSL_CTX_set_options(server_ctx_.get(), SSL_OP_NO_TICKET);
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

  ASSERT_TRUE(UseCertAndKey(client_ctx_.get()));
  ASSERT_TRUE(UseCertAndKey(server_ctx_.get()));

  // Configure mutual authentication, so we have more session state.
  SSL_CTX_set_custom_verify(
      client_ctx_.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) { return ssl_verify_ok; });
  SSL_CTX_set_custom_verify(
      server_ctx_.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) { return ssl_verify_ok; });

  // Establish a client session to test with.
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);

  // Resume with it twice.
  UniquePtr<SSL> ssls[4];
  ClientConfig config;
  config.session = session.get();
  ASSERT_TRUE(ConnectClientAndServer(&ssls[0], &ssls[1], client_ctx_.get(),
                                     server_ctx_.get(), config));
  ASSERT_TRUE(ConnectClientAndServer(&ssls[2], &ssls[3], client_ctx_.get(),
                                     server_ctx_.get(), config));

  // Read properties in parallel.
  auto read_properties = [](const SSL *ssl) {
    EXPECT_TRUE(SSL_get_peer_cert_chain(ssl));
    bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(ssl));
    EXPECT_TRUE(peer);
    EXPECT_TRUE(SSL_get_current_cipher(ssl));
    EXPECT_TRUE(SSL_get_group_id(ssl));
  };

  std::vector<std::thread> threads;
  for (const auto &ssl_ptr : ssls) {
    const SSL *ssl = ssl_ptr.get();
    threads.emplace_back([=] { read_properties(ssl); });
  }
  for (auto &thread : threads) {
    thread.join();
  }
}

static void SetValueOnFree(void *parent, void *ptr, CRYPTO_EX_DATA *ad,
                           int index, long argl, void *argp) {
  if (ptr != nullptr) {
    *static_cast<long *>(ptr) = argl;
  }
}

// Test that one thread can register ex_data while another thread is destroying
// an object that uses it.
TEST(SSLTest, ExDataThreads) {
  static bool already_run = false;
  if (already_run) {
    GTEST_SKIP() << "This test consumes process-global resources and can only "
                    "be run once in a process. It is not compatible with "
                    "--gtest_repeat.";
  }
  already_run = true;

  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  // Register an initial index, so the threads can exercise having any ex_data.
  int first_index =
      SSL_get_ex_new_index(-1, nullptr, nullptr, nullptr, SetValueOnFree);
  ASSERT_GE(first_index, 0);

  // Callers may register indices concurrently with using other indices. This
  // may happen if one part of an application is initializing while another part
  // is already running.
  static constexpr int kNumIndices = 3;
  static constexpr int kNumSSLs = 10;
  int index[kNumIndices];
  long values[kNumSSLs];
  std::fill(std::begin(values), std::end(values), -2);
  std::vector<std::thread> threads;
  for (size_t i = 0; i < kNumIndices; i++) {
    threads.emplace_back([&, i] {
      index[i] = SSL_get_ex_new_index(static_cast<long>(i), nullptr, nullptr,
                                      nullptr, SetValueOnFree);
      ASSERT_GE(index[i], 0);
    });
  }
  for (size_t i = 0; i < kNumSSLs; i++) {
    threads.emplace_back([&, i] {
      bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
      ASSERT_TRUE(ssl);
      ASSERT_TRUE(SSL_set_ex_data(ssl.get(), first_index, &values[i]));
    });
  }
  for (auto &thread : threads) {
    thread.join();
  }

  // Each of the SSL threads should have set their flag via ex_data.
  for (size_t i = 0; i < kNumSSLs; i++) {
    EXPECT_EQ(values[i], -1);
  }

  // Each of the newly-registered indices should be distinct and work correctly.
  static_assert(kNumIndices <= kNumSSLs, "values buffer too small");
  std::fill(std::begin(values), std::end(values), -2);
  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl);
  for (size_t i = 0; i < kNumIndices; i++) {
    for (size_t j = 0; j < i; j++) {
      EXPECT_NE(index[i], index[j]);
    }
    ASSERT_TRUE(SSL_set_ex_data(ssl.get(), index[i], &values[i]));
  }
  ssl = nullptr;
  for (size_t i = 0; i < kNumIndices; i++) {
    EXPECT_EQ(values[i], static_cast<long>(i));
  }
}
#endif  // OPENSSL_THREADS

constexpr size_t kNumQUICLevels = 4;
static_assert(ssl_encryption_initial < kNumQUICLevels,
              "kNumQUICLevels is wrong");
static_assert(ssl_encryption_early_data < kNumQUICLevels,
              "kNumQUICLevels is wrong");
static_assert(ssl_encryption_handshake < kNumQUICLevels,
              "kNumQUICLevels is wrong");
static_assert(ssl_encryption_application < kNumQUICLevels,
              "kNumQUICLevels is wrong");

const char *LevelToString(ssl_encryption_level_t level) {
  switch (level) {
    case ssl_encryption_initial:
      return "initial";
    case ssl_encryption_early_data:
      return "early data";
    case ssl_encryption_handshake:
      return "handshake";
    case ssl_encryption_application:
      return "application";
  }
  return "<unknown>";
}

class MockQUICTransport {
 public:
  enum class Role { kClient, kServer };

  explicit MockQUICTransport(Role role) : role_(role) {
    // The caller is expected to configure initial secrets.
    levels_[ssl_encryption_initial].write_secret = {1};
    levels_[ssl_encryption_initial].read_secret = {1};
  }

  void set_peer(MockQUICTransport *peer) { peer_ = peer; }

  bool has_alert() const { return has_alert_; }
  ssl_encryption_level_t alert_level() const { return alert_level_; }
  uint8_t alert() const { return alert_; }

  bool PeerSecretsMatch(ssl_encryption_level_t level) const {
    return levels_[level].write_secret == peer_->levels_[level].read_secret &&
           levels_[level].read_secret == peer_->levels_[level].write_secret &&
           levels_[level].cipher == peer_->levels_[level].cipher;
  }

  bool HasReadSecret(ssl_encryption_level_t level) const {
    return !levels_[level].read_secret.empty();
  }

  bool HasWriteSecret(ssl_encryption_level_t level) const {
    return !levels_[level].write_secret.empty();
  }

  void AllowOutOfOrderWrites() { allow_out_of_order_writes_ = true; }

  bool SetReadSecret(ssl_encryption_level_t level, const SSL_CIPHER *cipher,
                     Span<const uint8_t> secret) {
    if (HasReadSecret(level)) {
      ADD_FAILURE() << LevelToString(level) << " read secret configured twice";
      return false;
    }

    if (role_ == Role::kClient && level == ssl_encryption_early_data) {
      ADD_FAILURE() << "Unexpected early data read secret";
      return false;
    }

    ssl_encryption_level_t ack_level =
        level == ssl_encryption_early_data ? ssl_encryption_application : level;
    if (!HasWriteSecret(ack_level)) {
      ADD_FAILURE() << LevelToString(level)
                    << " read secret configured before ACK write secret";
      return false;
    }

    if (cipher == nullptr) {
      ADD_FAILURE() << "Unexpected null cipher";
      return false;
    }

    if (level != ssl_encryption_early_data &&
        SSL_CIPHER_get_protocol_id(cipher) != levels_[level].cipher) {
      ADD_FAILURE() << "Cipher suite inconsistent";
      return false;
    }

    levels_[level].read_secret.assign(secret.begin(), secret.end());
    levels_[level].cipher = SSL_CIPHER_get_protocol_id(cipher);
    return true;
  }

  bool SetWriteSecret(ssl_encryption_level_t level, const SSL_CIPHER *cipher,
                      Span<const uint8_t> secret) {
    if (HasWriteSecret(level)) {
      ADD_FAILURE() << LevelToString(level) << " write secret configured twice";
      return false;
    }

    if (role_ == Role::kServer && level == ssl_encryption_early_data) {
      ADD_FAILURE() << "Unexpected early data write secret";
      return false;
    }

    if (cipher == nullptr) {
      ADD_FAILURE() << "Unexpected null cipher";
      return false;
    }

    levels_[level].write_secret.assign(secret.begin(), secret.end());
    levels_[level].cipher = SSL_CIPHER_get_protocol_id(cipher);
    return true;
  }

  bool WriteHandshakeData(ssl_encryption_level_t level,
                          Span<const uint8_t> data) {
    if (levels_[level].write_secret.empty()) {
      ADD_FAILURE() << LevelToString(level)
                    << " write secret not yet configured";
      return false;
    }

    // Although the levels are conceptually separate, BoringSSL finishes writing
    // data from a previous level before installing keys for the next level.
    if (!allow_out_of_order_writes_) {
      switch (level) {
        case ssl_encryption_early_data:
          ADD_FAILURE() << "unexpected handshake data at early data level";
          return false;
        case ssl_encryption_initial:
          if (!levels_[ssl_encryption_handshake].write_secret.empty()) {
            ADD_FAILURE()
                << LevelToString(level)
                << " handshake data written after handshake keys installed";
            return false;
          }
          [[fallthrough]];
        case ssl_encryption_handshake:
          if (!levels_[ssl_encryption_application].write_secret.empty()) {
            ADD_FAILURE()
                << LevelToString(level)
                << " handshake data written after application keys installed";
            return false;
          }
          [[fallthrough]];
        case ssl_encryption_application:
          break;
      }
    }

    levels_[level].write_data.insert(levels_[level].write_data.end(),
                                     data.begin(), data.end());
    return true;
  }

  bool SendAlert(ssl_encryption_level_t level, uint8_t alert_value) {
    if (has_alert_) {
      ADD_FAILURE() << "duplicate alert sent";
      return false;
    }

    if (levels_[level].write_secret.empty()) {
      ADD_FAILURE() << LevelToString(level)
                    << " write secret not yet configured";
      return false;
    }

    has_alert_ = true;
    alert_level_ = level;
    alert_ = alert_value;
    return true;
  }

  bool ReadHandshakeData(std::vector<uint8_t> *out,
                         ssl_encryption_level_t level,
                         size_t num = std::numeric_limits<size_t>::max()) {
    if (levels_[level].read_secret.empty()) {
      ADD_FAILURE() << "data read before keys configured in level " << level;
      return false;
    }
    // The peer may not have configured any keys yet.
    if (peer_->levels_[level].write_secret.empty()) {
      out->clear();
      return true;
    }
    // Check the peer computed the same key.
    if (peer_->levels_[level].write_secret != levels_[level].read_secret) {
      ADD_FAILURE() << "peer write key does not match read key in level "
                    << level;
      return false;
    }
    if (peer_->levels_[level].cipher != levels_[level].cipher) {
      ADD_FAILURE() << "peer cipher does not match in level " << level;
      return false;
    }
    std::vector<uint8_t> *peer_data = &peer_->levels_[level].write_data;
    num = std::min(num, peer_data->size());
    out->assign(peer_data->begin(), peer_data->begin() + num);
    peer_data->erase(peer_data->begin(), peer_data->begin() + num);
    return true;
  }

 private:
  Role role_;
  MockQUICTransport *peer_ = nullptr;

  bool allow_out_of_order_writes_ = false;
  bool has_alert_ = false;
  ssl_encryption_level_t alert_level_ = ssl_encryption_initial;
  uint8_t alert_ = 0;

  struct Level {
    std::vector<uint8_t> write_data;
    std::vector<uint8_t> write_secret;
    std::vector<uint8_t> read_secret;
    uint16_t cipher = 0;
  };
  Level levels_[kNumQUICLevels];
};

class MockQUICTransportPair {
 public:
  MockQUICTransportPair()
      : client_(MockQUICTransport::Role::kClient),
        server_(MockQUICTransport::Role::kServer) {
    client_.set_peer(&server_);
    server_.set_peer(&client_);
  }

  ~MockQUICTransportPair() {
    client_.set_peer(nullptr);
    server_.set_peer(nullptr);
  }

  MockQUICTransport *client() { return &client_; }
  MockQUICTransport *server() { return &server_; }

  bool SecretsMatch(ssl_encryption_level_t level) const {
    // We only need to check |HasReadSecret| and |HasWriteSecret| on |client_|.
    // |PeerSecretsMatch| checks that |server_| is analogously configured.
    return client_.PeerSecretsMatch(level) && client_.HasWriteSecret(level) &&
           (level == ssl_encryption_early_data || client_.HasReadSecret(level));
  }

 private:
  MockQUICTransport client_;
  MockQUICTransport server_;
};

class QUICMethodTest : public testing::Test {
 protected:
  void SetUp() override {
    client_ctx_.reset(SSL_CTX_new(TLS_method()));
    server_ctx_ = CreateContextWithTestCertificate(TLS_method());
    ASSERT_TRUE(client_ctx_);
    ASSERT_TRUE(server_ctx_);

    SSL_CTX_set_min_proto_version(server_ctx_.get(), TLS1_3_VERSION);
    SSL_CTX_set_max_proto_version(server_ctx_.get(), TLS1_3_VERSION);
    SSL_CTX_set_min_proto_version(client_ctx_.get(), TLS1_3_VERSION);
    SSL_CTX_set_max_proto_version(client_ctx_.get(), TLS1_3_VERSION);

    static const uint8_t kALPNProtos[] = {0x03, 'f', 'o', 'o'};
    ASSERT_EQ(SSL_CTX_set_alpn_protos(client_ctx_.get(), kALPNProtos,
                                      sizeof(kALPNProtos)),
              0);
    SSL_CTX_set_alpn_select_cb(
        server_ctx_.get(),
        [](SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in,
           unsigned in_len, void *arg) -> int {
          return SSL_select_next_proto(
                     const_cast<uint8_t **>(out), out_len, in, in_len,
                     kALPNProtos, sizeof(kALPNProtos)) == OPENSSL_NPN_NEGOTIATED
                     ? SSL_TLSEXT_ERR_OK
                     : SSL_TLSEXT_ERR_NOACK;
        },
        nullptr);
  }

  static MockQUICTransport *TransportFromSSL(const SSL *ssl) {
    return ex_data_.Get(ssl);
  }

  static bool ProvideHandshakeData(
      SSL *ssl, size_t num = std::numeric_limits<size_t>::max()) {
    MockQUICTransport *transport = TransportFromSSL(ssl);
    ssl_encryption_level_t level = SSL_quic_read_level(ssl);
    std::vector<uint8_t> data;
    return transport->ReadHandshakeData(&data, level, num) &&
           SSL_provide_quic_data(ssl, level, data.data(), data.size());
  }

  void AllowOutOfOrderWrites() { allow_out_of_order_writes_ = true; }

  bool CreateClientAndServer() {
    client_.reset(SSL_new(client_ctx_.get()));
    server_.reset(SSL_new(server_ctx_.get()));
    if (!client_ || !server_) {
      return false;
    }

    SSL_set_connect_state(client_.get());
    SSL_set_accept_state(server_.get());

    transport_ = std::make_unique<MockQUICTransportPair>();
    if (!ex_data_.Set(client_.get(), transport_->client()) ||
        !ex_data_.Set(server_.get(), transport_->server())) {
      return false;
    }
    if (allow_out_of_order_writes_) {
      transport_->client()->AllowOutOfOrderWrites();
      transport_->server()->AllowOutOfOrderWrites();
    }
    static const uint8_t client_transport_params[] = {0};
    if (!SSL_set_quic_transport_params(client_.get(), client_transport_params,
                                       sizeof(client_transport_params)) ||
        !SSL_set_quic_transport_params(server_.get(),
                                       server_transport_params_.data(),
                                       server_transport_params_.size()) ||
        !SSL_set_quic_early_data_context(
            server_.get(), server_quic_early_data_context_.data(),
            server_quic_early_data_context_.size())) {
      return false;
    }
    return true;
  }

  enum class ExpectedError {
    kNoError,
    kClientError,
    kServerError,
  };

  // CompleteHandshakesForQUIC runs |SSL_do_handshake| on |client_| and
  // |server_| until each completes once. It returns true on success and false
  // on failure.
  bool CompleteHandshakesForQUIC() {
    return RunQUICHandshakesAndExpectError(ExpectedError::kNoError);
  }

  // Runs |SSL_do_handshake| on |client_| and |server_| until each completes
  // once. If |expect_client_error| is true, it will return true only if the
  // client handshake failed. Otherwise, it returns true if both handshakes
  // succeed and false otherwise.
  bool RunQUICHandshakesAndExpectError(ExpectedError expected_error) {
    bool client_done = false, server_done = false;
    while (!client_done || !server_done) {
      if (!client_done) {
        if (!ProvideHandshakeData(client_.get())) {
          ADD_FAILURE() << "ProvideHandshakeData(client_) failed";
          return false;
        }
        int client_ret = SSL_do_handshake(client_.get());
        int client_err = SSL_get_error(client_.get(), client_ret);
        if (client_ret == 1) {
          client_done = true;
        } else if (client_ret != -1 || client_err != SSL_ERROR_WANT_READ) {
          if (expected_error == ExpectedError::kClientError) {
            return true;
          }
          ADD_FAILURE() << "Unexpected client output: " << client_ret << " "
                        << client_err;
          return false;
        }
      }

      if (!server_done) {
        if (!ProvideHandshakeData(server_.get())) {
          ADD_FAILURE() << "ProvideHandshakeData(server_) failed";
          return false;
        }
        int server_ret = SSL_do_handshake(server_.get());
        int server_err = SSL_get_error(server_.get(), server_ret);
        if (server_ret == 1) {
          server_done = true;
        } else if (server_ret != -1 || server_err != SSL_ERROR_WANT_READ) {
          if (expected_error == ExpectedError::kServerError) {
            return true;
          }
          ADD_FAILURE() << "Unexpected server output: " << server_ret << " "
                        << server_err;
          return false;
        }
      }
    }
    return expected_error == ExpectedError::kNoError;
  }

  bssl::UniquePtr<SSL_SESSION> CreateClientSessionForQUIC() {
    g_last_session = nullptr;
    SSL_CTX_sess_set_new_cb(client_ctx_.get(), SaveLastSession);
    if (!CreateClientAndServer() || !CompleteHandshakesForQUIC()) {
      return nullptr;
    }

    // The server sent NewSessionTicket messages in the handshake.
    if (!ProvideHandshakeData(client_.get()) ||
        !SSL_process_quic_post_handshake(client_.get())) {
      return nullptr;
    }

    return std::move(g_last_session);
  }

  void ExpectHandshakeSuccess() {
    EXPECT_TRUE(transport_->SecretsMatch(ssl_encryption_application));
    EXPECT_EQ(ssl_encryption_application, SSL_quic_read_level(client_.get()));
    EXPECT_EQ(ssl_encryption_application, SSL_quic_write_level(client_.get()));
    EXPECT_EQ(ssl_encryption_application, SSL_quic_read_level(server_.get()));
    EXPECT_EQ(ssl_encryption_application, SSL_quic_write_level(server_.get()));
    EXPECT_FALSE(transport_->client()->has_alert());
    EXPECT_FALSE(transport_->server()->has_alert());

    // SSL_do_handshake is now idempotent.
    EXPECT_EQ(SSL_do_handshake(client_.get()), 1);
    EXPECT_EQ(SSL_do_handshake(server_.get()), 1);
  }

  // Returns a default SSL_QUIC_METHOD. Individual methods may be overwritten by
  // the test.
  SSL_QUIC_METHOD DefaultQUICMethod() {
    return SSL_QUIC_METHOD{
        SetReadSecretCallback, SetWriteSecretCallback, AddHandshakeDataCallback,
        FlushFlightCallback,   SendAlertCallback,
    };
  }

  static int SetReadSecretCallback(SSL *ssl, ssl_encryption_level_t level,
                                   const SSL_CIPHER *cipher,
                                   const uint8_t *secret, size_t secret_len) {
    return TransportFromSSL(ssl)->SetReadSecret(level, cipher,
                                                Span(secret, secret_len));
  }

  static int SetWriteSecretCallback(SSL *ssl, ssl_encryption_level_t level,
                                    const SSL_CIPHER *cipher,
                                    const uint8_t *secret, size_t secret_len) {
    return TransportFromSSL(ssl)->SetWriteSecret(level, cipher,
                                                 Span(secret, secret_len));
  }

  static int AddHandshakeDataCallback(SSL *ssl,
                                      enum ssl_encryption_level_t level,
                                      const uint8_t *data, size_t len) {
    EXPECT_EQ(level, SSL_quic_write_level(ssl));
    return TransportFromSSL(ssl)->WriteHandshakeData(level, Span(data, len));
  }

  static int FlushFlightCallback(SSL *ssl) { return 1; }

  static int SendAlertCallback(SSL *ssl, ssl_encryption_level_t level,
                               uint8_t alert) {
    EXPECT_EQ(level, SSL_quic_write_level(ssl));
    return TransportFromSSL(ssl)->SendAlert(level, alert);
  }

  bssl::UniquePtr<SSL_CTX> client_ctx_;
  bssl::UniquePtr<SSL_CTX> server_ctx_;

  static UnownedSSLExData<MockQUICTransport> ex_data_;
  std::unique_ptr<MockQUICTransportPair> transport_;

  bssl::UniquePtr<SSL> client_;
  bssl::UniquePtr<SSL> server_;

  std::vector<uint8_t> server_transport_params_ = {1};
  std::vector<uint8_t> server_quic_early_data_context_ = {2};

  bool allow_out_of_order_writes_ = false;
};

UnownedSSLExData<MockQUICTransport> QUICMethodTest::ex_data_;

// Test a full handshake and resumption work.
TEST_F(QUICMethodTest, Basic) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  g_last_session = nullptr;

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_sess_set_new_cb(client_ctx_.get(), SaveLastSession);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  ExpectHandshakeSuccess();
  EXPECT_FALSE(SSL_session_reused(client_.get()));
  EXPECT_FALSE(SSL_session_reused(server_.get()));

  // SSL_get_traffic_secrets is not defined for QUIC.
  Span<const uint8_t> read_secret, write_secret;
  EXPECT_FALSE(
      SSL_get_traffic_secrets(client_.get(), &read_secret, &write_secret));
  EXPECT_FALSE(
      SSL_get_traffic_secrets(server_.get(), &read_secret, &write_secret));

  // The server sent NewSessionTicket messages in the handshake.
  EXPECT_FALSE(g_last_session);
  ASSERT_TRUE(ProvideHandshakeData(client_.get()));
  EXPECT_EQ(SSL_process_quic_post_handshake(client_.get()), 1);
  EXPECT_TRUE(g_last_session);

  // Create a second connection to verify resumption works.
  ASSERT_TRUE(CreateClientAndServer());
  bssl::UniquePtr<SSL_SESSION> session = std::move(g_last_session);
  SSL_set_session(client_.get(), session.get());

  ASSERT_TRUE(CompleteHandshakesForQUIC());

  ExpectHandshakeSuccess();
  EXPECT_TRUE(SSL_session_reused(client_.get()));
  EXPECT_TRUE(SSL_session_reused(server_.get()));
}

// Test that HelloRetryRequest in QUIC works.
TEST_F(QUICMethodTest, HelloRetryRequest) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  // BoringSSL predicts the most preferred ECDH group, so using different
  // preferences will trigger HelloRetryRequest.
  static const int kClientPrefs[] = {NID_X25519, NID_X9_62_prime256v1};
  ASSERT_TRUE(SSL_CTX_set1_groups(client_ctx_.get(), kClientPrefs,
                                  std::size(kClientPrefs)));
  static const int kServerPrefs[] = {NID_X9_62_prime256v1, NID_X25519};
  ASSERT_TRUE(SSL_CTX_set1_groups(server_ctx_.get(), kServerPrefs,
                                  std::size(kServerPrefs)));

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());
  ExpectHandshakeSuccess();
}

// Test that the client does not send a legacy_session_id in the ClientHello.
TEST_F(QUICMethodTest, NoLegacySessionId) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  // Check that the session ID length is 0 in an early callback.
  SSL_CTX_set_select_certificate_cb(
      server_ctx_.get(),
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        EXPECT_EQ(client_hello->session_id_len, 0u);
        return ssl_select_cert_success;
      });

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  ExpectHandshakeSuccess();
}

// Test that, even in a 1-RTT handshake, the server installs keys at the right
// time. Half-RTT keys are available early, but 1-RTT read keys are deferred.
TEST_F(QUICMethodTest, HalfRTTKeys) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());

  // The client sends ClientHello.
  ASSERT_EQ(SSL_do_handshake(client_.get()), -1);
  ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(client_.get(), -1));

  // The server reads ClientHello and sends ServerHello..Finished.
  ASSERT_TRUE(ProvideHandshakeData(server_.get()));
  ASSERT_EQ(SSL_do_handshake(server_.get()), -1);
  ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(server_.get(), -1));

  // At this point, the server has half-RTT write keys, but it cannot access
  // 1-RTT read keys until client Finished.
  EXPECT_TRUE(transport_->server()->HasWriteSecret(ssl_encryption_application));
  EXPECT_FALSE(transport_->server()->HasReadSecret(ssl_encryption_application));

  // Finish up the client and server handshakes.
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  // Both sides can now exchange 1-RTT data.
  ExpectHandshakeSuccess();
}

TEST_F(QUICMethodTest, ZeroRTTAccept) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_early_data_enabled(client_ctx_.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx_.get(), 1);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  bssl::UniquePtr<SSL_SESSION> session = CreateClientSessionForQUIC();
  ASSERT_TRUE(session);

  ASSERT_TRUE(CreateClientAndServer());
  SSL_set_session(client_.get(), session.get());

  // The client handshake should return immediately into the early data state.
  ASSERT_EQ(SSL_do_handshake(client_.get()), 1);
  EXPECT_TRUE(SSL_in_early_data(client_.get()));
  // The transport should have keys for sending 0-RTT data.
  EXPECT_TRUE(transport_->client()->HasWriteSecret(ssl_encryption_early_data));

  // The server will consume the ClientHello and also enter the early data
  // state.
  ASSERT_TRUE(ProvideHandshakeData(server_.get()));
  ASSERT_EQ(SSL_do_handshake(server_.get()), 1);
  EXPECT_TRUE(SSL_in_early_data(server_.get()));
  EXPECT_TRUE(transport_->SecretsMatch(ssl_encryption_early_data));
  // At this point, the server has half-RTT write keys, but it cannot access
  // 1-RTT read keys until client Finished.
  EXPECT_TRUE(transport_->server()->HasWriteSecret(ssl_encryption_application));
  EXPECT_FALSE(transport_->server()->HasReadSecret(ssl_encryption_application));

  // Finish up the client and server handshakes.
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  // Both sides can now exchange 1-RTT data.
  ExpectHandshakeSuccess();
  EXPECT_TRUE(SSL_session_reused(client_.get()));
  EXPECT_TRUE(SSL_session_reused(server_.get()));
  EXPECT_FALSE(SSL_in_early_data(client_.get()));
  EXPECT_FALSE(SSL_in_early_data(server_.get()));
  EXPECT_TRUE(SSL_early_data_accepted(client_.get()));
  EXPECT_TRUE(SSL_early_data_accepted(server_.get()));

  // Finish handling post-handshake messages after the first 0-RTT resumption.
  EXPECT_TRUE(ProvideHandshakeData(client_.get()));
  EXPECT_TRUE(SSL_process_quic_post_handshake(client_.get()));

  // Perform a second 0-RTT resumption attempt, and confirm that 0-RTT is
  // accepted again.
  ASSERT_TRUE(CreateClientAndServer());
  SSL_set_session(client_.get(), g_last_session.get());

  // The client handshake should return immediately into the early data state.
  ASSERT_EQ(SSL_do_handshake(client_.get()), 1);
  EXPECT_TRUE(SSL_in_early_data(client_.get()));
  // The transport should have keys for sending 0-RTT data.
  EXPECT_TRUE(transport_->client()->HasWriteSecret(ssl_encryption_early_data));

  // The server will consume the ClientHello and also enter the early data
  // state.
  ASSERT_TRUE(ProvideHandshakeData(server_.get()));
  ASSERT_EQ(SSL_do_handshake(server_.get()), 1);
  EXPECT_TRUE(SSL_in_early_data(server_.get()));
  EXPECT_TRUE(transport_->SecretsMatch(ssl_encryption_early_data));
  // At this point, the server has half-RTT write keys, but it cannot access
  // 1-RTT read keys until client Finished.
  EXPECT_TRUE(transport_->server()->HasWriteSecret(ssl_encryption_application));
  EXPECT_FALSE(transport_->server()->HasReadSecret(ssl_encryption_application));

  // Finish up the client and server handshakes.
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  // Both sides can now exchange 1-RTT data.
  ExpectHandshakeSuccess();
  EXPECT_TRUE(SSL_session_reused(client_.get()));
  EXPECT_TRUE(SSL_session_reused(server_.get()));
  EXPECT_FALSE(SSL_in_early_data(client_.get()));
  EXPECT_FALSE(SSL_in_early_data(server_.get()));
  EXPECT_TRUE(SSL_early_data_accepted(client_.get()));
  EXPECT_TRUE(SSL_early_data_accepted(server_.get()));
  EXPECT_EQ(SSL_get_early_data_reason(client_.get()), ssl_early_data_accepted);
  EXPECT_EQ(SSL_get_early_data_reason(server_.get()), ssl_early_data_accepted);
}

TEST_F(QUICMethodTest, ZeroRTTRejectMismatchedParameters) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_early_data_enabled(client_ctx_.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx_.get(), 1);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));


  bssl::UniquePtr<SSL_SESSION> session = CreateClientSessionForQUIC();
  ASSERT_TRUE(session);

  ASSERT_TRUE(CreateClientAndServer());
  static const uint8_t new_context[] = {4};
  ASSERT_TRUE(SSL_set_quic_early_data_context(server_.get(), new_context,
                                              sizeof(new_context)));
  SSL_set_session(client_.get(), session.get());

  // The client handshake should return immediately into the early data
  // state.
  ASSERT_EQ(SSL_do_handshake(client_.get()), 1);
  EXPECT_TRUE(SSL_in_early_data(client_.get()));
  // The transport should have keys for sending 0-RTT data.
  EXPECT_TRUE(transport_->client()->HasWriteSecret(ssl_encryption_early_data));

  // The server will consume the ClientHello, but it will not accept 0-RTT.
  ASSERT_TRUE(ProvideHandshakeData(server_.get()));
  ASSERT_EQ(SSL_do_handshake(server_.get()), -1);
  ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(server_.get(), -1));
  EXPECT_FALSE(SSL_in_early_data(server_.get()));
  EXPECT_FALSE(transport_->server()->HasReadSecret(ssl_encryption_early_data));

  // The client consumes the server response and signals 0-RTT rejection.
  for (;;) {
    ASSERT_TRUE(ProvideHandshakeData(client_.get()));
    ASSERT_EQ(-1, SSL_do_handshake(client_.get()));
    int err = SSL_get_error(client_.get(), -1);
    if (err == SSL_ERROR_EARLY_DATA_REJECTED) {
      break;
    }
    ASSERT_EQ(SSL_ERROR_WANT_READ, err);
  }

  // As in TLS over TCP, 0-RTT rejection is sticky.
  ASSERT_EQ(-1, SSL_do_handshake(client_.get()));
  ASSERT_EQ(SSL_ERROR_EARLY_DATA_REJECTED, SSL_get_error(client_.get(), -1));

  // Finish up the client and server handshakes.
  SSL_reset_early_data_reject(client_.get());
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  // Both sides can now exchange 1-RTT data.
  ExpectHandshakeSuccess();
  EXPECT_TRUE(SSL_session_reused(client_.get()));
  EXPECT_TRUE(SSL_session_reused(server_.get()));
  EXPECT_FALSE(SSL_in_early_data(client_.get()));
  EXPECT_FALSE(SSL_in_early_data(server_.get()));
  EXPECT_FALSE(SSL_early_data_accepted(client_.get()));
  EXPECT_FALSE(SSL_early_data_accepted(server_.get()));
}

TEST_F(QUICMethodTest, NoZeroRTTTicketWithoutEarlyDataContext) {
  server_quic_early_data_context_ = {};
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_early_data_enabled(client_ctx_.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx_.get(), 1);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  bssl::UniquePtr<SSL_SESSION> session = CreateClientSessionForQUIC();
  ASSERT_TRUE(session);
  EXPECT_FALSE(SSL_SESSION_early_data_capable(session.get()));
}

TEST_F(QUICMethodTest, ZeroRTTReject) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_early_data_enabled(client_ctx_.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx_.get(), 1);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  bssl::UniquePtr<SSL_SESSION> session = CreateClientSessionForQUIC();
  ASSERT_TRUE(session);

  for (bool reject_hrr : {false, true}) {
    SCOPED_TRACE(reject_hrr);

    ASSERT_TRUE(CreateClientAndServer());
    if (reject_hrr) {
      // Configure the server to prefer P-256, which will reject 0-RTT via
      // HelloRetryRequest.
      int p256 = NID_X9_62_prime256v1;
      ASSERT_TRUE(SSL_set1_groups(server_.get(), &p256, 1));
    } else {
      // Disable 0-RTT on the server, so it will reject it.
      SSL_set_early_data_enabled(server_.get(), 0);
    }
    SSL_set_session(client_.get(), session.get());

    // The client handshake should return immediately into the early data state.
    ASSERT_EQ(SSL_do_handshake(client_.get()), 1);
    EXPECT_TRUE(SSL_in_early_data(client_.get()));
    // The transport should have keys for sending 0-RTT data.
    EXPECT_TRUE(
        transport_->client()->HasWriteSecret(ssl_encryption_early_data));

    // The server will consume the ClientHello, but it will not accept 0-RTT.
    ASSERT_TRUE(ProvideHandshakeData(server_.get()));
    ASSERT_EQ(SSL_do_handshake(server_.get()), -1);
    ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(server_.get(), -1));
    EXPECT_FALSE(SSL_in_early_data(server_.get()));
    EXPECT_FALSE(
        transport_->server()->HasReadSecret(ssl_encryption_early_data));

    // The client consumes the server response and signals 0-RTT rejection.
    for (;;) {
      ASSERT_TRUE(ProvideHandshakeData(client_.get()));
      ASSERT_EQ(-1, SSL_do_handshake(client_.get()));
      int err = SSL_get_error(client_.get(), -1);
      if (err == SSL_ERROR_EARLY_DATA_REJECTED) {
        break;
      }
      ASSERT_EQ(SSL_ERROR_WANT_READ, err);
    }

    // As in TLS over TCP, 0-RTT rejection is sticky.
    ASSERT_EQ(-1, SSL_do_handshake(client_.get()));
    ASSERT_EQ(SSL_ERROR_EARLY_DATA_REJECTED, SSL_get_error(client_.get(), -1));

    // Finish up the client and server handshakes.
    SSL_reset_early_data_reject(client_.get());
    ASSERT_TRUE(CompleteHandshakesForQUIC());

    // Both sides can now exchange 1-RTT data.
    ExpectHandshakeSuccess();
    EXPECT_TRUE(SSL_session_reused(client_.get()));
    EXPECT_TRUE(SSL_session_reused(server_.get()));
    EXPECT_FALSE(SSL_in_early_data(client_.get()));
    EXPECT_FALSE(SSL_in_early_data(server_.get()));
    EXPECT_FALSE(SSL_early_data_accepted(client_.get()));
    EXPECT_FALSE(SSL_early_data_accepted(server_.get()));
  }
}

TEST_F(QUICMethodTest, NoZeroRTTKeysBeforeReverify) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_early_data_enabled(client_ctx_.get(), 1);
  SSL_CTX_set_reverify_on_resume(client_ctx_.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx_.get(), 1);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  bssl::UniquePtr<SSL_SESSION> session = CreateClientSessionForQUIC();
  ASSERT_TRUE(session);

  ASSERT_TRUE(CreateClientAndServer());
  SSL_set_session(client_.get(), session.get());

  // Configure the certificate (re)verification to never complete. The client
  // handshake should pause.
  SSL_set_custom_verify(
      client_.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_retry;
      });
  ASSERT_EQ(SSL_do_handshake(client_.get()), -1);
  ASSERT_EQ(SSL_get_error(client_.get(), -1),
            SSL_ERROR_WANT_CERTIFICATE_VERIFY);

  // The early data keys have not yet been released.
  EXPECT_FALSE(transport_->client()->HasWriteSecret(ssl_encryption_early_data));

  // After the verification completes, the handshake progresses to the 0-RTT
  // point and releases keys.
  SSL_set_custom_verify(
      client_.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_ok;
      });
  ASSERT_EQ(SSL_do_handshake(client_.get()), 1);
  EXPECT_TRUE(SSL_in_early_data(client_.get()));
  EXPECT_TRUE(transport_->client()->HasWriteSecret(ssl_encryption_early_data));
}

// Test only releasing data to QUIC one byte at a time on request, to maximize
// state machine pauses. Additionally, test that existing asynchronous callbacks
// still work.
TEST_F(QUICMethodTest, Async) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());

  // Install an asynchronous certificate callback.
  bool cert_cb_ok = false;
  SSL_set_cert_cb(
      server_.get(),
      [](SSL *, void *arg) -> int {
        return *static_cast<bool *>(arg) ? 1 : -1;
      },
      &cert_cb_ok);

  for (;;) {
    int client_ret = SSL_do_handshake(client_.get());
    if (client_ret != 1) {
      ASSERT_EQ(client_ret, -1);
      ASSERT_EQ(SSL_get_error(client_.get(), client_ret), SSL_ERROR_WANT_READ);
      ASSERT_TRUE(ProvideHandshakeData(client_.get(), 1));
    }

    int server_ret = SSL_do_handshake(server_.get());
    if (server_ret != 1) {
      ASSERT_EQ(server_ret, -1);
      int ssl_err = SSL_get_error(server_.get(), server_ret);
      switch (ssl_err) {
        case SSL_ERROR_WANT_READ:
          ASSERT_TRUE(ProvideHandshakeData(server_.get(), 1));
          break;
        case SSL_ERROR_WANT_X509_LOOKUP:
          ASSERT_FALSE(cert_cb_ok);
          cert_cb_ok = true;
          break;
        default:
          FAIL() << "Unexpected SSL_get_error result: " << ssl_err;
      }
    }

    if (client_ret == 1 && server_ret == 1) {
      break;
    }
  }

  ExpectHandshakeSuccess();
}

// Test buffering write data until explicit flushes.
TEST_F(QUICMethodTest, Buffered) {
  AllowOutOfOrderWrites();

  struct BufferedFlight {
    std::vector<uint8_t> data[kNumQUICLevels];
  };
  static UnownedSSLExData<BufferedFlight> buffered_flights;

  auto add_handshake_data = [](SSL *ssl, enum ssl_encryption_level_t level,
                               const uint8_t *data, size_t len) -> int {
    BufferedFlight *flight = buffered_flights.Get(ssl);
    flight->data[level].insert(flight->data[level].end(), data, data + len);
    return 1;
  };

  auto flush_flight = [](SSL *ssl) -> int {
    BufferedFlight *flight = buffered_flights.Get(ssl);
    for (size_t level = 0; level < kNumQUICLevels; level++) {
      if (!flight->data[level].empty()) {
        if (!TransportFromSSL(ssl)->WriteHandshakeData(
                static_cast<ssl_encryption_level_t>(level),
                flight->data[level])) {
          return 0;
        }
        flight->data[level].clear();
      }
    }
    return 1;
  };

  SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  quic_method.add_handshake_data = add_handshake_data;
  quic_method.flush_flight = flush_flight;

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());

  BufferedFlight client_flight, server_flight;
  ASSERT_TRUE(buffered_flights.Set(client_.get(), &client_flight));
  ASSERT_TRUE(buffered_flights.Set(server_.get(), &server_flight));

  ASSERT_TRUE(CompleteHandshakesForQUIC());

  ExpectHandshakeSuccess();
}

// Test that excess data at one level is rejected. That is, if a single
// |SSL_provide_quic_data| call included both ServerHello and
// EncryptedExtensions in a single chunk, BoringSSL notices and rejects this on
// key change.
TEST_F(QUICMethodTest, ExcessProvidedData) {
  AllowOutOfOrderWrites();

  auto add_handshake_data = [](SSL *ssl, enum ssl_encryption_level_t level,
                               const uint8_t *data, size_t len) -> int {
    // Switch everything to the initial level.
    return TransportFromSSL(ssl)->WriteHandshakeData(ssl_encryption_initial,
                                                     Span(data, len));
  };

  SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  quic_method.add_handshake_data = add_handshake_data;

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());

  // Send the ClientHello and ServerHello through Finished.
  ASSERT_EQ(SSL_do_handshake(client_.get()), -1);
  ASSERT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_READ);
  ASSERT_TRUE(ProvideHandshakeData(server_.get()));
  ASSERT_EQ(SSL_do_handshake(server_.get()), -1);
  ASSERT_EQ(SSL_get_error(server_.get(), -1), SSL_ERROR_WANT_READ);

  // The client is still waiting for the ServerHello at initial
  // encryption.
  ASSERT_EQ(ssl_encryption_initial, SSL_quic_read_level(client_.get()));

  // |add_handshake_data| incorrectly wrote everything at the initial level, so
  // this queues up ServerHello through Finished in one chunk.
  ASSERT_TRUE(ProvideHandshakeData(client_.get()));

  // The client reads ServerHello successfully, but then rejects the buffered
  // EncryptedExtensions on key change.
  ASSERT_EQ(SSL_do_handshake(client_.get()), -1);
  ASSERT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_SSL);
  EXPECT_TRUE(
      ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_EXCESS_HANDSHAKE_DATA));

  // The client sends an alert in response to this. The alert is sent at
  // handshake level because we install write secrets before read secrets and
  // the error is discovered when installing the read secret. (How to send
  // alerts on protocol syntax errors near key changes is ambiguous in general.)
  ASSERT_TRUE(transport_->client()->has_alert());
  EXPECT_EQ(transport_->client()->alert_level(), ssl_encryption_handshake);
  EXPECT_EQ(transport_->client()->alert(), SSL_AD_UNEXPECTED_MESSAGE);

  // Sanity-check handshake secrets. The error is discovered while setting the
  // read secret, so only the write secret has been installed.
  EXPECT_TRUE(transport_->client()->HasWriteSecret(ssl_encryption_handshake));
  EXPECT_FALSE(transport_->client()->HasReadSecret(ssl_encryption_handshake));
}

// Test that |SSL_provide_quic_data| will reject data at the wrong level.
TEST_F(QUICMethodTest, ProvideWrongLevel) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());

  // Send the ClientHello and ServerHello through Finished.
  ASSERT_EQ(SSL_do_handshake(client_.get()), -1);
  ASSERT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_READ);
  ASSERT_TRUE(ProvideHandshakeData(server_.get()));
  ASSERT_EQ(SSL_do_handshake(server_.get()), -1);
  ASSERT_EQ(SSL_get_error(server_.get(), -1), SSL_ERROR_WANT_READ);

  // The client is still waiting for the ServerHello at initial
  // encryption.
  ASSERT_EQ(ssl_encryption_initial, SSL_quic_read_level(client_.get()));

  // Data cannot be provided at the next level.
  std::vector<uint8_t> data;
  ASSERT_TRUE(
      transport_->client()->ReadHandshakeData(&data, ssl_encryption_initial));
  ASSERT_FALSE(SSL_provide_quic_data(client_.get(), ssl_encryption_handshake,
                                     data.data(), data.size()));
  ERR_clear_error();

  // Progress to EncryptedExtensions.
  ASSERT_TRUE(SSL_provide_quic_data(client_.get(), ssl_encryption_initial,
                                    data.data(), data.size()));
  ASSERT_EQ(SSL_do_handshake(client_.get()), -1);
  ASSERT_EQ(SSL_get_error(client_.get(), -1), SSL_ERROR_WANT_READ);
  ASSERT_EQ(ssl_encryption_handshake, SSL_quic_read_level(client_.get()));

  // Data cannot be provided at the previous level.
  ASSERT_TRUE(
      transport_->client()->ReadHandshakeData(&data, ssl_encryption_handshake));
  ASSERT_FALSE(SSL_provide_quic_data(client_.get(), ssl_encryption_initial,
                                     data.data(), data.size()));
}

TEST_F(QUICMethodTest, TooMuchData) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());

  size_t limit =
      SSL_quic_max_handshake_flight_len(client_.get(), ssl_encryption_initial);
  uint8_t b = 0;
  for (size_t i = 0; i < limit; i++) {
    ASSERT_TRUE(
        SSL_provide_quic_data(client_.get(), ssl_encryption_initial, &b, 1));
  }

  EXPECT_FALSE(
      SSL_provide_quic_data(client_.get(), ssl_encryption_initial, &b, 1));
}

// Provide invalid post-handshake data.
TEST_F(QUICMethodTest, BadPostHandshake) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  g_last_session = nullptr;

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_sess_set_new_cb(client_ctx_.get(), SaveLastSession);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  EXPECT_EQ(SSL_do_handshake(client_.get()), 1);
  EXPECT_EQ(SSL_do_handshake(server_.get()), 1);
  EXPECT_TRUE(transport_->SecretsMatch(ssl_encryption_application));
  EXPECT_FALSE(transport_->client()->has_alert());
  EXPECT_FALSE(transport_->server()->has_alert());

  // Junk sent as part of post-handshake data should cause an error.
  uint8_t kJunk[] = {0x17, 0x0, 0x0, 0x4, 0xB, 0xE, 0xE, 0xF};
  ASSERT_TRUE(SSL_provide_quic_data(client_.get(), ssl_encryption_application,
                                    kJunk, sizeof(kJunk)));
  EXPECT_EQ(SSL_process_quic_post_handshake(client_.get()), 0);
}

static void ExpectReceivedTransportParamsEqual(const SSL *ssl,
                                               Span<const uint8_t> expected) {
  const uint8_t *received;
  size_t received_len;
  SSL_get_peer_quic_transport_params(ssl, &received, &received_len);
  ASSERT_EQ(received_len, expected.size());
  EXPECT_EQ(Bytes(received, received_len), Bytes(expected));
}

TEST_F(QUICMethodTest, SetTransportParameters) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  uint8_t kClientParams[] = {1, 2, 3, 4};
  uint8_t kServerParams[] = {5, 6, 7};
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), kClientParams,
                                            sizeof(kClientParams)));
  ASSERT_TRUE(SSL_set_quic_transport_params(server_.get(), kServerParams,
                                            sizeof(kServerParams)));

  ASSERT_TRUE(CompleteHandshakesForQUIC());
  ExpectReceivedTransportParamsEqual(client_.get(), kServerParams);
  ExpectReceivedTransportParamsEqual(server_.get(), kClientParams);
}

TEST_F(QUICMethodTest, SetTransportParamsInCallback) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  uint8_t kClientParams[] = {1, 2, 3, 4};
  static uint8_t kServerParams[] = {5, 6, 7};
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), kClientParams,
                                            sizeof(kClientParams)));
  SSL_CTX_set_tlsext_servername_callback(
      server_ctx_.get(), [](SSL *ssl, int *out_alert, void *arg) -> int {
        EXPECT_TRUE(SSL_set_quic_transport_params(ssl, kServerParams,
                                                  sizeof(kServerParams)));
        return SSL_TLSEXT_ERR_OK;
      });

  ASSERT_TRUE(CompleteHandshakesForQUIC());
  ExpectReceivedTransportParamsEqual(client_.get(), kServerParams);
  ExpectReceivedTransportParamsEqual(server_.get(), kClientParams);
}

TEST_F(QUICMethodTest, ForbidCrossProtocolResumptionClient) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  g_last_session = nullptr;

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_sess_set_new_cb(client_ctx_.get(), SaveLastSession);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  ExpectHandshakeSuccess();
  EXPECT_FALSE(SSL_session_reused(client_.get()));
  EXPECT_FALSE(SSL_session_reused(server_.get()));

  // The server sent NewSessionTicket messages in the handshake.
  EXPECT_FALSE(g_last_session);
  ASSERT_TRUE(ProvideHandshakeData(client_.get()));
  EXPECT_EQ(SSL_process_quic_post_handshake(client_.get()), 1);
  ASSERT_TRUE(g_last_session);

  // Pretend that g_last_session came from a TLS-over-TCP connection.
  g_last_session->is_quic = false;

  // Create a second connection and verify that resumption does not occur with
  // a session from a non-QUIC connection. This tests that the client does not
  // offer over QUIC a session believed to be received over TCP. The server
  // believes this is a QUIC session, so if the client offered the session, the
  // server would have resumed it.
  ASSERT_TRUE(CreateClientAndServer());
  bssl::UniquePtr<SSL_SESSION> session = std::move(g_last_session);
  SSL_set_session(client_.get(), session.get());

  ASSERT_TRUE(CompleteHandshakesForQUIC());
  ExpectHandshakeSuccess();
  EXPECT_FALSE(SSL_session_reused(client_.get()));
  EXPECT_FALSE(SSL_session_reused(server_.get()));
}

TEST_F(QUICMethodTest, ForbidCrossProtocolResumptionServer) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();

  g_last_session = nullptr;

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_sess_set_new_cb(client_ctx_.get(), SaveLastSession);
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());

  ExpectHandshakeSuccess();
  EXPECT_FALSE(SSL_session_reused(client_.get()));
  EXPECT_FALSE(SSL_session_reused(server_.get()));

  // The server sent NewSessionTicket messages in the handshake.
  EXPECT_FALSE(g_last_session);
  ASSERT_TRUE(ProvideHandshakeData(client_.get()));
  EXPECT_EQ(SSL_process_quic_post_handshake(client_.get()), 1);
  ASSERT_TRUE(g_last_session);

  // Attempt a resumption with g_last_session using TLS_method.
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);

  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), nullptr));

  bssl::UniquePtr<SSL> client(SSL_new(client_ctx.get())),
      server(SSL_new(server_ctx_.get()));
  ASSERT_TRUE(client);
  ASSERT_TRUE(server);
  SSL_set_connect_state(client.get());
  SSL_set_accept_state(server.get());

  // The TLS-over-TCP client will refuse to resume with a quic session, so
  // mark is_quic = false to bypass the client check to test the server check.
  g_last_session->is_quic = false;
  SSL_set_session(client.get(), g_last_session.get());

  BIO *bio1, *bio2;
  ASSERT_TRUE(BIO_new_bio_pair(&bio1, 0, &bio2, 0));

  // SSL_set_bio takes ownership.
  SSL_set_bio(client.get(), bio1, bio1);
  SSL_set_bio(server.get(), bio2, bio2);
  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  EXPECT_FALSE(SSL_session_reused(client.get()));
  EXPECT_FALSE(SSL_session_reused(server.get()));
}

TEST_F(QUICMethodTest, ClientRejectsMissingTransportParams) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(SSL_set_quic_transport_params(server_.get(), nullptr, 0));
  ASSERT_TRUE(RunQUICHandshakesAndExpectError(ExpectedError::kServerError));
}

TEST_F(QUICMethodTest, ServerRejectsMissingTransportParams) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), nullptr, 0));
  ASSERT_TRUE(RunQUICHandshakesAndExpectError(ExpectedError::kClientError));
}

TEST_F(QUICMethodTest, QuicLegacyCodepointEnabled) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  uint8_t kClientParams[] = {1, 2, 3, 4};
  uint8_t kServerParams[] = {5, 6, 7};
  SSL_set_quic_use_legacy_codepoint(client_.get(), 1);
  SSL_set_quic_use_legacy_codepoint(server_.get(), 1);
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), kClientParams,
                                            sizeof(kClientParams)));
  ASSERT_TRUE(SSL_set_quic_transport_params(server_.get(), kServerParams,
                                            sizeof(kServerParams)));

  ASSERT_TRUE(CompleteHandshakesForQUIC());
  ExpectReceivedTransportParamsEqual(client_.get(), kServerParams);
  ExpectReceivedTransportParamsEqual(server_.get(), kClientParams);
}

TEST_F(QUICMethodTest, QuicLegacyCodepointDisabled) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  uint8_t kClientParams[] = {1, 2, 3, 4};
  uint8_t kServerParams[] = {5, 6, 7};
  SSL_set_quic_use_legacy_codepoint(client_.get(), 0);
  SSL_set_quic_use_legacy_codepoint(server_.get(), 0);
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), kClientParams,
                                            sizeof(kClientParams)));
  ASSERT_TRUE(SSL_set_quic_transport_params(server_.get(), kServerParams,
                                            sizeof(kServerParams)));

  ASSERT_TRUE(CompleteHandshakesForQUIC());
  ExpectReceivedTransportParamsEqual(client_.get(), kServerParams);
  ExpectReceivedTransportParamsEqual(server_.get(), kClientParams);
}

TEST_F(QUICMethodTest, QuicLegacyCodepointClientOnly) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  uint8_t kClientParams[] = {1, 2, 3, 4};
  uint8_t kServerParams[] = {5, 6, 7};
  SSL_set_quic_use_legacy_codepoint(client_.get(), 1);
  SSL_set_quic_use_legacy_codepoint(server_.get(), 0);
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), kClientParams,
                                            sizeof(kClientParams)));
  ASSERT_TRUE(SSL_set_quic_transport_params(server_.get(), kServerParams,
                                            sizeof(kServerParams)));

  ASSERT_TRUE(RunQUICHandshakesAndExpectError(ExpectedError::kServerError));
}

TEST_F(QUICMethodTest, QuicLegacyCodepointServerOnly) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));

  ASSERT_TRUE(CreateClientAndServer());
  uint8_t kClientParams[] = {1, 2, 3, 4};
  uint8_t kServerParams[] = {5, 6, 7};
  SSL_set_quic_use_legacy_codepoint(client_.get(), 0);
  SSL_set_quic_use_legacy_codepoint(server_.get(), 1);
  ASSERT_TRUE(SSL_set_quic_transport_params(client_.get(), kClientParams,
                                            sizeof(kClientParams)));
  ASSERT_TRUE(SSL_set_quic_transport_params(server_.get(), kServerParams,
                                            sizeof(kServerParams)));

  ASSERT_TRUE(RunQUICHandshakesAndExpectError(ExpectedError::kServerError));
}

// Test that the default QUIC code point is consistent with
// |TLSEXT_TYPE_quic_transport_parameters|. This test ensures we remember to
// update the two values together.
TEST_F(QUICMethodTest, QuicCodePointDefault) {
  const SSL_QUIC_METHOD quic_method = DefaultQUICMethod();
  ASSERT_TRUE(SSL_CTX_set_quic_method(client_ctx_.get(), &quic_method));
  ASSERT_TRUE(SSL_CTX_set_quic_method(server_ctx_.get(), &quic_method));
  SSL_CTX_set_select_certificate_cb(
      server_ctx_.get(),
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        const uint8_t *data;
        size_t len;
        if (!SSL_early_callback_ctx_extension_get(
                client_hello, TLSEXT_TYPE_quic_transport_parameters, &data,
                &len)) {
          ADD_FAILURE() << "Could not find quic_transport_parameters extension";
          return ssl_select_cert_error;
        }
        return ssl_select_cert_success;
      });

  ASSERT_TRUE(CreateClientAndServer());
  ASSERT_TRUE(CompleteHandshakesForQUIC());
}

extern "C" {
int BORINGSSL_enum_c_type_test(void);
}

TEST(SSLTest, EnumTypes) {
  EXPECT_EQ(sizeof(int), sizeof(ssl_private_key_result_t));
  EXPECT_EQ(1, BORINGSSL_enum_c_type_test());
}

TEST_P(SSLVersionTest, DoubleSSLError) {
  // Connect the inner SSL connections.
  ASSERT_TRUE(Connect());

  // Make a pair of |BIO|s which wrap |client_| and |server_|.
  UniquePtr<BIO_METHOD> bio_method(BIO_meth_new(0, nullptr));
  ASSERT_TRUE(bio_method);
  ASSERT_TRUE(BIO_meth_set_read(
      bio_method.get(), [](BIO *bio, char *out, int len) -> int {
        SSL *ssl = static_cast<SSL *>(BIO_get_data(bio));
        int ret = SSL_read(ssl, out, len);
        int ssl_ret = SSL_get_error(ssl, ret);
        if (ssl_ret == SSL_ERROR_WANT_READ) {
          BIO_set_retry_read(bio);
        }
        return ret;
      }));
  ASSERT_TRUE(BIO_meth_set_write(
      bio_method.get(), [](BIO *bio, const char *in, int len) -> int {
        SSL *ssl = static_cast<SSL *>(BIO_get_data(bio));
        int ret = SSL_write(ssl, in, len);
        int ssl_ret = SSL_get_error(ssl, ret);
        if (ssl_ret == SSL_ERROR_WANT_WRITE) {
          BIO_set_retry_write(bio);
        }
        return ret;
      }));
  ASSERT_TRUE(BIO_meth_set_ctrl(
      bio_method.get(), [](BIO *bio, int cmd, long larg, void *parg) -> long {
        // |SSL| objects require |BIO_flush| support.
        if (cmd == BIO_CTRL_FLUSH) {
          return 1;
        }
        return 0;
      }));

  UniquePtr<BIO> client_bio(BIO_new(bio_method.get()));
  ASSERT_TRUE(client_bio);
  BIO_set_data(client_bio.get(), client_.get());
  BIO_set_init(client_bio.get(), 1);

  UniquePtr<BIO> server_bio(BIO_new(bio_method.get()));
  ASSERT_TRUE(server_bio);
  BIO_set_data(server_bio.get(), server_.get());
  BIO_set_init(server_bio.get(), 1);

  // Wrap the inner connections in another layer of SSL.
  UniquePtr<SSL> client_outer(SSL_new(client_ctx_.get()));
  ASSERT_TRUE(client_outer);
  SSL_set_connect_state(client_outer.get());
  SSL_set_bio(client_outer.get(), client_bio.get(), client_bio.get());
  client_bio.release();  // |SSL_set_bio| takes ownership.

  UniquePtr<SSL> server_outer(SSL_new(server_ctx_.get()));
  ASSERT_TRUE(server_outer);
  SSL_set_accept_state(server_outer.get());
  SSL_set_bio(server_outer.get(), server_bio.get(), server_bio.get());
  server_bio.release();  // |SSL_set_bio| takes ownership.

  // Configure |client_outer| to reject the server certificate.
  SSL_set_custom_verify(
      client_outer.get(), SSL_VERIFY_PEER,
      [](SSL *ssl, uint8_t *out_alert) -> ssl_verify_result_t {
        return ssl_verify_invalid;
      });

  for (;;) {
    int client_ret = SSL_do_handshake(client_outer.get());
    int client_err = SSL_get_error(client_outer.get(), client_ret);
    if (client_err != SSL_ERROR_WANT_READ &&
        client_err != SSL_ERROR_WANT_WRITE) {
      // The client handshake should terminate on a certificate verification
      // error.
      EXPECT_EQ(SSL_ERROR_SSL, client_err);
      EXPECT_TRUE(ErrorEquals(ERR_peek_error(), ERR_LIB_SSL,
                              SSL_R_CERTIFICATE_VERIFY_FAILED));
      break;
    }

    // Run the server handshake and continue.
    int server_ret = SSL_do_handshake(server_outer.get());
    int server_err = SSL_get_error(server_outer.get(), server_ret);
    ASSERT_TRUE(server_err == SSL_ERROR_NONE ||
                server_err == SSL_ERROR_WANT_READ ||
                server_err == SSL_ERROR_WANT_WRITE);
  }
}

TEST_P(SSLVersionTest, SameKeyResume) {
  uint8_t key[48];
  RAND_bytes(key, sizeof(key));

  bssl::UniquePtr<SSL_CTX> server_ctx2 = CreateContext();
  ASSERT_TRUE(server_ctx2);
  ASSERT_TRUE(UseCertAndKey(server_ctx2.get()));
  ASSERT_TRUE(
      SSL_CTX_set_tlsext_ticket_keys(server_ctx_.get(), key, sizeof(key)));
  ASSERT_TRUE(
      SSL_CTX_set_tlsext_ticket_keys(server_ctx2.get(), key, sizeof(key)));

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx2.get(), SSL_SESS_CACHE_BOTH);

  // Establish a session for |server_ctx_|.
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);
  ClientConfig config;
  config.session = session.get();

  // Resuming with |server_ctx_| again works.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx_.get(), config));
  EXPECT_TRUE(SSL_session_reused(client.get()));
  EXPECT_TRUE(SSL_session_reused(server.get()));

  // Resuming with |server_ctx2| also works.
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx2.get(), config));
  EXPECT_TRUE(SSL_session_reused(client.get()));
  EXPECT_TRUE(SSL_session_reused(server.get()));
}

TEST_P(SSLVersionTest, DifferentKeyNoResume) {
  uint8_t key1[48], key2[48];
  RAND_bytes(key1, sizeof(key1));
  RAND_bytes(key2, sizeof(key2));

  bssl::UniquePtr<SSL_CTX> server_ctx2 = CreateContext();
  ASSERT_TRUE(server_ctx2);
  ASSERT_TRUE(UseCertAndKey(server_ctx2.get()));
  ASSERT_TRUE(
      SSL_CTX_set_tlsext_ticket_keys(server_ctx_.get(), key1, sizeof(key1)));
  ASSERT_TRUE(
      SSL_CTX_set_tlsext_ticket_keys(server_ctx2.get(), key2, sizeof(key2)));

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx2.get(), SSL_SESS_CACHE_BOTH);

  // Establish a session for |server_ctx_|.
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);
  ClientConfig config;
  config.session = session.get();

  // Resuming with |server_ctx_| again works.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx_.get(), config));
  EXPECT_TRUE(SSL_session_reused(client.get()));
  EXPECT_TRUE(SSL_session_reused(server.get()));

  // Resuming with |server_ctx2| does not work.
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx2.get(), config));
  EXPECT_FALSE(SSL_session_reused(client.get()));
  EXPECT_FALSE(SSL_session_reused(server.get()));
}

TEST_P(SSLVersionTest, UnrelatedServerNoResume) {
  bssl::UniquePtr<SSL_CTX> server_ctx2 = CreateContext();
  ASSERT_TRUE(server_ctx2);
  ASSERT_TRUE(UseCertAndKey(server_ctx2.get()));

  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx2.get(), SSL_SESS_CACHE_BOTH);

  // Establish a session for |server_ctx_|.
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());
  ASSERT_TRUE(session);
  ClientConfig config;
  config.session = session.get();

  // Resuming with |server_ctx_| again works.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx_.get(), config));
  EXPECT_TRUE(SSL_session_reused(client.get()));
  EXPECT_TRUE(SSL_session_reused(server.get()));

  // Resuming with |server_ctx2| does not work.
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx2.get(), config));
  EXPECT_FALSE(SSL_session_reused(client.get()));
  EXPECT_FALSE(SSL_session_reused(server.get()));
}

Span<const uint8_t> SessionIDOf(const SSL *ssl) {
  const SSL_SESSION *session = SSL_get_session(ssl);
  unsigned len;
  const uint8_t *data = SSL_SESSION_get_id(session, &len);
  return Span(data, len);
}

TEST_P(SSLVersionTest, TicketSessionIDsMatch) {
  // This checks that the session IDs at client and server match after a ticket
  // resumption. It's unclear whether this should be true, but Envoy depends
  // on it in their tests so this will give an early signal if we break it.
  SSL_CTX_set_session_cache_mode(client_ctx_.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx_.get(), SSL_SESS_CACHE_BOTH);

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx_.get(), server_ctx_.get());

  bssl::UniquePtr<SSL> client, server;
  ClientConfig config;
  config.session = session.get();
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_.get(),
                                     server_ctx_.get(), config));
  EXPECT_TRUE(SSL_session_reused(client.get()));
  EXPECT_TRUE(SSL_session_reused(server.get()));

  EXPECT_EQ(Bytes(SessionIDOf(client.get())), Bytes(SessionIDOf(server.get())));
}

static void WriteHelloRequest(SSL *server) {
  // This function assumes TLS 1.2 with ChaCha20-Poly1305.
  ASSERT_EQ(SSL_version(server), TLS1_2_VERSION);
  ASSERT_EQ(SSL_CIPHER_get_cipher_nid(SSL_get_current_cipher(server)),
            NID_chacha20_poly1305);

  // Encrypt a HelloRequest.
  uint8_t in[] = {SSL3_MT_HELLO_REQUEST, 0, 0, 0};
  // Extract key material from |server|.
  static const size_t kKeyLen = 32;
  static const size_t kNonceLen = 12;
  ASSERT_EQ(2u * (kKeyLen + kNonceLen), SSL_get_key_block_len(server));
  uint8_t key_block[2u * (kKeyLen + kNonceLen)];
  ASSERT_TRUE(SSL_generate_key_block(server, key_block, sizeof(key_block)));
  Span<uint8_t> key = Span(key_block).subspan(kKeyLen, kKeyLen);
  Span<uint8_t> nonce =
      Span(key_block).subspan(kKeyLen + kKeyLen + kNonceLen, kNonceLen);

  uint8_t ad[13];
  uint64_t seq = SSL_get_write_sequence(server);
  for (size_t i = 0; i < 8; i++) {
    // The nonce is XORed with the sequence number.
    nonce[11 - i] ^= uint8_t(seq);
    ad[7 - i] = uint8_t(seq);
    seq >>= 8;
  }

  ad[8] = SSL3_RT_HANDSHAKE;
  ad[9] = 3;
  ad[10] = 3;  // TLS 1.2
  ad[11] = 0;
  ad[12] = sizeof(in);

  uint8_t record[5 + sizeof(in) + 16];
  record[0] = SSL3_RT_HANDSHAKE;
  record[1] = 3;
  record[2] = 3;  // TLS 1.2
  record[3] = 0;
  record[4] = sizeof(record) - 5;

  ScopedEVP_AEAD_CTX aead;
  ASSERT_TRUE(EVP_AEAD_CTX_init(aead.get(), EVP_aead_chacha20_poly1305(),
                                key.data(), key.size(),
                                EVP_AEAD_DEFAULT_TAG_LENGTH, nullptr));
  size_t len;
  ASSERT_TRUE(EVP_AEAD_CTX_seal(aead.get(), record + 5, &len,
                                sizeof(record) - 5, nonce.data(), nonce.size(),
                                in, sizeof(in), ad, sizeof(ad)));
  ASSERT_EQ(sizeof(record) - 5, len);

  ASSERT_EQ(int(sizeof(record)),
            BIO_write(SSL_get_wbio(server), record, sizeof(record)));
}

TEST(SSLTest, WriteWhileExplicitRenegotiate) {
  bssl::UniquePtr<SSL_CTX> ctx(CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(ctx);

  ASSERT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), TLS1_2_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), TLS1_2_VERSION));
  ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(
      ctx.get(), "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256"));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, ctx.get(), ctx.get()));
  SSL_set_renegotiate_mode(client.get(), ssl_renegotiate_explicit);
  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  static const uint8_t kInput[] = {'h', 'e', 'l', 'l', 'o'};

  // Write "hello" until the buffer is full, so |client| has a pending write.
  size_t num_writes = 0;
  for (;;) {
    int ret = SSL_write(client.get(), kInput, sizeof(kInput));
    if (ret != int(sizeof(kInput))) {
      ASSERT_EQ(-1, ret);
      ASSERT_EQ(SSL_ERROR_WANT_WRITE, SSL_get_error(client.get(), ret));
      break;
    }
    num_writes++;
  }

  ASSERT_NO_FATAL_FAILURE(WriteHelloRequest(server.get()));

  // |SSL_read| should pick up the HelloRequest.
  uint8_t byte;
  ASSERT_EQ(-1, SSL_read(client.get(), &byte, 1));
  ASSERT_EQ(SSL_ERROR_WANT_RENEGOTIATE, SSL_get_error(client.get(), -1));

  // Drain the data from the |client|.
  uint8_t buf[sizeof(kInput)];
  for (size_t i = 0; i < num_writes; i++) {
    ASSERT_EQ(int(sizeof(buf)), SSL_read(server.get(), buf, sizeof(buf)));
    EXPECT_EQ(Bytes(buf), Bytes(kInput));
  }

  // |client| should be able to finish the pending write and continue to write,
  // despite the paused HelloRequest.
  ASSERT_EQ(int(sizeof(kInput)),
            SSL_write(client.get(), kInput, sizeof(kInput)));
  ASSERT_EQ(int(sizeof(buf)), SSL_read(server.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes(buf), Bytes(kInput));

  ASSERT_EQ(int(sizeof(kInput)),
            SSL_write(client.get(), kInput, sizeof(kInput)));
  ASSERT_EQ(int(sizeof(buf)), SSL_read(server.get(), buf, sizeof(buf)));
  EXPECT_EQ(Bytes(buf), Bytes(kInput));

  // |SSL_read| is stuck until we acknowledge the HelloRequest.
  ASSERT_EQ(-1, SSL_read(client.get(), &byte, 1));
  ASSERT_EQ(SSL_ERROR_WANT_RENEGOTIATE, SSL_get_error(client.get(), -1));

  ASSERT_TRUE(SSL_renegotiate(client.get()));
  ASSERT_EQ(-1, SSL_read(client.get(), &byte, 1));
  ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(client.get(), -1));

  // We never renegotiate as a server.
  ASSERT_EQ(-1, SSL_read(server.get(), buf, sizeof(buf)));
  ASSERT_EQ(SSL_ERROR_SSL, SSL_get_error(server.get(), -1));
  EXPECT_TRUE(
      ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_NO_RENEGOTIATION));
}

TEST(SSLTest, ConnectionPropertiesDuringRenegotiate) {
  // Configure known connection properties, so we can check against them.
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  ASSERT_TRUE(cert);
  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), cert.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(ctx.get(), TLS1_2_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), TLS1_2_VERSION));
  ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(
      ctx.get(), "TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256"));
  ASSERT_TRUE(SSL_CTX_set1_groups_list(ctx.get(), "X25519"));
  ASSERT_TRUE(SSL_CTX_set1_sigalgs_list(ctx.get(), "rsa_pkcs1_sha256"));

  // Connect a client and server that accept renegotiation.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, ctx.get(), ctx.get()));
  SSL_set_renegotiate_mode(client.get(), ssl_renegotiate_freely);
  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  auto check_properties = [&] {
    EXPECT_EQ(SSL_version(client.get()), TLS1_2_VERSION);
    const SSL_CIPHER *cipher = SSL_get_current_cipher(client.get());
    ASSERT_TRUE(cipher);
    EXPECT_EQ(SSL_CIPHER_get_protocol_id(cipher),
              uint16_t{SSL_CIPHER_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256});
    EXPECT_EQ(SSL_CIPHER_get_id(cipher),
              uint32_t{TLS1_CK_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256});
    EXPECT_EQ(SSL_get_group_id(client.get()), SSL_GROUP_X25519);
    EXPECT_EQ(SSL_get_negotiated_group(client.get()), NID_X25519);
    EXPECT_EQ(SSL_get_peer_signature_algorithm(client.get()),
              SSL_SIGN_RSA_PKCS1_SHA256);
    bssl::UniquePtr<X509> peer(SSL_get_peer_certificate(client.get()));
    ASSERT_TRUE(peer);
    EXPECT_EQ(X509_cmp(cert.get(), peer.get()), 0);
  };
  check_properties();

  // The server sends a HelloRequest.
  ASSERT_NO_FATAL_FAILURE(WriteHelloRequest(server.get()));

  // Reading from the client will consume the HelloRequest, start a
  // renegotiation, and then block on a ServerHello from the server.
  uint8_t byte;
  ASSERT_EQ(-1, SSL_read(client.get(), &byte, 1));
  ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(client.get(), -1));

  // Connection properties should continue to report values from the original
  // handshake.
  check_properties();
}

TEST(SSLTest, CopyWithoutEarlyData) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);

  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_early_data_enabled(client_ctx.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx.get(), 1);

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx.get(), server_ctx.get());
  ASSERT_TRUE(session);

  // The client should attempt early data with |session|.
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  SSL_set_session(client.get(), session.get());
  SSL_set_early_data_enabled(client.get(), 1);
  ASSERT_EQ(1, SSL_do_handshake(client.get()));
  EXPECT_TRUE(SSL_in_early_data(client.get()));

  // |SSL_SESSION_copy_without_early_data| should disable early data but
  // still resume the session.
  bssl::UniquePtr<SSL_SESSION> session2(
      SSL_SESSION_copy_without_early_data(session.get()));
  ASSERT_TRUE(session2);
  EXPECT_NE(session.get(), session2.get());
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  SSL_set_session(client.get(), session2.get());
  SSL_set_early_data_enabled(client.get(), 1);
  EXPECT_TRUE(CompleteHandshakes(client.get(), server.get()));
  EXPECT_TRUE(SSL_session_reused(client.get()));
  EXPECT_EQ(ssl_early_data_unsupported_for_session,
            SSL_get_early_data_reason(client.get()));

  // |SSL_SESSION_copy_without_early_data| should be a reference count increase
  // when passed an early-data-incapable session.
  bssl::UniquePtr<SSL_SESSION> session3(
      SSL_SESSION_copy_without_early_data(session2.get()));
  EXPECT_EQ(session2.get(), session3.get());
}

TEST(SSLTest, ProcessTLS13NewSessionTicket) {
  // Configure client and server to negotiate TLS 1.3 only.
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(client_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(server_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_3_VERSION));

  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
  EXPECT_EQ(TLS1_3_VERSION, SSL_version(client.get()));

  // Process a TLS 1.3 NewSessionTicket.
  static const uint8_t kTicket[] = {
      0x04, 0x00, 0x00, 0xb2, 0x00, 0x02, 0xa3, 0x00, 0x04, 0x03, 0x02, 0x01,
      0x01, 0x00, 0x00, 0xa0, 0x01, 0x06, 0x09, 0x11, 0x16, 0x19, 0x21, 0x26,
      0x29, 0x31, 0x36, 0x39, 0x41, 0x46, 0x49, 0x51, 0x03, 0x06, 0x09, 0x13,
      0x16, 0x19, 0x23, 0x26, 0x29, 0x33, 0x36, 0x39, 0x43, 0x46, 0x49, 0x53,
      0xf7, 0x00, 0x29, 0xec, 0xf2, 0xc4, 0xa4, 0x41, 0xfc, 0x30, 0x17, 0x2e,
      0x9f, 0x7c, 0xa8, 0xaf, 0x75, 0x70, 0xf0, 0x1f, 0xc7, 0x98, 0xf7, 0xcf,
      0x5a, 0x5a, 0x6b, 0x5b, 0xfe, 0xf1, 0xe7, 0x3a, 0xe8, 0xf7, 0x6c, 0xd2,
      0xa8, 0xa6, 0x92, 0x5b, 0x96, 0x8d, 0xde, 0xdb, 0xd3, 0x20, 0x6a, 0xcb,
      0x69, 0x06, 0xf4, 0x91, 0x85, 0x2e, 0xe6, 0x5e, 0x0c, 0x59, 0xf2, 0x9e,
      0x9b, 0x79, 0x91, 0x24, 0x7e, 0x4a, 0x32, 0x3d, 0xbe, 0x4b, 0x80, 0x70,
      0xaf, 0xd0, 0x1d, 0xe2, 0xca, 0x05, 0x35, 0x09, 0x09, 0x05, 0x0f, 0xbb,
      0xc4, 0xae, 0xd7, 0xc4, 0xed, 0xd7, 0xae, 0x35, 0xc8, 0x73, 0x63, 0x78,
      0x64, 0xc9, 0x7a, 0x1f, 0xed, 0x7a, 0x9a, 0x47, 0x44, 0xfd, 0x50, 0xf7,
      0xb7, 0xe0, 0x64, 0xa9, 0x02, 0xc1, 0x5c, 0x23, 0x18, 0x3f, 0xc4, 0xcf,
      0x72, 0x02, 0x59, 0x2d, 0xe1, 0xaa, 0x61, 0x72, 0x00, 0x04, 0x5a, 0x5a,
      0x00, 0x00,
  };
  bssl::UniquePtr<SSL_SESSION> session(SSL_process_tls13_new_session_ticket(
      client.get(), kTicket, sizeof(kTicket)));
  ASSERT_TRUE(session);
  ASSERT_TRUE(SSL_SESSION_has_ticket(session.get()));

  uint8_t *session_buf = nullptr;
  size_t session_length = 0;
  ASSERT_TRUE(
      SSL_SESSION_to_bytes(session.get(), &session_buf, &session_length));
  bssl::UniquePtr<uint8_t> session_buf_free(session_buf);
  ASSERT_TRUE(session_buf);
  ASSERT_GT(session_length, 0u);

  // Servers cannot call |SSL_process_tls13_new_session_ticket|.
  ASSERT_FALSE(SSL_process_tls13_new_session_ticket(server.get(), kTicket,
                                                    sizeof(kTicket)));

  // Clients cannot call |SSL_process_tls13_new_session_ticket| before the
  // handshake completes.
  bssl::UniquePtr<SSL> client2(SSL_new(client_ctx.get()));
  ASSERT_TRUE(client2);
  SSL_set_connect_state(client2.get());
  ASSERT_FALSE(SSL_process_tls13_new_session_ticket(client2.get(), kTicket,
                                                    sizeof(kTicket)));
}

TEST(SSLTest, BIO) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx(
      CreateContextWithTestCertificate(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);

  for (bool take_ownership : {true, false}) {
    // For simplicity, get the handshake out of the way first.
    bssl::UniquePtr<SSL> client, server;
    ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                       server_ctx.get()));

    // Wrap |client| in an SSL BIO.
    bssl::UniquePtr<BIO> client_bio(BIO_new(BIO_f_ssl()));
    ASSERT_TRUE(client_bio);
    ASSERT_EQ(1, BIO_set_ssl(client_bio.get(), client.get(), take_ownership));
    if (take_ownership) {
      client.release();
    }

    // Flushing the BIO should not crash.
    EXPECT_EQ(1, BIO_flush(client_bio.get()));

    // Exchange some data.
    EXPECT_EQ(5, BIO_write(client_bio.get(), "hello", 5));
    uint8_t buf[5];
    ASSERT_EQ(5, SSL_read(server.get(), buf, sizeof(buf)));
    EXPECT_EQ(Bytes("hello"), Bytes(buf));

    EXPECT_EQ(5, SSL_write(server.get(), "world", 5));
    ASSERT_EQ(5, BIO_read(client_bio.get(), buf, sizeof(buf)));
    EXPECT_EQ(Bytes("world"), Bytes(buf));

    // |BIO_should_read| should work.
    EXPECT_EQ(-1, BIO_read(client_bio.get(), buf, sizeof(buf)));
    EXPECT_TRUE(BIO_should_read(client_bio.get()));

    // Writing data should eventually exceed the buffer size and fail, reporting
    // |BIO_should_write|.
    int ret;
    for (int i = 0; i < 1024; i++) {
      const uint8_t kZeros[1024] = {0};
      ret = BIO_write(client_bio.get(), kZeros, sizeof(kZeros));
      if (ret <= 0) {
        break;
      }
    }
    EXPECT_EQ(-1, ret);
    EXPECT_TRUE(BIO_should_write(client_bio.get()));
  }
}

TEST(SSLTest, ALPNConfig) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(cert);
  ASSERT_TRUE(key);
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), cert.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));

  // Set up some machinery to check the configured ALPN against what is actually
  // sent over the wire. Note that the ALPN callback is only called when the
  // client offers ALPN.
  std::vector<uint8_t> observed_alpn;
  SSL_CTX_set_alpn_select_cb(
      ctx.get(),
      [](SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in,
         unsigned in_len, void *arg) -> int {
        std::vector<uint8_t> *observed_alpn_ptr =
            static_cast<std::vector<uint8_t> *>(arg);
        observed_alpn_ptr->assign(in, in + in_len);
        return SSL_TLSEXT_ERR_NOACK;
      },
      &observed_alpn);
  auto check_alpn_proto = [&](Span<const uint8_t> expected) {
    observed_alpn.clear();
    bssl::UniquePtr<SSL> client, server;
    ASSERT_TRUE(ConnectClientAndServer(&client, &server, ctx.get(), ctx.get()));
    EXPECT_EQ(Bytes(expected), Bytes(observed_alpn));
  };

  // Note that |SSL_CTX_set_alpn_protos|'s return value is reversed.
  static const uint8_t kValidList[] = {0x03, 'f', 'o', 'o',
                                       0x03, 'b', 'a', 'r'};
  EXPECT_EQ(0,
            SSL_CTX_set_alpn_protos(ctx.get(), kValidList, sizeof(kValidList)));
  check_alpn_proto(kValidList);

  // Invalid lists are rejected.
  static const uint8_t kInvalidList[] = {0x04, 'f', 'o', 'o'};
  EXPECT_EQ(1, SSL_CTX_set_alpn_protos(ctx.get(), kInvalidList,
                                       sizeof(kInvalidList)));

  // Empty lists are valid and are interpreted as disabling ALPN.
  EXPECT_EQ(0, SSL_CTX_set_alpn_protos(ctx.get(), nullptr, 0));
  check_alpn_proto({});
}

// This is a basic unit-test class to verify completing handshake successfully,
// sending the correct codepoint extension and having correct application
// setting on different combination of ALPS codepoint settings. More integration
// tests on runner.go.
class AlpsNewCodepointTest : public testing::Test {
 protected:
  void SetUp() override {
    client_ctx_.reset(SSL_CTX_new(TLS_method()));
    server_ctx_ = CreateContextWithTestCertificate(TLS_method());
    ASSERT_TRUE(client_ctx_);
    ASSERT_TRUE(server_ctx_);
  }

  void SetUpApplicationSetting() {
    static const uint8_t alpn[] = {0x03, 'f', 'o', 'o'};
    static const uint8_t proto[] = {'f', 'o', 'o'};
    static const uint8_t alps[] = {0x04, 'a', 'l', 'p', 's'};
    // SSL_set_alpn_protos's return value is backwards. It returns zero on
    // success and one on failure.
    ASSERT_FALSE(SSL_set_alpn_protos(client_.get(), alpn, sizeof(alpn)));
    SSL_CTX_set_alpn_select_cb(
        server_ctx_.get(),
        [](SSL *ssl, const uint8_t **out, uint8_t *out_len, const uint8_t *in,
           unsigned in_len, void *arg) -> int {
          return SSL_select_next_proto(const_cast<uint8_t **>(out), out_len, in,
                                       in_len, alpn,
                                       sizeof(alpn)) == OPENSSL_NPN_NEGOTIATED
                     ? SSL_TLSEXT_ERR_OK
                     : SSL_TLSEXT_ERR_NOACK;
        },
        nullptr);
    ASSERT_TRUE(SSL_add_application_settings(client_.get(), proto,
                                             sizeof(proto), nullptr, 0));
    ASSERT_TRUE(SSL_add_application_settings(
        server_.get(), proto, sizeof(proto), alps, sizeof(alps)));
  }

  bssl::UniquePtr<SSL_CTX> client_ctx_;
  bssl::UniquePtr<SSL_CTX> server_ctx_;

  bssl::UniquePtr<SSL> client_;
  bssl::UniquePtr<SSL> server_;
};

TEST_F(AlpsNewCodepointTest, Enabled) {
  SetUpExpectedNewCodePoint(server_ctx_.get());

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  SSL_set_alps_use_new_codepoint(client_.get(), 1);
  SSL_set_alps_use_new_codepoint(server_.get(), 1);

  SetUpApplicationSetting();
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  ASSERT_TRUE(SSL_has_application_settings(client_.get()));
}

TEST_F(AlpsNewCodepointTest, ClientExplictServerDefault) {
  SetUpExpectedNewCodePoint(server_ctx_.get());

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  SSL_set_alps_use_new_codepoint(client_.get(), 1);

  SetUpApplicationSetting();
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  ASSERT_TRUE(SSL_has_application_settings(client_.get()));
}

TEST_F(AlpsNewCodepointTest, ClientDefaultServerExplicit) {
  SetUpExpectedNewCodePoint(server_ctx_.get());

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  SSL_set_alps_use_new_codepoint(server_.get(), 1);

  SetUpApplicationSetting();
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  ASSERT_TRUE(SSL_has_application_settings(client_.get()));
}

TEST_F(AlpsNewCodepointTest, Disabled) {
  // Both client and server disable alps new codepoint.
  SetUpExpectedOldCodePoint(server_ctx_.get());

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  SSL_set_alps_use_new_codepoint(client_.get(), 0);
  SSL_set_alps_use_new_codepoint(server_.get(), 0);

  SetUpApplicationSetting();
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  ASSERT_TRUE(SSL_has_application_settings(client_.get()));
}

TEST_F(AlpsNewCodepointTest, ClientOnly) {
  // If client set new codepoint but server doesn't set, server ignores it.
  SetUpExpectedNewCodePoint(server_ctx_.get());

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  SSL_set_alps_use_new_codepoint(client_.get(), 1);
  SSL_set_alps_use_new_codepoint(server_.get(), 0);

  SetUpApplicationSetting();
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  ASSERT_FALSE(SSL_has_application_settings(client_.get()));
}

TEST_F(AlpsNewCodepointTest, ServerOnly) {
  // If client doesn't set new codepoint, while server set.
  SetUpExpectedOldCodePoint(server_ctx_.get());

  ASSERT_TRUE(CreateClientAndServer(&client_, &server_, client_ctx_.get(),
                                    server_ctx_.get()));

  SSL_set_alps_use_new_codepoint(client_.get(), 0);
  SSL_set_alps_use_new_codepoint(server_.get(), 1);

  SetUpApplicationSetting();
  ASSERT_TRUE(CompleteHandshakes(client_.get(), server_.get()));
  ASSERT_FALSE(SSL_has_application_settings(client_.get()));
}

// Test that the key usage checker can correctly handle issuerUID and
// subjectUID. See https://crbug.com/1199744.
TEST(SSLTest, KeyUsageWithUIDs) {
  static const char kGoodKeyUsage[] = R"(
-----BEGIN CERTIFICATE-----
MIIB7DCCAZOgAwIBAgIJANlMBNpJfb/rMAoGCCqGSM49BAMCMEUxCzAJBgNVBAYT
AkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBXaWRn
aXRzIFB0eSBMdGQwHhcNMTQwNDIzMjMyMTU3WhcNMTQwNTIzMjMyMTU3WjBFMQsw
CQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UECgwYSW50ZXJu
ZXQgV2lkZ2l0cyBQdHkgTHRkMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5itp
4r9ln5e+Lx4NlIpM1Zdrt6keDUb73ampHp3culoB59aXqAoY+cPEox5W4nyDSNsW
Ghz1HX7xlC1Lz3IiwYEEABI0VoIEABI0VqNgMF4wHQYDVR0OBBYEFKuE0qyrlfCC
ThZ4B1VXX+QmjYLRMB8GA1UdIwQYMBaAFKuE0qyrlfCCThZ4B1VXX+QmjYLRMA4G
A1UdDwEB/wQEAwIHgDAMBgNVHRMEBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIEWJ
34EcqW5MHwLIA1hZ2Tj/jV2QjN02KLxis9mFsqDKAiAMlMTkzsM51vVs9Ohqa+Rc
4Z7qDhjIhiF4dM0uEDYRVA==
-----END CERTIFICATE-----
)";
  static const char kBadKeyUsage[] = R"(
-----BEGIN CERTIFICATE-----
MIIB7jCCAZOgAwIBAgIJANlMBNpJfb/rMAoGCCqGSM49BAMCMEUxCzAJBgNVBAYT
AkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5ldCBXaWRn
aXRzIFB0eSBMdGQwHhcNMTQwNDIzMjMyMTU3WhcNMTQwNTIzMjMyMTU3WjBFMQsw
CQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UECgwYSW50ZXJu
ZXQgV2lkZ2l0cyBQdHkgTHRkMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE5itp
4r9ln5e+Lx4NlIpM1Zdrt6keDUb73ampHp3culoB59aXqAoY+cPEox5W4nyDSNsW
Ghz1HX7xlC1Lz3IiwYEEABI0VoIEABI0VqNgMF4wHQYDVR0OBBYEFKuE0qyrlfCC
ThZ4B1VXX+QmjYLRMB8GA1UdIwQYMBaAFKuE0qyrlfCCThZ4B1VXX+QmjYLRMA4G
A1UdDwEB/wQEAwIDCDAMBgNVHRMEBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQC6
taYBUDu2gcZC6EMk79FBHArYI0ucF+kzvETegZCbBAIhANtObFec5gtso/47moPD
RHrQbWsFUakETXL9QMlegh5t
-----END CERTIFICATE-----
)";

  bssl::UniquePtr<X509> good = CertFromPEM(kGoodKeyUsage);
  ASSERT_TRUE(good);
  bssl::UniquePtr<X509> bad = CertFromPEM(kBadKeyUsage);
  ASSERT_TRUE(bad);

  // We check key usage when configuring EC certificates to distinguish ECDSA
  // and ECDH.
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  EXPECT_TRUE(SSL_CTX_use_certificate(ctx.get(), good.get()));
  EXPECT_FALSE(SSL_CTX_use_certificate(ctx.get(), bad.get()));
}

// Test that |SSL_can_release_private_key| reports true as early as expected.
// The internal asserts in the library check we do not report true too early.
TEST(SSLTest, CanReleasePrivateKey) {
  bssl::UniquePtr<SSL_CTX> client_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);

  // Note this assumes the transport buffer is large enough to fit the client
  // and server first flights. We check this with |SSL_ERROR_WANT_READ|. If the
  // transport buffer was too small it would return |SSL_ERROR_WANT_WRITE|.
  auto check_first_server_round_trip = [&](SSL *client, SSL *server) {
    // Write the ClientHello.
    ASSERT_EQ(-1, SSL_do_handshake(client));
    ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(client, -1));

    // Consume the ClientHello and write the server flight.
    ASSERT_EQ(-1, SSL_do_handshake(server));
    ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(server, -1));

    EXPECT_TRUE(SSL_can_release_private_key(server));
  };

  {
    SCOPED_TRACE("TLS 1.2 ECDHE");
    bssl::UniquePtr<SSL_CTX> server_ctx(
        CreateContextWithTestCertificate(TLS_method()));
    ASSERT_TRUE(server_ctx);
    ASSERT_TRUE(
        SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_2_VERSION));
    ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(
        server_ctx.get(), "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"));
    // Configure the server to request client certificates, so we can also test
    // the client half.
    SSL_CTX_set_custom_verify(
        server_ctx.get(), SSL_VERIFY_PEER,
        [](SSL *ssl, uint8_t *out_alert) { return ssl_verify_ok; });
    bssl::UniquePtr<SSL> client, server;
    ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));
    check_first_server_round_trip(client.get(), server.get());

    // Consume the server flight and write the client response. The client still
    // has a Finished message to consume but can also release its key early.
    ASSERT_EQ(-1, SSL_do_handshake(client.get()));
    ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(client.get(), -1));
    EXPECT_TRUE(SSL_can_release_private_key(client.get()));

    // However, a client that has not disabled renegotiation can never release
    // the key.
    ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));
    SSL_set_renegotiate_mode(client.get(), ssl_renegotiate_freely);
    check_first_server_round_trip(client.get(), server.get());
    ASSERT_EQ(-1, SSL_do_handshake(client.get()));
    ASSERT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(client.get(), -1));
    EXPECT_FALSE(SSL_can_release_private_key(client.get()));
  }

  {
    SCOPED_TRACE("TLS 1.2 resumption");
    bssl::UniquePtr<SSL_CTX> server_ctx(
        CreateContextWithTestCertificate(TLS_method()));
    ASSERT_TRUE(server_ctx);
    ASSERT_TRUE(
        SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_2_VERSION));
    bssl::UniquePtr<SSL_SESSION> session =
        CreateClientSession(client_ctx.get(), server_ctx.get());
    ASSERT_TRUE(session);
    bssl::UniquePtr<SSL> client, server;
    ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));
    SSL_set_session(client.get(), session.get());
    check_first_server_round_trip(client.get(), server.get());
  }

  {
    SCOPED_TRACE("TLS 1.3 1-RTT");
    bssl::UniquePtr<SSL_CTX> server_ctx(
        CreateContextWithTestCertificate(TLS_method()));
    ASSERT_TRUE(server_ctx);
    ASSERT_TRUE(
        SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_3_VERSION));
    bssl::UniquePtr<SSL> client, server;
    ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));
    check_first_server_round_trip(client.get(), server.get());
  }

  {
    SCOPED_TRACE("TLS 1.3 resumption");
    bssl::UniquePtr<SSL_CTX> server_ctx(
        CreateContextWithTestCertificate(TLS_method()));
    ASSERT_TRUE(server_ctx);
    ASSERT_TRUE(
        SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_3_VERSION));
    bssl::UniquePtr<SSL_SESSION> session =
        CreateClientSession(client_ctx.get(), server_ctx.get());
    ASSERT_TRUE(session);
    bssl::UniquePtr<SSL> client, server;
    ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx.get()));
    SSL_set_session(client.get(), session.get());
    check_first_server_round_trip(client.get(), server.get());
  }
}

// GetExtensionOrder sets |*out| to the list of extensions a client attached to
// |ctx| will send in the ClientHello. If |ech_keys| is non-null, the client
// will offer ECH with the public component. If |decrypt_ech| is true, |*out|
// will be set to the ClientHelloInner's extensions, rather than
// ClientHelloOuter.
static bool GetExtensionOrder(SSL_CTX *client_ctx, std::vector<uint16_t> *out,
                              SSL_ECH_KEYS *ech_keys, bool decrypt_ech) {
  struct AppData {
    std::vector<uint16_t> *out;
    bool decrypt_ech;
    bool callback_done = false;
  };
  AppData app_data;
  app_data.out = out;
  app_data.decrypt_ech = decrypt_ech;

  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  if (!server_ctx ||  //
      !SSL_CTX_set_app_data(server_ctx.get(), &app_data) ||
      (decrypt_ech && !SSL_CTX_set1_ech_keys(server_ctx.get(), ech_keys))) {
    return false;
  }

  // Configure the server to record the ClientHello extension order. We use a
  // server rather than |GetClientHello| so it can decrypt ClientHelloInner.
  SSL_CTX_set_select_certificate_cb(
      server_ctx.get(),
      [](const SSL_CLIENT_HELLO *client_hello) -> ssl_select_cert_result_t {
        AppData *app_data_ptr = static_cast<AppData *>(
            SSL_CTX_get_app_data(SSL_get_SSL_CTX(client_hello->ssl)));
        EXPECT_EQ(app_data_ptr->decrypt_ech ? 1 : 0,
                  SSL_ech_accepted(client_hello->ssl));

        app_data_ptr->out->clear();
        CBS extensions;
        CBS_init(&extensions, client_hello->extensions,
                 client_hello->extensions_len);
        while (CBS_len(&extensions)) {
          uint16_t type;
          CBS body;
          if (!CBS_get_u16(&extensions, &type) ||
              !CBS_get_u16_length_prefixed(&extensions, &body)) {
            return ssl_select_cert_error;
          }
          app_data_ptr->out->push_back(type);
        }

        // Don't bother completing the handshake.
        app_data_ptr->callback_done = true;
        return ssl_select_cert_error;
      });

  bssl::UniquePtr<SSL> client, server;
  if (!CreateClientAndServer(&client, &server, client_ctx, server_ctx.get()) ||
      (ech_keys != nullptr && !InstallECHConfigList(client.get(), ech_keys))) {
    return false;
  }

  // Run the handshake far enough to process the ClientHello.
  SSL_do_handshake(client.get());
  SSL_do_handshake(server.get());
  return app_data.callback_done;
}

// Test that, when extension permutation is enabled, the ClientHello extension
// order changes, both with and without ECH, and in both ClientHelloInner and
// ClientHelloOuter.
TEST(SSLTest, PermuteExtensions) {
  bssl::UniquePtr<SSL_ECH_KEYS> keys = MakeTestECHKeys();
  ASSERT_TRUE(keys);
  for (bool offer_ech : {false, true}) {
    SCOPED_TRACE(offer_ech);
    SSL_ECH_KEYS *maybe_keys = offer_ech ? keys.get() : nullptr;
    for (bool decrypt_ech : {false, true}) {
      SCOPED_TRACE(decrypt_ech);
      if (!offer_ech && decrypt_ech) {
        continue;
      }

      // When extension permutation is disabled, the order should be consistent.
      bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
      ASSERT_TRUE(ctx);
      std::vector<uint16_t> order1, order2;
      ASSERT_TRUE(
          GetExtensionOrder(ctx.get(), &order1, maybe_keys, decrypt_ech));
      ASSERT_TRUE(
          GetExtensionOrder(ctx.get(), &order2, maybe_keys, decrypt_ech));
      EXPECT_EQ(order1, order2);

      ctx.reset(SSL_CTX_new(TLS_method()));
      ASSERT_TRUE(ctx);
      SSL_CTX_set_permute_extensions(ctx.get(), 1);

      // When extension permutation is enabled, each ClientHello should have a
      // different order.
      //
      // This test is inherently flaky, so we run it multiple times. We send at
      // least five extensions by default from TLS 1.3: supported_versions,
      // key_share, supported_groups, psk_key_exchange_modes, and
      // signature_algorithms. That means the probability of a false negative is
      // at most 1/120. Repeating the test 14 times lowers false negative rate
      // to under 2^-96.
      ASSERT_TRUE(
          GetExtensionOrder(ctx.get(), &order1, maybe_keys, decrypt_ech));
      EXPECT_GE(order1.size(), 5u);
      static const int kNumIterations = 14;
      bool passed = false;
      for (int i = 0; i < kNumIterations; i++) {
        ASSERT_TRUE(
            GetExtensionOrder(ctx.get(), &order2, maybe_keys, decrypt_ech));
        if (order1 != order2) {
          passed = true;
          break;
        }
      }
      EXPECT_TRUE(passed) << "Extensions were not permuted";
    }
  }
}

TEST(SSLTest, HostMatching) {
  static const char kCertPEM[] = R"(
-----BEGIN CERTIFICATE-----
MIIB9jCCAZ2gAwIBAgIQeudG9R61BOxUvWkeVhU5DTAKBggqhkjOPQQDAjApMRAw
DgYDVQQKEwdBY21lIENvMRUwEwYDVQQDEwxleGFtcGxlMy5jb20wHhcNMjExMjA2
MjA1NjU2WhcNMjIxMjA2MjA1NjU2WjApMRAwDgYDVQQKEwdBY21lIENvMRUwEwYD
VQQDEwxleGFtcGxlMy5jb20wWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAAS7l2VO
Bl2TjVm9WfGk24+hMbVFUNB+RVHWbCvFvNZAoWiIJ2z34RLGInyZvCZ8xLAvsuaW
ULDDaoeDl1M0t4Hmo4GmMIGjMA4GA1UdDwEB/wQEAwIChDATBgNVHSUEDDAKBggr
BgEFBQcDATAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBTTJWurcc1t+VPQBko3
Gsw6cbcWSTBMBgNVHREERTBDggxleGFtcGxlMS5jb22CDGV4YW1wbGUyLmNvbYIP
YSouZXhhbXBsZTQuY29tgg4qLmV4YW1wbGU1LmNvbYcEAQIDBDAKBggqhkjOPQQD
AgNHADBEAiAAv0ljHJGrgyzZDkG6XvNZ5ewxRfnXcZuD0Y7E4giCZgIgNK1qjilu
5DyVbfKeeJhOCtGxqE1dWLXyJBnoRomSYBY=
-----END CERTIFICATE-----
)";
  bssl::UniquePtr<X509> cert(CertFromPEM(kCertPEM));
  ASSERT_TRUE(cert);
  static const char kCertNoSANsPEM[] = R"(
-----BEGIN CERTIFICATE-----
MIIBqzCCAVGgAwIBAgIQeudG9R61BOxUvWkeVhU5DTAKBggqhkjOPQQDAjArMRIw
EAYDVQQKEwlBY21lIENvIDIxFTATBgNVBAMTDGV4YW1wbGUzLmNvbTAeFw0yMTEy
MDYyMDU2NTZaFw0yMjEyMDYyMDU2NTZaMCsxEjAQBgNVBAoTCUFjbWUgQ28gMjEV
MBMGA1UEAxMMZXhhbXBsZTMuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE
u5dlTgZdk41ZvVnxpNuPoTG1RVDQfkVR1mwrxbzWQKFoiCds9+ESxiJ8mbwmfMSw
L7LmllCww2qHg5dTNLeB5qNXMFUwDgYDVR0PAQH/BAQDAgKEMBMGA1UdJQQMMAoG
CCsGAQUFBwMBMA8GA1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFNMla6txzW35U9AG
SjcazDpxtxZJMAoGCCqGSM49BAMCA0gAMEUCIG3YWGWtpVhbcGV7wFKQwTfmvwHW
pw4qCFZlool4hCwsAiEA+2fc6NfSbNpFEtQkDOMJW2ANiScAVEmImNqPfb2klz4=
-----END CERTIFICATE-----
)";
  bssl::UniquePtr<X509> cert_no_sans(CertFromPEM(kCertNoSANsPEM));
  ASSERT_TRUE(cert_no_sans);

  static const char kKeyPEM[] = R"(
-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQghsaSZhUzZAcQlLyJ
MDuy7WPdyqNsAX9rmEP650LF/q2hRANCAAS7l2VOBl2TjVm9WfGk24+hMbVFUNB+
RVHWbCvFvNZAoWiIJ2z34RLGInyZvCZ8xLAvsuaWULDDaoeDl1M0t4Hm
-----END PRIVATE KEY-----
)";
  bssl::UniquePtr<EVP_PKEY> key(KeyFromPEM(kKeyPEM));
  ASSERT_TRUE(key);

  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(X509_STORE_add_cert(SSL_CTX_get_cert_store(client_ctx.get()),
                                  cert.get()));
  ASSERT_TRUE(X509_STORE_add_cert(SSL_CTX_get_cert_store(client_ctx.get()),
                                  cert_no_sans.get()));
  SSL_CTX_set_verify(client_ctx.get(),
                     SSL_VERIFY_PEER | SSL_VERIFY_FAIL_IF_NO_PEER_CERT,
                     nullptr);
  X509_VERIFY_PARAM_set_flags(SSL_CTX_get0_param(client_ctx.get()),
                              X509_V_FLAG_NO_CHECK_TIME);

  struct TestCase {
    X509 *cert;
    std::string hostname;
    unsigned flags;
    bool should_match;
  };
  std::vector<TestCase> kTests = {
      // These two names are present as SANs in the certificate.
      {cert.get(), "example1.com", 0, true},
      {cert.get(), "example2.com", 0, true},
      // This is the CN of the certificate, but that shouldn't matter if a SAN
      // extension is present.
      {cert.get(), "example3.com", 0, false},
      // If the SAN is not present, we, for now, look for DNS names in the CN.
      {cert_no_sans.get(), "example3.com", 0, true},
      // ... but this can be turned off.
      {cert_no_sans.get(), "example3.com", X509_CHECK_FLAG_NEVER_CHECK_SUBJECT,
       false},
      // a*.example4.com is a SAN, but is invalid.
      {cert.get(), "abc.example4.com", 0, false},
      // *.example5.com is a SAN in the certificate, which is a normal and valid
      // wildcard.
      {cert.get(), "abc.example5.com", 0, true},
      // This name is not present.
      {cert.get(), "notexample1.com", 0, false},
      // The IPv4 address 1.2.3.4 is a SAN, but that shouldn't match against a
      // hostname that happens to be its textual representation.
      {cert.get(), "1.2.3.4", 0, false},
  };

  for (const TestCase &test : kTests) {
    SCOPED_TRACE(test.hostname);

    bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(server_ctx);
    ASSERT_TRUE(SSL_CTX_use_certificate(server_ctx.get(), test.cert));
    ASSERT_TRUE(SSL_CTX_use_PrivateKey(server_ctx.get(), key.get()));

    ClientConfig config;
    bssl::UniquePtr<SSL> client, server;
    config.verify_hostname = test.hostname;
    config.hostflags = test.flags;
    EXPECT_EQ(test.should_match,
              ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get(), config));
  }
}

TEST(SSLTest, NumTickets) {
  bssl::UniquePtr<SSL_CTX> server_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  ASSERT_TRUE(cert);
  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);
  ASSERT_TRUE(SSL_CTX_use_certificate(server_ctx.get(), cert.get()));
  ASSERT_TRUE(SSL_CTX_use_PrivateKey(server_ctx.get(), key.get()));
  SSL_CTX_set_session_cache_mode(server_ctx.get(), SSL_SESS_CACHE_BOTH);

  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);
  static size_t ticket_count;
  SSL_CTX_sess_set_new_cb(client_ctx.get(), [](SSL *, SSL_SESSION *) -> int {
    ticket_count++;
    return 0;
  });

  auto count_tickets = [&]() -> size_t {
    ticket_count = 0;
    bssl::UniquePtr<SSL> client, server;
    if (!ConnectClientAndServer(&client, &server, client_ctx.get(),
                                server_ctx.get()) ||
        !FlushNewSessionTickets(client.get(), server.get())) {
      ADD_FAILURE() << "Could not run handshake";
      return 0;
    }
    return ticket_count;
  };

  // By default, we should send two tickets.
  EXPECT_EQ(count_tickets(), 2u);

  for (size_t num_tickets : {0, 1, 2, 3, 4, 5}) {
    SCOPED_TRACE(num_tickets);
    ASSERT_TRUE(SSL_CTX_set_num_tickets(server_ctx.get(), num_tickets));
    EXPECT_EQ(SSL_CTX_get_num_tickets(server_ctx.get()), num_tickets);
    EXPECT_EQ(count_tickets(), num_tickets);
  }

  // Configuring too many tickets causes us to stop at some point.
  ASSERT_TRUE(SSL_CTX_set_num_tickets(server_ctx.get(), 100000));
  EXPECT_EQ(SSL_CTX_get_num_tickets(server_ctx.get()), 16u);
  EXPECT_EQ(count_tickets(), 16u);
}

TEST(SSLTest, CertSubjectsToStack) {
  const std::string kCert1 = R"(
-----BEGIN CERTIFICATE-----
MIIBzzCCAXagAwIBAgIJANlMBNpJfb/rMAkGByqGSM49BAEwRTELMAkGA1UEBhMC
QVUxEzARBgNVBAgMClNvbWUtU3RhdGUxITAfBgNVBAoMGEludGVybmV0IFdpZGdp
dHMgUHR5IEx0ZDAeFw0xNDA0MjMyMzIxNTdaFw0xNDA1MjMyMzIxNTdaMEUxCzAJ
BgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRlcm5l
dCBXaWRnaXRzIFB0eSBMdGQwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATmK2ni
v2Wfl74vHg2UikzVl2u3qR4NRvvdqakendy6WgHn1peoChj5w8SjHlbifINI2xYa
HPUdfvGULUvPciLBo1AwTjAdBgNVHQ4EFgQUq4TSrKuV8IJOFngHVVdf5CaNgtEw
HwYDVR0jBBgwFoAUq4TSrKuV8IJOFngHVVdf5CaNgtEwDAYDVR0TBAUwAwEB/zAJ
BgcqhkjOPQQBA0gAMEUCIQDyoDVeUTo2w4J5m+4nUIWOcAZ0lVfSKXQA9L4Vh13E
BwIgfB55FGohg/B6dGh5XxSZmmi08cueFV7mHzJSYV51yRQ=
-----END CERTIFICATE-----
)";
  const std::vector<uint8_t> kName1 = {
      0x30, 0x45, 0x31, 0x0b, 0x30, 0x09, 0x06, 0x03, 0x55, 0x04, 0x06, 0x13,
      0x02, 0x41, 0x55, 0x31, 0x13, 0x30, 0x11, 0x06, 0x03, 0x55, 0x04, 0x08,
      0x0c, 0x0a, 0x53, 0x6f, 0x6d, 0x65, 0x2d, 0x53, 0x74, 0x61, 0x74, 0x65,
      0x31, 0x21, 0x30, 0x1f, 0x06, 0x03, 0x55, 0x04, 0x0a, 0x0c, 0x18, 0x49,
      0x6e, 0x74, 0x65, 0x72, 0x6e, 0x65, 0x74, 0x20, 0x57, 0x69, 0x64, 0x67,
      0x69, 0x74, 0x73, 0x20, 0x50, 0x74, 0x79, 0x20, 0x4c, 0x74, 0x64};
  const std::string kCert2 = R"(
-----BEGIN CERTIFICATE-----
MIICXjCCAcegAwIBAgIIWjO48ufpunYwDQYJKoZIhvcNAQELBQAwNjEaMBgGA1UE
ChMRQm9yaW5nU1NMIFRFU1RJTkcxGDAWBgNVBAMTD0ludGVybWVkaWF0ZSBDQTAg
Fw0xNTAxMDEwMDAwMDBaGA8yMTAwMDEwMTAwMDAwMFowMjEaMBgGA1UEChMRQm9y
aW5nU1NMIFRFU1RJTkcxFDASBgNVBAMTC2V4YW1wbGUuY29tMIGfMA0GCSqGSIb3
DQEBAQUAA4GNADCBiQKBgQDD0U0ZYgqShJ7oOjsyNKyVXEHqeafmk/bAoPqY/h1c
oPw2E8KmeqiUSoTPjG5IXSblOxcqpbAXgnjPzo8DI3GNMhAf8SYNYsoH7gc7Uy7j
5x8bUrisGnuTHqkqH6d4/e7ETJ7i3CpR8bvK16DggEvQTudLipz8FBHtYhFakfdh
TwIDAQABo3cwdTAOBgNVHQ8BAf8EBAMCBaAwHQYDVR0lBBYwFAYIKwYBBQUHAwEG
CCsGAQUFBwMCMAwGA1UdEwEB/wQCMAAwGQYDVR0OBBIEEKN5pvbur7mlXjeMEYA0
4nUwGwYDVR0jBBQwEoAQjBpoqLV2211Xex+NFLIGozANBgkqhkiG9w0BAQsFAAOB
gQBj/p+JChp//LnXWC1k121LM/ii7hFzQzMrt70bny406SGz9jAjaPOX4S3gt38y
rhjpPukBlSzgQXFg66y6q5qp1nQTD1Cw6NkKBe9WuBlY3iYfmsf7WT8nhlT1CttU
xNCwyMX9mtdXdQicOfNjIGUCD5OLV5PgHFPRKiHHioBAhg==
-----END CERTIFICATE-----
)";
  const std::vector<uint8_t> kName2 = {
      0x30, 0x32, 0x31, 0x1a, 0x30, 0x18, 0x06, 0x03, 0x55, 0x04, 0x0a,
      0x13, 0x11, 0x42, 0x6f, 0x72, 0x69, 0x6e, 0x67, 0x53, 0x53, 0x4c,
      0x20, 0x54, 0x45, 0x53, 0x54, 0x49, 0x4e, 0x47, 0x31, 0x14, 0x30,
      0x12, 0x06, 0x03, 0x55, 0x04, 0x03, 0x13, 0x0b, 0x65, 0x78, 0x61,
      0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6f, 0x6d};

  const struct {
    std::vector<std::vector<uint8_t>> existing;
    std::string pem;
    std::vector<std::vector<uint8_t>> expected;
  } kTests[] = {
      // Do nothing.
      {{}, "", {}},
      // Append to an empty list, skipping duplicates.
      {{}, kCert1 + kCert2 + kCert1, {kName1, kName2}},
      // One of the names was already present.
      {{kName1}, kCert1 + kCert2, {kName1, kName2}},
      // Both names were already present.
      {{kName1, kName2}, kCert1 + kCert2, {kName1, kName2}},
      // Preserve existing duplicates.
      {{kName1, kName2, kName2}, kCert1 + kCert2, {kName1, kName2, kName2}},
  };
  for (size_t i = 0; i < std::size(kTests); i++) {
    SCOPED_TRACE(i);
    const auto &t = kTests[i];

    bssl::UniquePtr<STACK_OF(X509_NAME)> stack(sk_X509_NAME_new_null());
    ASSERT_TRUE(stack);
    for (const auto &name : t.existing) {
      const uint8_t *inp = name.data();
      bssl::UniquePtr<X509_NAME> name_obj(
          d2i_X509_NAME(nullptr, &inp, name.size()));
      ASSERT_TRUE(name_obj);
      EXPECT_EQ(inp, name.data() + name.size());
      ASSERT_TRUE(bssl::PushToStack(stack.get(), std::move(name_obj)));
    }

    bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(t.pem.data(), t.pem.size()));
    ASSERT_TRUE(bio);
    ASSERT_TRUE(SSL_add_bio_cert_subjects_to_stack(stack.get(), bio.get()));

    // The function should have left |stack|'s comparison function alone.
    EXPECT_EQ(nullptr, sk_X509_NAME_set_cmp_func(stack.get(), nullptr));

    std::vector<std::vector<uint8_t>> expected = t.expected, result;
    for (X509_NAME *name : stack.get()) {
      uint8_t *der = nullptr;
      int der_len = i2d_X509_NAME(name, &der);
      ASSERT_GE(der_len, 0);
      result.push_back(std::vector<uint8_t>(der, der + der_len));
      OPENSSL_free(der);
    }

    // |SSL_add_bio_cert_subjects_to_stack| does not return the output in a
    // well-defined order.
    std::sort(expected.begin(), expected.end());
    std::sort(result.begin(), result.end());
    EXPECT_EQ(result, expected);
  }
}

TEST(SSLTest, EmptyClientCAList) {
  if (SkipTempFileTests()) {
    GTEST_SKIP();
  }

  TemporaryFile empty;
  ASSERT_TRUE(empty.Init());
  bssl::UniquePtr<STACK_OF(X509_NAME)> names(
      SSL_load_client_CA_file(empty.path().c_str()));
  EXPECT_FALSE(names);
}

TEST(SSLTest, CertificatesFromFile) {
  if (SkipTempFileTests()) {
    GTEST_SKIP();
  }

  bssl::UniquePtr<X509> cert = GetChainTestCertificate();
  ASSERT_TRUE(cert);
  bssl::UniquePtr<X509> ca = GetChainTestIntermediate();
  ASSERT_TRUE(ca);
  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<EVP_PKEY> wrong_key = GetTestKey();
  ASSERT_TRUE(wrong_key);

  // Picking up a single certificate with the chain and single-certificate APIs.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestCertificatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_certificate_file(ctx.get(), file.path().c_str(),
                                             SSL_FILETYPE_PEM));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    STACK_OF(X509) *chain = nullptr;
    ASSERT_TRUE(SSL_CTX_get0_chain_certs(ctx.get(), &chain));
    EXPECT_EQ(sk_X509_num(chain), 0u);
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestCertificatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    STACK_OF(X509) *chain = nullptr;
    ASSERT_TRUE(SSL_CTX_get0_chain_certs(ctx.get(), &chain));
    EXPECT_EQ(sk_X509_num(chain), 0u);
  }

  // Picking up a certificate chain.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(std::string(kChainTestCertificatePEM) +
                          kChainTestIntermediatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    STACK_OF(X509) *chain = nullptr;
    ASSERT_TRUE(SSL_CTX_get0_chain_certs(ctx.get(), &chain));
    ASSERT_EQ(sk_X509_num(chain), 1u);
    EXPECT_EQ(X509_cmp(ca.get(), sk_X509_value(chain, 0)), 0);
  }

  // The single-certificate API will only pick up the leaf.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(std::string(kChainTestCertificatePEM) +
                          kChainTestIntermediatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_certificate_file(ctx.get(), file.path().c_str(),
                                             SSL_FILETYPE_PEM));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    STACK_OF(X509) *chain = nullptr;
    ASSERT_TRUE(SSL_CTX_get0_chain_certs(ctx.get(), &chain));
    EXPECT_EQ(sk_X509_num(chain), 0u);
  }

  // If there is already a chain, |SSL_CTX_use_certificate_chain_file| should
  // clear it, not append to it. (Run the function twice.)
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(std::string(kChainTestCertificatePEM) +
                          kChainTestIntermediatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    ASSERT_TRUE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    STACK_OF(X509) *chain = nullptr;
    ASSERT_TRUE(SSL_CTX_get0_chain_certs(ctx.get(), &chain));
    ASSERT_EQ(sk_X509_num(chain), 1u);
    EXPECT_EQ(X509_cmp(ca.get(), sk_X509_value(chain, 0)), 0);
  }

  // If there is already a private key, the key is retained if it matches.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestCertificatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));
    ASSERT_TRUE(SSL_CTX_use_certificate_file(ctx.get(), file.path().c_str(),
                                             SSL_FILETYPE_PEM));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    EXPECT_EQ(SSL_CTX_get0_privatekey(ctx.get()), key.get());
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestCertificatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), key.get()));
    ASSERT_TRUE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    EXPECT_EQ(SSL_CTX_get0_privatekey(ctx.get()), key.get());
  }

  // If the private key does not match, it is silently discarded.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestCertificatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), wrong_key.get()));
    ASSERT_TRUE(SSL_CTX_use_certificate_file(ctx.get(), file.path().c_str(),
                                             SSL_FILETYPE_PEM));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    EXPECT_EQ(SSL_CTX_get0_privatekey(ctx.get()), nullptr);
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestCertificatePEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx.get(), wrong_key.get()));
    ASSERT_TRUE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_EQ(X509_cmp(cert.get(), SSL_CTX_get0_certificate(ctx.get())), 0);
    EXPECT_EQ(SSL_CTX_get0_privatekey(ctx.get()), nullptr);
  }

  // Private keys can be configured from files.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestKeyPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_PrivateKey_file(ctx.get(), file.path().c_str(),
                                            SSL_FILETYPE_PEM));
    EXPECT_EQ(EVP_PKEY_cmp(SSL_CTX_get0_privatekey(ctx.get()), key.get()), 1);
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kChainTestKeyPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    ASSERT_TRUE(SSL_CTX_use_RSAPrivateKey_file(ctx.get(), file.path().c_str(),
                                               SSL_FILETYPE_PEM));
    EXPECT_EQ(EVP_PKEY_cmp(SSL_CTX_get0_privatekey(ctx.get()), key.get()), 1);
  }

  // Empty files are errors.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init());
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(SSL_CTX_use_certificate_file(ctx.get(), file.path().c_str(),
                                             SSL_FILETYPE_PEM));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE));
    ERR_clear_error();
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init());
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE));
    ERR_clear_error();
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init());
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(SSL_CTX_use_PrivateKey_file(ctx.get(), file.path().c_str(),
                                            SSL_FILETYPE_PEM));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE));
    ERR_clear_error();
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init());
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(SSL_CTX_use_RSAPrivateKey_file(ctx.get(), file.path().c_str(),
                                               SSL_FILETYPE_PEM));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_NO_START_LINE));
    ERR_clear_error();
  }

  // As are broken PEM blocks.
  static const char kInvalidPEM[] = "-----BEGIN CERTIFICATE-----\n";
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kInvalidPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(SSL_CTX_use_certificate_file(ctx.get(), file.path().c_str(),
                                              SSL_FILETYPE_PEM));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_BAD_END_LINE));
    ERR_clear_error();
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kInvalidPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_BAD_END_LINE));
    ERR_clear_error();
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kInvalidPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(SSL_CTX_use_PrivateKey_file(ctx.get(), file.path().c_str(),
                                             SSL_FILETYPE_PEM));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_BAD_END_LINE));
    ERR_clear_error();
  }
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(kInvalidPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(SSL_CTX_use_RSAPrivateKey_file(ctx.get(), file.path().c_str(),
                                                SSL_FILETYPE_PEM));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_BAD_END_LINE));
    ERR_clear_error();
  }

  // SSL_CTX_use_certificate_chain_file reads multiple PEM blocks. Errors after
  // the first should be caught.
  {
    TemporaryFile file;
    ASSERT_TRUE(file.Init(std::string(kChainTestCertificatePEM) +
                          kChainTestIntermediatePEM + kInvalidPEM));
    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    ASSERT_TRUE(ctx.get());
    EXPECT_FALSE(
        SSL_CTX_use_certificate_chain_file(ctx.get(), file.path().c_str()));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_PEM, PEM_R_BAD_END_LINE));
    ERR_clear_error();
  }
}

TEST(SSLTest, EmptyWriteBlockedOnHandshakeData) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  // Configure only TLS 1.3. This test requires post-handshake NewSessionTicket.
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(client_ctx.get(), TLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), TLS1_3_VERSION));

  // Connect a client and server with tiny buffer between the two.
  bssl::UniquePtr<SSL> client(SSL_new(client_ctx.get())),
      server(SSL_new(server_ctx.get()));
  ASSERT_TRUE(client);
  ASSERT_TRUE(server);
  SSL_set_connect_state(client.get());
  SSL_set_accept_state(server.get());
  BIO *bio1, *bio2;
  ASSERT_TRUE(BIO_new_bio_pair(&bio1, 1, &bio2, 1));
  SSL_set_bio(client.get(), bio1, bio1);
  SSL_set_bio(server.get(), bio2, bio2);
  ASSERT_TRUE(CompleteHandshakes(client.get(), server.get()));

  // We defer NewSessionTicket to the first write, so the server has a pending
  // NewSessionTicket. See https://boringssl-review.googlesource.com/34948. This
  // means an empty write will flush the ticket. However, the transport only
  // allows one byte through, so this will fail with |SSL_ERROR_WANT_WRITE|.
  int ret = SSL_write(server.get(), nullptr, 0);
  ASSERT_EQ(ret, -1);
  ASSERT_EQ(SSL_get_error(server.get(), ret), SSL_ERROR_WANT_WRITE);

  // Attempting to write non-zero data should not trip |SSL_R_BAD_WRITE_RETRY|.
  const uint8_t kData[] = {'h', 'e', 'l', 'l', 'o'};
  ret = SSL_write(server.get(), kData, sizeof(kData));
  ASSERT_EQ(ret, -1);
  ASSERT_EQ(SSL_get_error(server.get(), ret), SSL_ERROR_WANT_WRITE);

  // Byte by byte, the data should eventually get through.
  uint8_t buf[sizeof(kData)];
  for (;;) {
    ret = SSL_read(client.get(), buf, sizeof(buf));
    ASSERT_EQ(ret, -1);
    ASSERT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_WANT_READ);

    ret = SSL_write(server.get(), kData, sizeof(kData));
    if (ret > 0) {
      ASSERT_EQ(ret, 5);
      break;
    }
    ASSERT_EQ(ret, -1);
    ASSERT_EQ(SSL_get_error(server.get(), ret), SSL_ERROR_WANT_WRITE);
  }

  ret = SSL_read(client.get(), buf, sizeof(buf));
  ASSERT_EQ(ret, static_cast<int>(sizeof(kData)));
  ASSERT_EQ(Bytes(buf, ret), Bytes(kData));
}

// Test that |SSL_ERROR_SYSCALL| continues to work after a close_notify.
TEST(SSLTest, ErrorSyscallAfterCloseNotify) {
  // Make a custom |BIO| where writes fail, but without pushing to the error
  // queue.
  bssl::UniquePtr<BIO_METHOD> method(BIO_meth_new(0, nullptr));
  ASSERT_TRUE(method);
  BIO_meth_set_create(method.get(), [](BIO *b) -> int {
    BIO_set_init(b, 1);
    return 1;
  });
  static bool write_failed = false;
  BIO_meth_set_write(method.get(), [](BIO *, const char *, int) -> int {
    // Fail the operation and don't add to the error queue.
    write_failed = true;
    return -1;
  });
  bssl::UniquePtr<BIO> wbio_silent_error(BIO_new(method.get()));
  ASSERT_TRUE(wbio_silent_error);

  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));

  // Replace the write |BIO| with |wbio_silent_error|.
  SSL_set0_wbio(client.get(), wbio_silent_error.release());

  // Writes should fail. There is nothing in the error queue, so
  // |SSL_ERROR_SYSCALL| indicates the caller needs to check out-of-band.
  const uint8_t data[1] = {0};
  int ret = SSL_write(client.get(), data, sizeof(data));
  EXPECT_EQ(ret, -1);
  EXPECT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_SYSCALL);
  EXPECT_TRUE(write_failed);
  write_failed = false;

  // Send a close_notify from the server. It should return 0 because
  // close_notify was sent, but not received. Confusingly, this is a success
  // output for |SSL_shutdown|'s API.
  EXPECT_EQ(SSL_shutdown(server.get()), 0);

  // Read the close_notify on the client.
  uint8_t buf[1];
  ret = SSL_read(client.get(), buf, sizeof(buf));
  EXPECT_EQ(ret, 0);
  EXPECT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_ZERO_RETURN);

  // Further calls to |SSL_read| continue to report |SSL_ERROR_ZERO_RETURN|.
  ret = SSL_read(client.get(), buf, sizeof(buf));
  EXPECT_EQ(ret, 0);
  EXPECT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_ZERO_RETURN);

  // Although the client has seen close_notify, it should continue to report
  // |SSL_ERROR_SYSCALL| when its writes fail.
  ret = SSL_write(client.get(), data, sizeof(data));
  EXPECT_EQ(ret, -1);
  EXPECT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_SYSCALL);
  EXPECT_TRUE(write_failed);
  write_failed = false;

  // Cause |BIO_write| to fail with a return value of zero instead.
  // |SSL_get_error| should not misinterpret this as a close_notify.
  //
  // This is not actually a correct implementation of |BIO_write|, but the rest
  // of the code treats zero from |BIO_write| as an error, so ensure it does so
  // correctly. Fixing https://crbug.com/boringssl/503 will make this case moot.
  BIO_meth_set_write(method.get(), [](BIO *, const char *, int) -> int {
    write_failed = true;
    return 0;
  });
  ret = SSL_write(client.get(), data, sizeof(data));
  EXPECT_EQ(ret, 0);
  EXPECT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_SYSCALL);
  EXPECT_TRUE(write_failed);
  write_failed = false;
}

// Test that |SSL_shutdown|, when quiet shutdown is enabled, simulates receiving
// a close_notify, down to |SSL_read| reporting |SSL_ERROR_ZERO_RETURN|.
TEST(SSLTest, QuietShutdown) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);
  SSL_CTX_set_quiet_shutdown(server_ctx.get(), 1);
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));

  // Quiet shutdown is enabled, so |SSL_shutdown| on the server should
  // immediately return that bidirectional shutdown "completed".
  EXPECT_EQ(SSL_shutdown(server.get()), 1);

  // Shut down writes so the client gets an EOF.
  EXPECT_TRUE(BIO_shutdown_wr(SSL_get_wbio(server.get())));

  // Confirm no close notify was actually sent. Client reads should report a
  // transport EOF, not a close_notify. (Both have zero return, but
  // |SSL_get_error| is different.)
  char buf[1];
  int ret = SSL_read(client.get(), buf, sizeof(buf));
  EXPECT_EQ(ret, 0);
  EXPECT_EQ(SSL_get_error(client.get(), ret), SSL_ERROR_SYSCALL);

  // The server believes bidirectional shutdown completed, so reads should
  // replay the (simulated) close_notify.
  ret = SSL_read(server.get(), buf, sizeof(buf));
  EXPECT_EQ(ret, 0);
  EXPECT_EQ(SSL_get_error(server.get(), ret), SSL_ERROR_ZERO_RETURN);
}

TEST(SSLTest, InvalidSignatureAlgorithm) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  static const uint16_t kInvalidPrefs[] = {1234};
  EXPECT_FALSE(SSL_CTX_set_signing_algorithm_prefs(ctx.get(), kInvalidPrefs,
                                                   std::size(kInvalidPrefs)));
  EXPECT_FALSE(SSL_CTX_set_verify_algorithm_prefs(ctx.get(), kInvalidPrefs,
                                                  std::size(kInvalidPrefs)));

  static const uint16_t kDuplicatePrefs[] = {SSL_SIGN_RSA_PKCS1_SHA256,
                                             SSL_SIGN_RSA_PKCS1_SHA256};
  EXPECT_FALSE(SSL_CTX_set_signing_algorithm_prefs(ctx.get(), kDuplicatePrefs,
                                                   std::size(kDuplicatePrefs)));
  EXPECT_FALSE(SSL_CTX_set_verify_algorithm_prefs(ctx.get(), kDuplicatePrefs,
                                                  std::size(kDuplicatePrefs)));
}

TEST(SSLTest, InvalidGroups) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);

  static const uint16_t kInvalidIDs[] = {1234};
  EXPECT_FALSE(
      SSL_CTX_set1_group_ids(ctx.get(), kInvalidIDs, std::size(kInvalidIDs)));

  // This is a valid NID, but it is not a valid group.
  static const int kInvalidNIDs[] = {NID_rsaEncryption};
  EXPECT_FALSE(
      SSL_CTX_set1_groups(ctx.get(), kInvalidNIDs, std::size(kInvalidNIDs)));

  // Duplicates are not allowed.
  static const uint16_t kDuplicateIDs[] = {SSL_GROUP_X25519_MLKEM768,
                                           SSL_GROUP_X25519, SSL_GROUP_X25519};
  EXPECT_FALSE(SSL_CTX_set1_group_ids(ctx.get(), kDuplicateIDs,
                                      std::size(kDuplicateIDs)));
  static const int kDuplicateNIDs[] = {NID_X25519, NID_X9_62_prime256v1,
                                       NID_X25519};
  EXPECT_FALSE(SSL_CTX_set1_groups(ctx.get(), kDuplicateNIDs,
                                   std::size(kDuplicateNIDs)));
}

TEST(SSLTest, NameLists) {
  struct {
    size_t (*func)(const char **, size_t);
    std::vector<std::string> expected;
  } kTests[] = {
      {SSL_get_all_version_names, {"TLSv1.3", "DTLSv1.2", "unknown"}},
      {SSL_get_all_standard_cipher_names,
       {"TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256", "TLS_AES_128_GCM_SHA256"}},
      {SSL_get_all_cipher_names,
       {"ECDHE-ECDSA-AES128-GCM-SHA256", "TLS_AES_128_GCM_SHA256", "(NONE)"}},
      {SSL_get_all_group_names, {"P-256", "X25519"}},
      {SSL_get_all_signature_algorithm_names,
       {"rsa_pkcs1_sha256", "ecdsa_secp256r1_sha256", "ecdsa_sha256"}},
  };
  for (const auto &t : kTests) {
    size_t num = t.func(nullptr, 0);
    EXPECT_GT(num, 0u);

    std::vector<const char *> list(num);
    EXPECT_EQ(num, t.func(list.data(), list.size()));

    // Check the expected values are in the list.
    for (const auto &s : t.expected) {
      EXPECT_NE(list.end(), std::find(list.begin(), list.end(), s))
          << "Could not find " << s;
    }

    // Passing in a larger buffer should leave excess space alone.
    std::vector<const char *> list2(num + 1, "placeholder");
    EXPECT_EQ(num, t.func(list2.data(), list2.size()));
    for (size_t i = 0; i < num; i++) {
      EXPECT_STREQ(list[i], list2[i]);
    }
    EXPECT_STREQ(list2.back(), "placeholder");

    // Passing in a shorter buffer should truncate the list.
    for (size_t l = 0; l < num; l++) {
      SCOPED_TRACE(l);
      list2.resize(l);
      EXPECT_EQ(num, t.func(list2.data(), list2.size()));
      for (size_t i = 0; i < l; i++) {
        EXPECT_STREQ(list[i], list2[i]);
      }
    }
  }
}

// Test that it is possible for the certificate to be configured on a mix of
// SSL_CTX and SSL. This ensures that we do not inadvertently overshare objects
// in SSL_new.
TEST(SSLTest, MixContextAndConnection) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(ctx);
  bssl::UniquePtr<X509> cert = GetTestCertificate();
  ASSERT_TRUE(cert);
  bssl::UniquePtr<EVP_PKEY> key = GetTestKey();
  ASSERT_TRUE(key);

  // Configure the certificate, but not the private key, on the context.
  ASSERT_TRUE(SSL_CTX_use_certificate(ctx.get(), cert.get()));

  bssl::UniquePtr<SSL> ssl1(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl1.get());
  bssl::UniquePtr<SSL> ssl2(SSL_new(ctx.get()));
  ASSERT_TRUE(ssl2.get());

  // There is no private key configured yet.
  EXPECT_FALSE(SSL_CTX_get0_privatekey(ctx.get()));
  EXPECT_FALSE(SSL_get_privatekey(ssl1.get()));
  EXPECT_FALSE(SSL_get_privatekey(ssl2.get()));

  // Configuring the private key on |ssl1| works.
  ASSERT_TRUE(SSL_use_PrivateKey(ssl1.get(), key.get()));
  EXPECT_TRUE(SSL_get_privatekey(ssl1.get()));

  // It does not impact the other connection or the context.
  EXPECT_FALSE(SSL_CTX_get0_privatekey(ctx.get()));
  EXPECT_FALSE(SSL_get_privatekey(ssl2.get()));
}

// Test that the server handshake cleanly fails if it had no certificate
// configured, at all versions.
TEST_P(SSLVersionTest, NoCertOrKey) {
  bssl::UniquePtr<X509> cert = GetChainTestCertificate();
  ASSERT_TRUE(cert);
  bssl::UniquePtr<EVP_PKEY> key = GetChainTestKey();
  ASSERT_TRUE(key);
  bssl::UniquePtr<X509> intermediate = GetChainTestIntermediate();
  ASSERT_TRUE(intermediate);
  bssl::UniquePtr<STACK_OF(X509)> chain(sk_X509_new_null());
  ASSERT_TRUE(chain);
  ASSERT_TRUE(bssl::PushToStack(chain.get(), std::move(intermediate)));

  const struct {
    bool has_cert;
    bool has_key;
    bool has_chain;
  } kTests[] = {
      // If nothing is configured, there is unambiguously no certificate.
      {/*has_cert=*/false, /*has_key=*/false, /*has_chain=*/false},

      // If only one of the key and certificate is configured, it is still
      // treated
      // as if there is no certificate.
      {/*has_cert=*/true, /*has_key=*/false, /*has_chain=*/false},
      {/*has_cert=*/false, /*has_key=*/true, /*has_chain=*/false},

      // The key and intermediates may be configured, but without a leaf there
      // is
      // no certificate. This case is interesting because we internally store
      // the
      // chain with a somewhat fragile null fist entry.
      {/*has_cert=*/false, /*has_key=*/true, /*has_chain=*/true},
  };
  for (const auto &t : kTests) {
    SCOPED_TRACE(testing::Message() << "has_cert = " << t.has_cert);
    SCOPED_TRACE(testing::Message() << "has_key = " << t.has_key);
    SCOPED_TRACE(testing::Message() << "has_chain = " << t.has_chain);
    for (bool client : {false, true}) {
      SCOPED_TRACE(testing::Message() << "client = " << client);

      EXPECT_NO_FATAL_FAILURE(ResetContexts());
      if (client) {
        // Request client certificates from the server.
        SSL_CTX_set_verify(server_ctx_.get(), SSL_VERIFY_PEER, nullptr);
        SSL_CTX_set_cert_verify_callback(client_ctx_.get(), VerifySucceed,
                                         nullptr);
      } else {
        // Recreate the server context. ResetContexts automatically adds server
        // certificates.
        server_ctx_ = CreateContext();
        ASSERT_TRUE(server_ctx_);
      }

      SSL_CTX *ctx = client ? client_ctx_.get() : server_ctx_.get();
      if (t.has_cert) {
        ASSERT_TRUE(SSL_CTX_use_certificate(ctx, cert.get()));
      }
      if (t.has_key) {
        ASSERT_TRUE(SSL_CTX_use_PrivateKey(ctx, key.get()));
      }
      if (t.has_chain) {
        ASSERT_TRUE(SSL_CTX_set1_chain(ctx, chain.get()));
      }

      // In each of these cases, |SSL_CTX_check_private_key| should report the
      // certificate was not configured.
      EXPECT_FALSE(SSL_CTX_check_private_key(ctx));
      ERR_clear_error();

      if (client) {
        // The client should cleanly handshake without asserting a certificate.
        EXPECT_TRUE(Connect());
        EXPECT_FALSE(SSL_get0_peer_certificates(server_.get()));
      } else {
        // Servers cannot be anonymous. The connection should fail.
        EXPECT_FALSE(Connect());
        // Depending on the TLS version, this should either appear as
        // NO_SHARED_CIPHER (TLS 1.2) or NO_CERTIFICATE_SET (TLS 1.3).
        uint32_t err = ERR_get_error();
        if (!ErrorEquals(err, ERR_LIB_SSL, SSL_R_NO_SHARED_CIPHER)) {
          EXPECT_TRUE(ErrorEquals(err, ERR_LIB_SSL, SSL_R_NO_CERTIFICATE_SET));
        }
      }
    }
  }
}

TEST_P(SSLVersionTest, KeyLog) {
  using KeyLog = std::map<std::string, std::vector<uint8_t>>;
  KeyLog client_log, server_log;

  SSL_CTX_set_app_data(client_ctx_.get(), &client_log);
  SSL_CTX_set_app_data(server_ctx_.get(), &server_log);

  auto keylog_callback = [](const SSL *ssl, const char *line) {
    SSL_CTX *ctx = SSL_get_SSL_CTX(ssl);
    KeyLog *log = static_cast<KeyLog *>(SSL_CTX_get_app_data(ctx));
    ASSERT_TRUE(log);

    const char *space1 = strchr(line, ' ');
    ASSERT_TRUE(space1);
    std::string name(line, space1 - line);
    space1++;
    const char *space2 = strchr(space1, ' ');
    ASSERT_TRUE(space2);
    bssl::Span<const char> client_random_hex(space1, space2 - space1);
    space2++;
    bssl::Span<const char> secret_hex(space2, strlen(space2));

    std::vector<uint8_t> client_random, secret;
    ASSERT_TRUE(DecodeLowerHex(&client_random, client_random_hex));
    ASSERT_TRUE(DecodeLowerHex(&secret, secret_hex));

    // The client_random field identifies the connection. Check it matches
    // the connection.
    uint8_t expected_random[SSL3_RANDOM_SIZE];
    ASSERT_EQ(
        sizeof(expected_random),
        SSL_get_client_random(ssl, expected_random, sizeof(expected_random)));
    ASSERT_EQ(Bytes(expected_random), Bytes(client_random));

    ASSERT_EQ(log->count(name), 0u) << "duplicate name " << name;
    log->emplace(std::move(name), std::move(secret));
  };
  SSL_CTX_set_keylog_callback(client_ctx_.get(), keylog_callback);
  SSL_CTX_set_keylog_callback(server_ctx_.get(), keylog_callback);

  // Connect and capture the various secrets.
  ASSERT_TRUE(Connect());

  // Check that we logged the secrets we expected to log.
  if (is_tls13()) {
    EXPECT_THAT(client_log, ElementsAre(Key("CLIENT_HANDSHAKE_TRAFFIC_SECRET"),
                                        Key("CLIENT_TRAFFIC_SECRET_0"),
                                        Key("EXPORTER_SECRET"),
                                        Key("SERVER_HANDSHAKE_TRAFFIC_SECRET"),
                                        Key("SERVER_TRAFFIC_SECRET_0")));

    Span<const uint8_t> read_secret, write_secret;
    if (is_dtls()) {
      // The first application data epoch is 3.
      const uint8_t *data;
      size_t len;
      ASSERT_TRUE(SSL_get_dtls_read_traffic_secret(client_.get(), &data, &len,
                                                   /*epoch=*/3));
      read_secret = Span(data, len);
      ASSERT_TRUE(SSL_get_dtls_write_traffic_secret(client_.get(), &data, &len,
                                                   /*epoch=*/3));
      write_secret = Span(data, len);
    } else {
      ASSERT_TRUE(
          SSL_get_traffic_secrets(client_.get(), &read_secret, &write_secret));
    }
    // Ideally we'd check the other values, but those are harder to check
    // without actually decrypting the records.
    EXPECT_EQ(Bytes(read_secret), Bytes(client_log["SERVER_TRAFFIC_SECRET_0"]));
    EXPECT_EQ(Bytes(write_secret),
              Bytes(client_log["CLIENT_TRAFFIC_SECRET_0"]));
  } else {
    EXPECT_THAT(client_log, ElementsAre(Key("CLIENT_RANDOM")));

    size_t len =
        SSL_SESSION_get_master_key(SSL_get0_session(client_.get()), nullptr, 0);
    std::vector<uint8_t> expected(len);
    ASSERT_EQ(SSL_SESSION_get_master_key(SSL_get0_session(client_.get()),
                                         expected.data(), expected.size()),
              expected.size());
    EXPECT_EQ(Bytes(expected), Bytes(client_log["CLIENT_RANDOM"]));
  }

  // The server should have logged the same secrets as the client.
  EXPECT_EQ(client_log, server_log);
}

TEST_P(SSLVersionTest, GetTrafficSecrets) {
  ASSERT_TRUE(Connect());

  Span<const uint8_t> client_read, client_write, server_read, server_write;
  bool client_ok =
      SSL_get_traffic_secrets(client_.get(), &client_read, &client_write);
  bool server_ok =
      SSL_get_traffic_secrets(server_.get(), &server_read, &server_write);
  if (!is_dtls() && version() >= TLS1_3_VERSION) {
    ASSERT_TRUE(client_ok);
    ASSERT_TRUE(server_ok);
    EXPECT_EQ(Bytes(client_read), Bytes(server_write));
    EXPECT_EQ(Bytes(server_read), Bytes(client_write));
  } else {
    EXPECT_FALSE(client_ok);
    EXPECT_FALSE(server_ok);
  }
}

TEST_P(SSLVersionTest, GetIVs) {
  std::vector<const char *> ciphers;
  if (version() == TLS1_2_VERSION || version() == DTLS1_2_VERSION) {
    // Try both CBC and AEAD ciphers.
    ciphers = {"TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA",
               "TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256"};
  } else {
    // The defaults are fine to test. In 1.0 and 1.1, all remaining supported
    // ciphers are CBC. In 1.3, all ciphers are AEADs.
    ciphers = {"ALL"};
  }

  for (const char *cipher : ciphers) {
    SCOPED_TRACE(cipher);

    ASSERT_NO_FATAL_FAILURE(ResetContexts());
    ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(client_ctx_.get(), cipher));
    ASSERT_TRUE(SSL_CTX_set_strict_cipher_list(server_ctx_.get(), cipher));
    ASSERT_TRUE(Connect());

    const uint8_t *client_read_iv, *client_write_iv, *server_read_iv,
        *server_write_iv;
    size_t client_iv_len, server_iv_len;
    bool client_ivs_ok = SSL_get_ivs(client_.get(), &client_read_iv,
                                     &client_write_iv, &client_iv_len);
    bool server_ivs_ok = SSL_get_ivs(server_.get(), &server_read_iv,
                                     &server_write_iv, &server_iv_len);

    // Only TLS 1.0 should support |SSL_get_ivs|. Other cases should cleanly
    // fail this operation.
    if (version() == TLS1_VERSION) {
      ASSERT_TRUE(client_ivs_ok);
      ASSERT_TRUE(server_ivs_ok);
      EXPECT_EQ(Bytes(client_write_iv, client_iv_len),
                Bytes(server_read_iv, server_iv_len));
      EXPECT_EQ(Bytes(client_read_iv, client_iv_len),
                Bytes(server_write_iv, server_iv_len));
    } else {
      EXPECT_FALSE(client_ivs_ok);
      EXPECT_FALSE(server_ivs_ok);
    }
  }
}

TEST(SSLTest, EarlyDataVersionMismatch) {
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(TLS_method()));
  ASSERT_TRUE(client_ctx);
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(server_ctx);
  SSL_CTX_set_early_data_enabled(client_ctx.get(), 1);
  SSL_CTX_set_early_data_enabled(server_ctx.get(), 1);
  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx.get(), SSL_SESS_CACHE_BOTH);

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx.get(), server_ctx.get());
  ASSERT_TRUE(session);
  EXPECT_TRUE(SSL_SESSION_early_data_capable(session.get()));

  // Turn off TLS 1.3 at the server.
  SSL_CTX_set_max_proto_version(server_ctx.get(), TLS1_2_VERSION);
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                    server_ctx.get()));
  SSL_set_session(client.get(), session.get());

  // Send the ClientHello. The client should immediately treat the handshake as
  // successful and offer early data.
  EXPECT_EQ(1, SSL_do_handshake(client.get()));
  EXPECT_TRUE(SSL_in_early_data(client.get()));

  // In the early data state, we report the predicted version, so that callers
  // see self-consistent connection properties.
  EXPECT_EQ(SSL_version(client.get()), TLS1_3_VERSION);
  EXPECT_NE(SSL_get0_peer_certificates(client.get()), nullptr);

  // Read the ClientHello and send the ServerHello. The server will (implicitly
  // by negotiating TLS 1.2) reject early data.
  EXPECT_EQ(-1, SSL_do_handshake(server.get()));
  EXPECT_EQ(SSL_ERROR_WANT_READ, SSL_get_error(server.get(), -1));

  // Read the ServerHello. The client will now see the ServerHello and report a
  // version mismatch. Unlike other 0-RTT rejections, this is fatal, because a
  // TLS 1.2 server cannot recover from 0-RTT rejection.
  EXPECT_EQ(-1, SSL_do_handshake(client.get()));
  EXPECT_EQ(SSL_ERROR_SSL, SSL_get_error(client.get(), -1));
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                          SSL_R_WRONG_VERSION_ON_EARLY_DATA));

  // |SSL_version| should continue reporting self-consistent state until the
  // caller calls |SSL_reset_early_data_reject|.
  //
  // TLS 1.3 to TLS 1.2 is not the most interesting version-related 0-RTT
  // rejection because it is fatal to the connection anyway. Once there are two
  // post-TLS-1.3 versions, or if we implement DTLS 1.3 0-RTT (where a DTLS 1.2
  // server will skip over early data naturally), those will make for better
  // tests. In particular, early_data accept is signaled in EncryptedExtensions,
  // but the new version is learned at ServerHello. Though an implementation
  // could already infer based on the version that early data will be rejected.
  EXPECT_EQ(SSL_version(client.get()), TLS1_3_VERSION);
  EXPECT_NE(SSL_get0_peer_certificates(client.get()), nullptr);
}

TEST(SSLTest, EarlyDataDisabledInDTLS13) {
  // Set up some 0-RTT-enabled contexts.
  bssl::UniquePtr<SSL_CTX> client_ctx(SSL_CTX_new(DTLS_method()));
  bssl::UniquePtr<SSL_CTX> server_ctx =
      CreateContextWithTestCertificate(DTLS_method());
  ASSERT_TRUE(client_ctx);
  ASSERT_TRUE(server_ctx);

  SSL_CTX_set_early_data_enabled(client_ctx.get(), true);
  SSL_CTX_set_early_data_enabled(server_ctx.get(), true);
  SSL_CTX_set_session_cache_mode(client_ctx.get(), SSL_SESS_CACHE_BOTH);
  SSL_CTX_set_session_cache_mode(server_ctx.get(), SSL_SESS_CACHE_BOTH);
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(client_ctx.get(), DTLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(client_ctx.get(), DTLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_min_proto_version(server_ctx.get(), DTLS1_3_VERSION));
  ASSERT_TRUE(SSL_CTX_set_max_proto_version(server_ctx.get(), DTLS1_3_VERSION));

  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(client_ctx.get(), server_ctx.get());
  ASSERT_TRUE(session);
  EXPECT_FALSE(SSL_SESSION_early_data_capable(session.get()));
}

// ID-only TLS 1.3 sessions are impossible and should not be resumable.
TEST(SSLTest, IDOnlyTLS13Session) {
  bssl::UniquePtr<SSL_CTX> ctx = CreateContextWithTestCertificate(TLS_method());
  ASSERT_TRUE(ctx);
  SSL_CTX_set_session_cache_mode(ctx.get(),
                                 SSL_SESS_CACHE_CLIENT | SSL_SESS_CACHE_SERVER);

  ASSERT_TRUE(SSL_CTX_set_max_proto_version(ctx.get(), TLS1_3_VERSION));
  bssl::UniquePtr<SSL_SESSION> session =
      CreateClientSession(ctx.get(), ctx.get());
  ASSERT_TRUE(session);
  EXPECT_TRUE(SSL_SESSION_is_resumable(session.get()));

  session->ticket.Reset();
  session->session_id.Resize(32);
  EXPECT_FALSE(SSL_SESSION_is_resumable(session.get()));
}

TEST(SSLTest, DTLSReadTimeoutExpired) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(DTLS_method()));
  ASSERT_TRUE(ctx);

  // Mock the clock.
  g_current_time.tv_sec = 1000;
  SSL_CTX_set_current_time_cb(ctx.get(), CurrentTimeCallback);
  auto advance = [](timeval delta) {
    g_current_time.tv_sec += delta.tv_sec;
    g_current_time.tv_usec += delta.tv_usec;
    if (g_current_time.tv_usec >= 1000000) {
      g_current_time.tv_usec -= 1000000;
      g_current_time.tv_sec++;
    }
  };

  // Create a client and don't connect it to anything.
  bssl::UniquePtr<SSL> client(SSL_new(ctx.get()));
  ASSERT_TRUE(client);
  SSL_set_connect_state(client.get());
  bssl::UniquePtr<BIO> rbio(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(rbio);
  SSL_set0_rbio(client.get(), rbio.release());
  bssl::UniquePtr<BIO> wbio(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(wbio);
  SSL_set0_wbio(client.get(), wbio.release());

  // Write the ClientHello and wait for a ServerHello.
  EXPECT_EQ(SSL_do_handshake(client.get()), -1);
  EXPECT_EQ(SSL_get_error(client.get(), -1), SSL_ERROR_WANT_READ);

  for (;;) {
    // There should be a retransmit timer.
    timeval timeout;
    ASSERT_TRUE(DTLSv1_get_timeout(client.get(), &timeout));
    EXPECT_TRUE(timeout.tv_sec != 0 || timeout.tv_usec != 0);

    // Retransmit. At some point, the client will give up and fail.
    advance(timeout);
    int ret = DTLSv1_handle_timeout(client.get());
    if (ret < 0) {
      break;
    }
    ASSERT_EQ(ret, 1);
  }

  // The retransmit should have failed with |SSL_R_READ_TIMEOUT_EXPIRED|.
  EXPECT_EQ(SSL_get_error(client.get(), -1), SSL_ERROR_SSL);
  EXPECT_TRUE(
      ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_READ_TIMEOUT_EXPIRED));

  // There should not continue to be a timeout. Otherwise, a caller that forgets
  // to check |DTLSv1_handle_timeout|'s error will infinite loop. See
  // https://crbug.com/42224241.
  timeval timeout;
  EXPECT_FALSE(DTLSv1_get_timeout(client.get(), &timeout));

  // The error should also be returned from |SSL_do_handshake|. This ensures
  // that, if the caller missed the return from |DTLSv1_handle_timeout|, it will
  // be picked up from a more normal codepath.
  EXPECT_EQ(SSL_do_handshake(client.get()), -1);
  EXPECT_EQ(SSL_get_error(client.get(), -1), SSL_ERROR_SSL);
  EXPECT_TRUE(
      ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_READ_TIMEOUT_EXPIRED));
}

TEST(SSLTest, SetGetCompliancePolicy) {
  bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
  EXPECT_EQ(SSL_CTX_get_compliance_policy(ctx.get()),
            ssl_compliance_policy_none);

  bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
  EXPECT_EQ(SSL_get_compliance_policy(ssl.get()), ssl_compliance_policy_none);

  for (const auto policy : {ssl_compliance_policy_fips_202205,      //
                            ssl_compliance_policy_wpa3_192_202304,  //
                            ssl_compliance_policy_cnsa_202407}) {
    SSL_CTX_set_compliance_policy(ctx.get(), policy);
    EXPECT_EQ(SSL_CTX_get_compliance_policy(ctx.get()), policy);
    SSL_set_compliance_policy(ssl.get(), policy);
    EXPECT_EQ(SSL_get_compliance_policy(ssl.get()), policy);
  }
}

TEST(SSLTest, ParseClientHello) {
  for (bool dtls : {false, true}) {
    SCOPED_TRACE(dtls);
    bssl::UniquePtr<SSL_CTX> ctx(
        SSL_CTX_new(dtls ? DTLS_method() : TLS_method()));
    ASSERT_TRUE(ctx);
    bssl::UniquePtr<SSL> ssl(SSL_new(ctx.get()));
    ASSERT_TRUE(ssl);

    // From draft-ietf-tls-tls13-vectors-06, Section 7, annotated.
    static const uint8_t kClientHelloTLS[] = {
        // legacy_version
        0x03, 0x03,
        // random
        0x37, 0xb0, 0x76, 0xd2, 0xfa, 0x50, 0x94, 0x39, 0x5e, 0x99, 0x71, 0xd7,
        0x53, 0xc3, 0xc4, 0xcf, 0x07, 0x56, 0xb9, 0x40, 0x70, 0x13, 0xcb, 0xca,
        0xc7, 0xf4, 0x4a, 0xc3, 0x28, 0x13, 0xf6, 0x0f,
        // legacy_session_id
        0x20, 0x91, 0x41, 0xb7, 0x89, 0x83, 0xd3, 0x67, 0xa0, 0xfe, 0x97, 0x08,
        0xdf, 0x32, 0xf5, 0xb9, 0x88, 0x8f, 0xe5, 0x9e, 0xde, 0x4e, 0x61, 0x2c,
        0xf6, 0xbd, 0xb1, 0xfb, 0xbe, 0xe6, 0xf9, 0xef, 0xfe,
        // cipher_suites
        0x00, 0x06, 0x13, 0x01, 0x13, 0x03, 0x13, 0x02,
        // legacy_compression_methods
        0x01, 0x00,
        // extensions
        0x00, 0x8d,
        // server_name
        0x00, 0x00, 0x00, 0x0b, 0x00, 0x09, 0x00, 0x00, 0x06, 0x73, 0x65, 0x72,
        0x76, 0x65, 0x72,
        // renegotiation_info
        0xff, 0x01, 0x00, 0x01, 0x00,
        // supported_groups
        0x00, 0x0a, 0x00, 0x14, 0x00, 0x12, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18,
        0x00, 0x19, 0x01, 0x00, 0x01, 0x01, 0x01, 0x02, 0x01, 0x03, 0x01, 0x04,
        // key_share
        0x00, 0x33, 0x00, 0x26, 0x00, 0x24, 0x00, 0x1d, 0x00, 0x20, 0xd5, 0x15,
        0x42, 0x62, 0x5f, 0x25, 0xa9, 0x2d, 0x44, 0xa3, 0xaa, 0xde, 0xf5, 0x9c,
        0xa8, 0x49, 0xad, 0x2f, 0x8e, 0xfa, 0x9f, 0x04, 0xb8, 0xf5, 0xda, 0xb4,
        0x02, 0xac, 0xbc, 0x57, 0x1f, 0x16,
        // supported_versions
        0x00, 0x2b, 0x00, 0x03, 0x02, 0x03, 0x04,
        // signature_algorithms
        0x00, 0x0d, 0x00, 0x20, 0x00, 0x1e, 0x04, 0x03, 0x05, 0x03, 0x06, 0x03,
        0x02, 0x03, 0x08, 0x04, 0x08, 0x05, 0x08, 0x06, 0x04, 0x01, 0x05, 0x01,
        0x06, 0x01, 0x02, 0x01, 0x04, 0x02, 0x05, 0x02, 0x06, 0x02, 0x02, 0x02,
        // psk_key_exchange_modes
        0x00, 0x2d, 0x00, 0x02, 0x01, 0x01,
        // record_size_limit
        0x00, 0x1c, 0x00, 0x02, 0x40, 0x01};
    // The above, modified for DTLS 1.3. (Versions switched to DTLS spelling, a
    // cookie added.)
    static const uint8_t kClientHelloDTLS[] = {
        // legacy_version
        0xfe, 0xfd,
        // random
        0x37, 0xb0, 0x76, 0xd2, 0xfa, 0x50, 0x94, 0x39, 0x5e, 0x99, 0x71, 0xd7,
        0x53, 0xc3, 0xc4, 0xcf, 0x07, 0x56, 0xb9, 0x40, 0x70, 0x13, 0xcb, 0xca,
        0xc7, 0xf4, 0x4a, 0xc3, 0x28, 0x13, 0xf6, 0x0f,
        // legacy_session_id
        0x20, 0x91, 0x41, 0xb7, 0x89, 0x83, 0xd3, 0x67, 0xa0, 0xfe, 0x97, 0x08,
        0xdf, 0x32, 0xf5, 0xb9, 0x88, 0x8f, 0xe5, 0x9e, 0xde, 0x4e, 0x61, 0x2c,
        0xf6, 0xbd, 0xb1, 0xfb, 0xbe, 0xe6, 0xf9, 0xef, 0xfe,
        // legacy_cookie
        0x04, 0x01, 0x02, 0x03, 0x04,
        // cipher_suites
        0x00, 0x06, 0x13, 0x01, 0x13, 0x03, 0x13, 0x02,
        // legacy_compression_methods
        0x01, 0x00,
        // extensions
        0x00, 0x8d,
        // server_name
        0x00, 0x00, 0x00, 0x0b, 0x00, 0x09, 0x00, 0x00, 0x06, 0x73, 0x65, 0x72,
        0x76, 0x65, 0x72,
        // renegotiation_info
        0xff, 0x01, 0x00, 0x01, 0x00,
        // supported_groups
        0x00, 0x0a, 0x00, 0x14, 0x00, 0x12, 0x00, 0x1d, 0x00, 0x17, 0x00, 0x18,
        0x00, 0x19, 0x01, 0x00, 0x01, 0x01, 0x01, 0x02, 0x01, 0x03, 0x01, 0x04,
        // key_share
        0x00, 0x33, 0x00, 0x26, 0x00, 0x24, 0x00, 0x1d, 0x00, 0x20, 0xd5, 0x15,
        0x42, 0x62, 0x5f, 0x25, 0xa9, 0x2d, 0x44, 0xa3, 0xaa, 0xde, 0xf5, 0x9c,
        0xa8, 0x49, 0xad, 0x2f, 0x8e, 0xfa, 0x9f, 0x04, 0xb8, 0xf5, 0xda, 0xb4,
        0x02, 0xac, 0xbc, 0x57, 0x1f, 0x16,
        // supported_versions
        0x00, 0x2b, 0x00, 0x03, 0x02, 0xfe, 0xfc,
        // signature_algorithms
        0x00, 0x0d, 0x00, 0x20, 0x00, 0x1e, 0x04, 0x03, 0x05, 0x03, 0x06, 0x03,
        0x02, 0x03, 0x08, 0x04, 0x08, 0x05, 0x08, 0x06, 0x04, 0x01, 0x05, 0x01,
        0x06, 0x01, 0x02, 0x01, 0x04, 0x02, 0x05, 0x02, 0x06, 0x02, 0x02, 0x02,
        // psk_key_exchange_modes
        0x00, 0x2d, 0x00, 0x02, 0x01, 0x01,
        // record_size_limit
        0x00, 0x1c, 0x00, 0x02, 0x40, 0x01};

    auto in = dtls ? Span<const uint8_t>(kClientHelloDTLS)
                   : Span<const uint8_t>(kClientHelloTLS);
    SSL_CLIENT_HELLO client_hello;
    ASSERT_TRUE(
        SSL_parse_client_hello(ssl.get(), &client_hello, in.data(), in.size()));
    EXPECT_EQ(client_hello.ssl, ssl.get());
    EXPECT_EQ(Bytes(client_hello.client_hello, client_hello.client_hello_len),
              Bytes(in));
    EXPECT_EQ(client_hello.version, dtls ? DTLS1_2_VERSION : TLS1_2_VERSION);
    static const uint8_t kRandom[] = {
        0x37, 0xb0, 0x76, 0xd2, 0xfa, 0x50, 0x94, 0x39, 0x5e, 0x99, 0x71,
        0xd7, 0x53, 0xc3, 0xc4, 0xcf, 0x07, 0x56, 0xb9, 0x40, 0x70, 0x13,
        0xcb, 0xca, 0xc7, 0xf4, 0x4a, 0xc3, 0x28, 0x13, 0xf6, 0x0f};
    EXPECT_EQ(Bytes(client_hello.random, client_hello.random_len),
              Bytes(kRandom));
    static const uint8_t kSessionID[] = {
        0x91, 0x41, 0xb7, 0x89, 0x83, 0xd3, 0x67, 0xa0, 0xfe, 0x97, 0x08,
        0xdf, 0x32, 0xf5, 0xb9, 0x88, 0x8f, 0xe5, 0x9e, 0xde, 0x4e, 0x61,
        0x2c, 0xf6, 0xbd, 0xb1, 0xfb, 0xbe, 0xe6, 0xf9, 0xef, 0xfe};
    EXPECT_EQ(Bytes(client_hello.session_id, client_hello.session_id_len),
              Bytes(kSessionID));
    if (dtls) {
      static const uint8_t kCookie[] = {0x01, 0x02, 0x03, 0x04};
      EXPECT_EQ(Bytes(client_hello.dtls_cookie, client_hello.dtls_cookie_len),
                Bytes(kCookie));
    } else {
      EXPECT_EQ(client_hello.dtls_cookie, nullptr);
      EXPECT_EQ(client_hello.dtls_cookie_len, 0u);
    }
    static const uint8_t kCipherSuites[] = {0x13, 0x01, 0x13, 0x03, 0x13, 0x02};
    EXPECT_EQ(Bytes(client_hello.cipher_suites, client_hello.cipher_suites_len),
              Bytes(kCipherSuites));
    static const uint8_t kCompressionMethods[] = {0x00};
    EXPECT_EQ(Bytes(client_hello.compression_methods,
                    client_hello.compression_methods_len),
              Bytes(kCompressionMethods));
    auto extensions = in.last(141);
    EXPECT_EQ(Bytes(client_hello.extensions, client_hello.extensions_len),
              Bytes(extensions));

    static const uint8_t kServerName[] = {0x00, 0x09, 0x00, 0x00, 0x06, 0x73,
                                          0x65, 0x72, 0x76, 0x65, 0x72};
    const uint8_t *data;
    size_t len;
    ASSERT_TRUE(SSL_early_callback_ctx_extension_get(
        &client_hello, TLSEXT_TYPE_server_name, &data, &len));
    EXPECT_EQ(Bytes(data, len), Bytes(kServerName));
    EXPECT_FALSE(SSL_early_callback_ctx_extension_get(
        &client_hello, TLSEXT_TYPE_encrypted_client_hello, &data, &len));

    // Trailing data should be rejected.
    std::vector<uint8_t> trailing_data(in.begin(), in.end());
    trailing_data.push_back(0);
    EXPECT_FALSE(SSL_parse_client_hello(
        ssl.get(), &client_hello, trailing_data.data(), trailing_data.size()));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                            SSL_R_CLIENTHELLO_PARSE_FAILED));
    ERR_clear_error();

    // Other invalid inputs.
    static const uint8_t kInvalid[] = {'n', 'o', 'p', 'e'};
    EXPECT_FALSE(SSL_parse_client_hello(ssl.get(), &client_hello, kInvalid,
                                        sizeof(kInvalid)));
    EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL,
                            SSL_R_CLIENTHELLO_PARSE_FAILED));
    ERR_clear_error();
  }
}

class SSLPAKETest : public testing::Test {
 public:
  static Span<const uint8_t> pake_context() {
    return StringAsBytes("test context");
  }
  static Span<const uint8_t> client_identity() {
    return StringAsBytes("client");
  }
  static Span<const uint8_t> server_identity() {
    return StringAsBytes("client");
  }

  static UniquePtr<SSL_CTX> NewClientContext(std::string_view password,
                                             uint32_t attempts) {
    auto reg = Register(password);
    if (!reg) {
      return nullptr;
    }

    UniquePtr<SSL_CREDENTIAL> cred(SSL_CREDENTIAL_new_spake2plusv1_client(
        pake_context().data(), pake_context().size(), client_identity().data(),
        client_identity().size(), server_identity().data(),
        server_identity().size(), attempts, reg->pw_verifier_w0,
        sizeof(reg->pw_verifier_w0), reg->pw_verifier_w1,
        sizeof(reg->pw_verifier_w1)));
    if (cred == nullptr) {
      return nullptr;
    }

    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    if (ctx == nullptr || !SSL_CTX_add1_credential(ctx.get(), cred.get())) {
      return nullptr;
    }
    return ctx;
  }

  static UniquePtr<SSL_CTX> NewServerContext(std::string_view password,
                                             uint32_t attempts) {
    auto reg = Register(password);
    if (!reg) {
      return nullptr;
    }

    UniquePtr<SSL_CREDENTIAL> cred(SSL_CREDENTIAL_new_spake2plusv1_server(
        pake_context().data(), pake_context().size(), client_identity().data(),
        client_identity().size(), server_identity().data(),
        server_identity().size(), attempts, reg->pw_verifier_w0,
        sizeof(reg->pw_verifier_w0), reg->registration_record,
        sizeof(reg->registration_record)));
    if (cred == nullptr) {
      return nullptr;
    }

    bssl::UniquePtr<SSL_CTX> ctx(SSL_CTX_new(TLS_method()));
    if (ctx == nullptr || !SSL_CTX_add1_credential(ctx.get(), cred.get())) {
      return nullptr;
    }
    return ctx;
  }

 private:
  struct PAKERegistration {
    uint8_t pw_verifier_w0[32];
    uint8_t pw_verifier_w1[32];
    uint8_t registration_record[65];
  };

  static std::optional<PAKERegistration> Register(std::string_view password) {
    auto password_bytes = StringAsBytes(password);
    PAKERegistration ret;
    if (!SSL_spake2plusv1_register(
            ret.pw_verifier_w0, ret.pw_verifier_w1, ret.registration_record,
            password_bytes.data(), password_bytes.size(),
            client_identity().data(), client_identity().size(),
            server_identity().data(), server_identity().size())) {
      return std::nullopt;
    }
    return ret;
  }
};

TEST_F(SSLPAKETest, SPAKE2PLUS) {
  UniquePtr<SSL_CTX> client_ctx = NewClientContext("password", 1);
  ASSERT_TRUE(client_ctx);
  UniquePtr<SSL_CTX> server_ctx = NewServerContext("password", 1);
  ASSERT_TRUE(server_ctx);
  bssl::UniquePtr<SSL> client, server;
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx.get()));
}

TEST_F(SSLPAKETest, ClientLimit) {
  static constexpr uint32_t kLimit = 5;
  static constexpr uint32_t kUnlimited = UINT32_MAX;

  UniquePtr<SSL_CTX> client_ctx = NewClientContext("password", kLimit);
  ASSERT_TRUE(client_ctx);
  UniquePtr<SSL_CTX> server_ctx_good = NewServerContext("password", kUnlimited);
  ASSERT_TRUE(server_ctx_good);
  UniquePtr<SSL_CTX> server_ctx_bad = NewServerContext("wrong", kUnlimited);
  ASSERT_TRUE(server_ctx_bad);

  // The client sees confirmV before revealing a password confirmation, so
  // neither successful nor unfinished handshakes contribute to the limit.
  bssl::UniquePtr<SSL> client, server;
  for (uint32_t i = 0; i < kLimit * 2; i++) {
    // Unfinished handshake.
    ASSERT_TRUE(CreateClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx_good.get()));
    ASSERT_EQ(SSL_do_handshake(client.get()), -1);  // Write ClientHello.
    ASSERT_EQ(SSL_get_error(client.get(), -1), SSL_ERROR_WANT_READ);

    // Successful handshake.
    ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                       server_ctx_good.get()));
  }

  // After kLimit - 1 password mismatches, the credential still functions.
  for (uint32_t i = 0; i < kLimit - 1; i++) {
    ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                        server_ctx_bad.get()));
  }
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                     server_ctx_good.get()));

  // But after one more password mismatch...
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx_bad.get()));

  // ...the client should refuse to use the credential at all.
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx.get(),
                                      server_ctx_good.get()));
  ASSERT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_PAKE_EXHAUSTED));
}

TEST_F(SSLPAKETest, ServerLimit) {
  static constexpr uint32_t kLimit = 5;
  static constexpr uint32_t kUnlimited = UINT32_MAX;

  UniquePtr<SSL_CTX> server_ctx = NewServerContext("password", kLimit);
  ASSERT_TRUE(server_ctx);
  UniquePtr<SSL_CTX> client_ctx_good = NewClientContext("password", kUnlimited);
  ASSERT_TRUE(client_ctx_good);
  UniquePtr<SSL_CTX> client_ctx_bad = NewClientContext("wrong", kUnlimited);
  ASSERT_TRUE(client_ctx_bad);

  // Successful handshakes do not (indefinitely) contribute to the limit. If the
  // server sees one good handshake at a time, the limit does not impact it.
  bssl::UniquePtr<SSL> client, server;
  for (uint32_t i = 0; i < kLimit * 2; i++) {
    ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                       server_ctx.get()));
  }

  // The server sends confirmV before confirming the client knew the password,
  // so any handshake in between ClientHello and ServerHello counts towards the
  // limit.
  struct ClientServerPair {
    bssl::UniquePtr<SSL> client, server;
  };
  std::vector<ClientServerPair> pending;
  auto handshake_up_to_serverhello = [](ClientServerPair *pair) {
    // Send ClientHello.
    ASSERT_EQ(SSL_do_handshake(pair->client.get()), -1);
    ASSERT_EQ(SSL_get_error(pair->client.get(), -1), SSL_ERROR_WANT_READ);
    // Send ServerHello..Finished.
    ASSERT_EQ(SSL_do_handshake(pair->server.get()), -1);
    ASSERT_EQ(SSL_get_error(pair->server.get(), -1), SSL_ERROR_WANT_READ);
  };

  // First, go just under the limit.
  for (uint32_t i = 0; i < kLimit - 1; i++) {
    ClientServerPair pair;
    ASSERT_TRUE(CreateClientAndServer(&pair.client, &pair.server,
                                      client_ctx_good.get(), server_ctx.get()));
    ASSERT_NO_FATAL_FAILURE(handshake_up_to_serverhello(&pair));
    pending.push_back(std::move(pair));
  }

  // The server can still complete a handshake.
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                     server_ctx.get()));

  // Start one more unfinished handshake.
  ClientServerPair pair;
  ASSERT_TRUE(CreateClientAndServer(&pair.client, &pair.server,
                                    client_ctx_good.get(), server_ctx.get()));
  ASSERT_NO_FATAL_FAILURE(handshake_up_to_serverhello(&pair));
  pending.push_back(std::move(pair));

  // The credential is at its limit.
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                      server_ctx.get()));
  ASSERT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_PAKE_EXHAUSTED));

  // Complete some of the handshakes. As they complete, the server learns that
  // the client had the correct guess, so the connections no longer count
  // towards the brute force limit.
  static constexpr uint32_t kRemainingLimit = kLimit / 2;
  for (uint32_t i = 0; i < kRemainingLimit; i++) {
    ASSERT_TRUE(CompleteHandshakes(pending.back().client.get(),
                                   pending.back().server.get()));
    pending.pop_back();
  }

  // The server can complete a handshake now that some of the limit has been
  // released.
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                     server_ctx.get()));

  // Failed handshakes consume the limit. First consume all but one of the newly
  // released limit.
  for (uint32_t i = 0; i < kRemainingLimit - 1; i++) {
    ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx_bad.get(),
                                        server_ctx.get()));
  }
  ASSERT_TRUE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                     server_ctx.get()));

  // Consume the last of the limit.
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx_bad.get(),
                                      server_ctx.get()));
  // The credential is disabled again.
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                      server_ctx.get()));
  ASSERT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_PAKE_EXHAUSTED));

  // The unfinished handshakes continue to count toward the limit even if they
  // are destroyed.
  pending.clear();
  ASSERT_FALSE(ConnectClientAndServer(&client, &server, client_ctx_good.get(),
                                      server_ctx.get()));
  ASSERT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_SSL, SSL_R_PAKE_EXHAUSTED));
}

#if defined(OPENSSL_THREADS)
// The PAKE limit mechanism should be thread-safe.
TEST_F(SSLPAKETest, ClientThreads) {
  static constexpr uint32_t kLimit = 5;
  static constexpr uint32_t kUnlimited = UINT32_MAX;
  static constexpr int kThreads = 10;

  UniquePtr<SSL_CTX> client_ctx = NewClientContext("password", kLimit);
  ASSERT_TRUE(client_ctx);
  UniquePtr<SSL_CTX> server_ctx_good = NewServerContext("password", kUnlimited);
  ASSERT_TRUE(server_ctx_good);
  UniquePtr<SSL_CTX> server_ctx_bad = NewServerContext("wrong", kUnlimited);
  ASSERT_TRUE(server_ctx_bad);

  auto connect = [&](SSL_CTX *server_ctx) {
    bssl::UniquePtr<SSL> client, server;
    ConnectClientAndServer(&client, &server, client_ctx.get(), server_ctx);
  };

  std::vector<std::thread> threads;
  for (int i = 0; i < kThreads; i++) {
    threads.emplace_back([&] { connect(server_ctx_good.get()); });
    threads.emplace_back([&] { connect(server_ctx_bad.get()); });
  }
  for (auto &thread : threads) {
    thread.join();
  }
}
TEST_F(SSLPAKETest, ServerThreads) {
  static constexpr uint32_t kLimit = 5;
  static constexpr uint32_t kUnlimited = UINT32_MAX;
  static constexpr int kThreads = 10;

  UniquePtr<SSL_CTX> server_ctx = NewServerContext("password", kLimit);
  ASSERT_TRUE(server_ctx);
  UniquePtr<SSL_CTX> client_ctx_good = NewClientContext("password", kUnlimited);
  ASSERT_TRUE(client_ctx_good);
  UniquePtr<SSL_CTX> client_ctx_bad = NewClientContext("wrong", kUnlimited);
  ASSERT_TRUE(client_ctx_bad);

  auto connect = [&](SSL_CTX *client_ctx) {
    bssl::UniquePtr<SSL> client, server;
    ConnectClientAndServer(&client, &server, client_ctx, server_ctx.get());
  };

  std::vector<std::thread> threads;
  for (int i = 0; i < kThreads; i++) {
    threads.emplace_back([&] { connect(client_ctx_good.get()); });
    threads.emplace_back([&] { connect(client_ctx_bad.get()); });
  }
  for (auto &thread : threads) {
    thread.join();
  }
}
#endif  // OPENSSL_THREADS

}  // namespace
BSSL_NAMESPACE_END
