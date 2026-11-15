// Copyright 2024 The BoringSSL Authors
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

#include <openssl/base.h>

#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include <stdint.h>
#include <stdio.h>
#include <string.h>

#include <openssl/bn.h>
#include <openssl/span.h>

#include <gtest/gtest.h>

#include "../internal.h"
#include "../test/test_util.h"
#include "./internal.h"


BSSL_NAMESPACE_BEGIN

namespace {

using namespace spake2plus;

std::vector<uint8_t> HexToBytes(const char *str) {
  std::vector<uint8_t> ret;
  if (!DecodeHex(&ret, str)) {
    abort();
  }
  return ret;
}

class RegistrationCache {
 public:
  struct Result {
    std::vector<uint8_t> w0, w1, record;
  };

  const Result &Get(const std::pair<std::string, std::string> &names,
                    const std::string &pw) {
    CacheKey key{names.first, names.second, pw};

    auto it = cache.find(key);
    if (it != cache.end()) {
      return it->second;
    }

    Result output;
    output.w0.resize(kVerifierSize);
    output.w1.resize(kVerifierSize);
    output.record.resize(kRegistrationRecordSize);

    if (!Register(Span(output.w0), Span(output.w1), Span(output.record),
                  StringAsBytes(pw), StringAsBytes(names.first),
                  StringAsBytes(names.second))) {
      abort();
    }

    return cache.emplace(std::move(key), std::move(output)).first->second;
  }

 private:
  struct CacheKey {
    std::string id_prover, id_verifier, password;

    bool operator==(const CacheKey &other) const {
      return std::tie(id_prover, id_verifier, password) ==
             std::tie(other.id_prover, other.id_verifier, other.password);
    }
  };

  struct KeyHash {
    std::size_t operator()(const CacheKey &k) const {
      return std::hash<std::string>()(k.id_prover) ^
             std::hash<std::string>()(k.id_verifier) ^
             std::hash<std::string>()(k.password);
    }
  };

  std::unordered_map<CacheKey, Result, KeyHash> cache;
};

RegistrationCache &GlobalRegistrationCache() {
  static RegistrationCache cache;
  return cache;
}

struct SPAKEPLUSRun {
  bool Run() {
    const RegistrationCache::Result &registration =
        GlobalRegistrationCache().Get(prover_names, pw);

    Prover prover;
    if (!prover.Init(StringAsBytes(context), StringAsBytes(prover_names.first),
                     StringAsBytes(prover_names.second), registration.w0,
                     registration.w1)) {
      return false;
    }

    std::vector<uint8_t> verifier_registration_record = registration.record;
    if (verifier_corrupt_record) {
      verifier_registration_record[verifier_registration_record.size() - 1] ^=
          0xFF;
    }

    Verifier verifier;
    if (!verifier.Init(StringAsBytes(context),
                       StringAsBytes(verifier_names.first),
                       StringAsBytes(verifier_names.second), registration.w0,
                       verifier_registration_record)) {
      return false;
    }

    uint8_t prover_share[kShareSize];
    if (!prover.GenerateShare(prover_share)) {
      return false;
    }

    if (repeat_invocations && prover.GenerateShare(prover_share)) {
      return false;
    }

    if (prover_corrupt_msg_bit &&
        *prover_corrupt_msg_bit < 8 * sizeof(prover_share)) {
      prover_share[*prover_corrupt_msg_bit / 8] ^=
          1 << (*prover_corrupt_msg_bit & 7);
    }

    uint8_t verifier_share[kShareSize];
    uint8_t verifier_confirm[kConfirmSize];
    uint8_t verifier_secret[kSecretSize];
    if (!verifier.ProcessProverShare(verifier_share, verifier_confirm,
                                     verifier_secret, prover_share)) {
      return false;
    }

    if (repeat_invocations &&
        verifier.ProcessProverShare(verifier_share, verifier_confirm,
                                    verifier_secret, prover_share)) {
      return false;
    }

    uint8_t prover_confirm[kConfirmSize];
    uint8_t prover_secret[kSecretSize];
    if (!prover.ComputeConfirmation(prover_confirm, prover_secret,
                                    verifier_share, verifier_confirm)) {
      return false;
    }

    if (repeat_invocations &&  //
        prover.ComputeConfirmation(prover_confirm, prover_secret,
                                   verifier_share, verifier_confirm)) {
      return false;
    }

    if (prover_corrupt_confirm_bit &&
        *prover_corrupt_confirm_bit < 8 * sizeof(prover_confirm)) {
      prover_confirm[*prover_corrupt_confirm_bit / 8] ^=
          1 << (*prover_corrupt_confirm_bit & 7);
    }

    if (!verifier.VerifyProverConfirmation(prover_confirm)) {
      return false;
    }

    if (repeat_invocations &&
        verifier.VerifyProverConfirmation(prover_confirm)) {
      return false;
    }

    key_matches_ = Span(prover_secret) == Span(verifier_secret);
    return true;
  }

