// Copyright 2023 The BoringSSL Authors
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

#include "trust_store_in_memory.h"

#include <gtest/gtest.h>
#include "test_helpers.h"

BSSL_NAMESPACE_BEGIN
namespace {

class TrustStoreInMemoryTest : public testing::Test {
 public:
  void SetUp() override {
    ParsedCertificateList chain;
    ASSERT_TRUE(ReadCertChainFromFile(
        "testdata/verify_certificate_chain_unittest/key-rollover/oldchain.pem",
        &chain));

    ASSERT_EQ(3U, chain.size());
    target_ = chain[0];
    oldintermediate_ = chain[1];
    oldroot_ = chain[2];
    ASSERT_TRUE(target_);
    ASSERT_TRUE(oldintermediate_);
    ASSERT_TRUE(oldroot_);

    ASSERT_TRUE(
        ReadCertChainFromFile("testdata/verify_certificate_chain_unittest/"
                              "key-rollover/longrolloverchain.pem",
                              &chain));

    ASSERT_EQ(5U, chain.size());
    newintermediate_ = chain[1];
    newroot_ = chain[2];
    newrootrollover_ = chain[3];
    ASSERT_TRUE(newintermediate_);
    ASSERT_TRUE(newroot_);
    ASSERT_TRUE(newrootrollover_);
  }

 protected:
  std::shared_ptr<const ParsedCertificate> oldroot_;
  std::shared_ptr<const ParsedCertificate> newroot_;
  std::shared_ptr<const ParsedCertificate> newrootrollover_;

  std::shared_ptr<const ParsedCertificate> target_;
  std::shared_ptr<const ParsedCertificate> oldintermediate_;
  std::shared_ptr<const ParsedCertificate> newintermediate_;
};

TEST_F(TrustStoreInMemoryTest, OneRootTrusted) {
  TrustStoreInMemory in_memory;
  in_memory.AddTrustAnchor(newroot_);

  // newroot_ is trusted.
  CertificateTrust trust = in_memory.GetTrust(newroot_.get());
  EXPECT_EQ(CertificateTrust::ForTrustAnchor().ToDebugString(),
            trust.ToDebugString());

  // oldroot_ is not.
  trust = in_memory.GetTrust(oldroot_.get());
  EXPECT_EQ(CertificateTrust::ForUnspecified().ToDebugString(),
            trust.ToDebugString());
}

TEST_F(TrustStoreInMemoryTest, DistrustBySPKI) {
  TrustStoreInMemory in_memory;
  in_memory.AddDistrustedCertificateBySPKI(
      std::string(BytesAsStringView(newroot_->tbs().spki_tlv)));

  // newroot_ is distrusted.
  CertificateTrust trust = in_memory.GetTrust(newroot_.get());
  EXPECT_EQ(CertificateTrust::ForDistrusted().ToDebugString(),
            trust.ToDebugString());

  // oldroot_ is unspecified.
  trust = in_memory.GetTrust(oldroot_.get());
  EXPECT_EQ(CertificateTrust::ForUnspecified().ToDebugString(),
            trust.ToDebugString());

  // newrootrollover_ is also distrusted because it has the same key.
  trust = in_memory.GetTrust(newrootrollover_.get());
  EXPECT_EQ(CertificateTrust::ForDistrusted().ToDebugString(),
            trust.ToDebugString());
}

TEST_F(TrustStoreInMemoryTest, DistrustBySPKIOverridesTrust) {
  TrustStoreInMemory in_memory;
  in_memory.AddTrustAnchor(newroot_);
  in_memory.AddDistrustedCertificateBySPKI(
      std::string(BytesAsStringView(newroot_->tbs().spki_tlv)));

  // newroot_ is distrusted.
  CertificateTrust trust = in_memory.GetTrust(newroot_.get());
  EXPECT_EQ(CertificateTrust::ForDistrusted().ToDebugString(),
            trust.ToDebugString());
}

}  // namespace
BSSL_NAMESPACE_END