  bool key_matches() const { return key_matches_; }

  std::string context =
      "SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors";
  std::string pw = "password";
  std::pair<std::string, std::string> prover_names = {"client", "server"};
  std::pair<std::string, std::string> verifier_names = {"client", "server"};
  bool verifier_corrupt_record = false;
  bool repeat_invocations = false;
  std::optional<size_t> prover_corrupt_msg_bit;
  std::optional<size_t> prover_corrupt_confirm_bit;

 private:
  bool key_matches_ = false;
};

TEST(SPAKEPLUSTest, TestVectors) {
  // https://datatracker.ietf.org/doc/html/rfc9383#appendix-C
  // SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors
  const char w0_str[] =
      "bb8e1bbcf3c48f62c08db243652ae55d3e5586053fca77102994f23ad95491b3";
  const char w1_str[] =
      "7e945f34d78785b8a3ef44d0df5a1a97d6b3b460409a345ca7830387a74b1dba";
  const char L_str[] =
      "04eb7c9db3d9a9eb1f8adab81b5794c1f13ae3e225efbe91ea487425854c7fc00f00bfed"
      "cbd09b2400142d40a14f2064ef31dfaa903b91d1faea7093d835966efd";
  const char x_str[] =
      "d1232c8e8693d02368976c174e2088851b8365d0d79a9eee709c6a05a2fad539";
  const char share_p_str[] =
      "04ef3bd051bf78a2234ec0df197f7828060fe9856503579bb1733009042c15c0c1de1277"
      "27f418b5966afadfdd95a6e4591d171056b333dab97a79c7193e341727";
  const char y_str[] =
      "717a72348a182085109c8d3917d6c43d59b224dc6a7fc4f0483232fa6516d8b3";
  const char share_v_str[] =
      "04c0f65da0d11927bdf5d560c69e1d7d939a05b0e88291887d679fcadea75810fb5cc1ca"
      "7494db39e82ff2f50665255d76173e09986ab46742c798a9a68437b048";
  const char confirm_p_str[] =
      "926cc713504b9b4d76c9162ded04b5493e89109f6d89462cd33adc46fda27527";
  const char confirm_v_str[] =
      "9747bcc4f8fe9f63defee53ac9b07876d907d55047e6ff2def2e7529089d3e68";
  const char secret_str[] =
      "0c5f8ccd1413423a54f6c1fb26ff01534a87f893779c6e68666d772bfd91f3e7";
  const std::string context =
      "SPAKE2+-P256-SHA256-HKDF-SHA256-HMAC-SHA256 Test Vectors";
  const std::pair<std::string, std::string> prover_names = {"client", "server"};
  const std::pair<std::string, std::string> verifier_names = {"client",
                                                              "server"};

  std::vector<uint8_t> w0 = HexToBytes(w0_str);
  std::vector<uint8_t> w1 = HexToBytes(w1_str);
  std::vector<uint8_t> registration_record = HexToBytes(L_str);
  std::vector<uint8_t> x = HexToBytes(x_str);
  std::vector<uint8_t> y = HexToBytes(y_str);

  Prover prover;
  ASSERT_TRUE(prover.Init(StringAsBytes(context),
                          StringAsBytes(prover_names.first),
                          StringAsBytes(prover_names.second), MakeConstSpan(w0),
                          MakeConstSpan(w1), x));

  Verifier verifier;
  ASSERT_TRUE(
      verifier.Init(StringAsBytes(context), StringAsBytes(prover_names.first),
                    StringAsBytes(prover_names.second), MakeConstSpan(w0),
                    MakeConstSpan(registration_record), y));

  uint8_t prover_share[kShareSize];
  ASSERT_TRUE(prover.GenerateShare(prover_share));

  std::vector<uint8_t> share_p = HexToBytes(share_p_str);
  ASSERT_TRUE(
      OPENSSL_memcmp(share_p.data(), prover_share, sizeof(prover_share)) == 0);

  uint8_t verifier_share[kShareSize];
  uint8_t verifier_confirm[kConfirmSize];
  uint8_t verifier_secret[kSecretSize];
  ASSERT_TRUE(verifier.ProcessProverShare(verifier_share, verifier_confirm,
                                          verifier_secret, prover_share));

  std::vector<uint8_t> share_v = HexToBytes(share_v_str);
  ASSERT_TRUE(OPENSSL_memcmp(share_v.data(), verifier_share,
                             sizeof(verifier_share)) == 0);
  std::vector<uint8_t> confirm_v = HexToBytes(confirm_v_str);
  ASSERT_TRUE(OPENSSL_memcmp(confirm_v.data(), verifier_confirm,
                             sizeof(verifier_confirm)) == 0);

  uint8_t prover_confirm[kConfirmSize];
  uint8_t prover_secret[kSecretSize];
  ASSERT_TRUE(prover.ComputeConfirmation(prover_confirm, prover_secret,
                                         verifier_share, verifier_confirm));

  std::vector<uint8_t> confirm_p = HexToBytes(confirm_p_str);
  ASSERT_TRUE(OPENSSL_memcmp(confirm_p.data(), prover_confirm,
                             sizeof(prover_confirm)) == 0);

  ASSERT_TRUE(verifier.VerifyProverConfirmation(prover_confirm));

  std::vector<uint8_t> expected_secret = HexToBytes(secret_str);
  static_assert(sizeof(verifier_secret) == sizeof(prover_secret));
  ASSERT_TRUE(OPENSSL_memcmp(prover_secret, verifier_secret,
                             sizeof(prover_secret)) == 0);
  ASSERT_TRUE(OPENSSL_memcmp(expected_secret.data(), verifier_secret,
                             sizeof(verifier_secret)) == 0);
}

TEST(SPAKEPLUSTest, SPAKEPLUS) {
  for (unsigned i = 0; i < 20; i++) {
    SPAKEPLUSRun spake2;
    ASSERT_TRUE(spake2.Run());
    EXPECT_TRUE(spake2.key_matches());
  }
}

TEST(SPAKEPLUSTest, WrongPassword) {
  SPAKEPLUSRun spake2;
  spake2.verifier_corrupt_record = true;
  ASSERT_FALSE(spake2.Run());
}

TEST(SPAKEPLUSTest, WrongNames) {
  SPAKEPLUSRun spake2;
  spake2.prover_names.second = "alice";
  spake2.verifier_names.second = "bob";
  ASSERT_FALSE(spake2.Run());
}

TEST(SPAKEPLUSTest, CorruptMessages) {
  for (size_t i = 0; i < 8 * kShareSize; i++) {
    SPAKEPLUSRun spake2;
    spake2.prover_corrupt_msg_bit = i;
    EXPECT_FALSE(spake2.Run())
        << "Passed after corrupting Prover's key share message, bit " << i;
  }

  for (size_t i = 0; i < 8 * kConfirmSize; i++) {
    SPAKEPLUSRun spake2;
    spake2.prover_corrupt_confirm_bit = i;
    EXPECT_FALSE(spake2.Run())
        << "Passed after corrupting Verifier's confirmation message, bit " << i;
  }
}

TEST(SPAKEPLUSTest, StateMachine) {
  SPAKEPLUSRun spake2;
  spake2.repeat_invocations = true;
  ASSERT_TRUE(spake2.Run());
}

}  // namespace

BSSL_NAMESPACE_END
