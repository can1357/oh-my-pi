// Copyright 2025 The BoringSSL Authors
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

#include <openssl/cms.h>

#include <vector>

#include <gtest/gtest.h>

#include <openssl/bio.h>
#include <openssl/digest.h>
#include <openssl/err.h>
#include <openssl/nid.h>
#include <openssl/pem.h>
#include <openssl/x509.h>

#include "../test/test_data.h"
#include "../test/test_util.h"


static std::vector<uint8_t> BIOMemContents(const BIO *bio) {
  const uint8_t *data;
  size_t len;
  BSSL_CHECK(BIO_mem_contents(bio, &data, &len));
  return std::vector(data, data + len);
}

// CMS is (mostly) an extension of PKCS#7, so we reuse the PKCS#7 test data.
TEST(CMSTest, KernelModuleSigning) {
  // Sign a message with the same call that the Linux kernel's sign-file.c
  // makes.
  std::string cert_pem = GetTestData("crypto/pkcs7/test/sign_cert.pem");
  std::string key_pem = GetTestData("crypto/pkcs7/test/sign_key.pem");
  bssl::UniquePtr<BIO> cert_bio(
      BIO_new_mem_buf(cert_pem.data(), cert_pem.size()));
  bssl::UniquePtr<X509> cert(
      PEM_read_bio_X509(cert_bio.get(), nullptr, nullptr, nullptr));

  bssl::UniquePtr<BIO> key_bio(BIO_new_mem_buf(key_pem.data(), key_pem.size()));
  bssl::UniquePtr<EVP_PKEY> key(
      PEM_read_bio_PrivateKey(key_bio.get(), nullptr, nullptr, nullptr));

  static const char kSignedData[] = "signed data";
  bssl::UniquePtr<BIO> data_bio(
      BIO_new_mem_buf(kSignedData, sizeof(kSignedData) - 1));

  // Sign with SHA-256, as the kernel does.
  bssl::UniquePtr<CMS_ContentInfo> cms(CMS_sign(
      nullptr, nullptr, nullptr, nullptr,
      CMS_NOCERTS | CMS_PARTIAL | CMS_BINARY | CMS_DETACHED | CMS_STREAM));
  ASSERT_TRUE(cms);
  ASSERT_TRUE(
      CMS_add1_signer(cms.get(), cert.get(), key.get(), EVP_sha256(),
                      CMS_NOCERTS | CMS_BINARY | CMS_NOSMIMECAP | CMS_NOATTR));
  ASSERT_TRUE(CMS_final(cms.get(), data_bio.get(), /*dcont=*/nullptr,
                        CMS_NOCERTS | CMS_BINARY));

  // The kernel uses the streaming API for output, intended to stream the input
  // to the output, even though it doesn't call it in a streaming mode.
  bssl::UniquePtr<BIO> out(BIO_new(BIO_s_mem()));
  ASSERT_TRUE(
      i2d_CMS_bio_stream(out.get(), cms.get(), /*in=*/nullptr, /*flags=*/0));

  // RSA signatures are deterministic so the output should not change. By
  // default, |CMS_sign| should sign SHA-256.
  std::string expected = GetTestData("crypto/pkcs7/test/sign_sha256.p7s");
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // The more straightforward output API works too.
  ASSERT_TRUE(BIO_reset(out.get()));
  ASSERT_TRUE(i2d_CMS_bio(out.get(), cms.get()));
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // The kernel passes unnecessary flags. The minimal set of flags works too.
  ASSERT_TRUE(BIO_reset(data_bio.get()));
  cms.reset(
      CMS_sign(nullptr, nullptr, nullptr, nullptr, CMS_PARTIAL | CMS_DETACHED));
  ASSERT_TRUE(cms);
  ASSERT_TRUE(CMS_add1_signer(cms.get(), cert.get(), key.get(), EVP_sha256(),
                              CMS_NOCERTS | CMS_NOATTR));
  ASSERT_TRUE(
      CMS_final(cms.get(), data_bio.get(), /*dcont=*/nullptr, CMS_BINARY));
  ASSERT_TRUE(BIO_reset(out.get()));
  ASSERT_TRUE(i2d_CMS_bio(out.get(), cms.get()));
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // SHA-256 is the default hash, so the single-shot API works too, but is less
  // explicit about the hash chosen.
  ASSERT_TRUE(BIO_reset(data_bio.get()));
  cms.reset(CMS_sign(cert.get(), key.get(), nullptr, data_bio.get(),
                     CMS_DETACHED | CMS_NOCERTS | CMS_NOATTR | CMS_BINARY));
  ASSERT_TRUE(cms);
  ASSERT_TRUE(BIO_reset(out.get()));
  ASSERT_TRUE(i2d_CMS_bio(out.get(), cms.get()));
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // The signer can be identified by SKID instead.
  ASSERT_TRUE(BIO_reset(data_bio.get()));
  cms.reset(
      CMS_sign(nullptr, nullptr, nullptr, nullptr, CMS_PARTIAL | CMS_DETACHED));
  ASSERT_TRUE(cms);
  ASSERT_TRUE(CMS_add1_signer(cms.get(), cert.get(), key.get(), EVP_sha256(),
                              CMS_NOCERTS | CMS_NOATTR | CMS_USE_KEYID));
  ASSERT_TRUE(
      CMS_final(cms.get(), data_bio.get(), /*dcont=*/nullptr, CMS_BINARY));
  ASSERT_TRUE(BIO_reset(out.get()));
  ASSERT_TRUE(i2d_CMS_bio(out.get(), cms.get()));
  expected = GetTestData("crypto/pkcs7/test/sign_sha256_key_id.p7s");
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // Specify a different hash function.
  ASSERT_TRUE(BIO_reset(data_bio.get()));
  cms.reset(
      CMS_sign(nullptr, nullptr, nullptr, nullptr, CMS_PARTIAL | CMS_DETACHED));
  ASSERT_TRUE(cms);
  ASSERT_TRUE(CMS_add1_signer(cms.get(), cert.get(), key.get(), EVP_sha1(),
                              CMS_NOCERTS | CMS_NOATTR));
  ASSERT_TRUE(
      CMS_final(cms.get(), data_bio.get(), /*dcont=*/nullptr, CMS_BINARY));
  ASSERT_TRUE(BIO_reset(out.get()));
  ASSERT_TRUE(i2d_CMS_bio(out.get(), cms.get()));
  expected = GetTestData("crypto/pkcs7/test/sign_sha1.p7s");
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // Ditto, with SKID.
  ASSERT_TRUE(BIO_reset(data_bio.get()));
  cms.reset(
      CMS_sign(nullptr, nullptr, nullptr, nullptr, CMS_PARTIAL | CMS_DETACHED));
  ASSERT_TRUE(cms);
  ASSERT_TRUE(CMS_add1_signer(cms.get(), cert.get(), key.get(), EVP_sha1(),
                              CMS_NOCERTS | CMS_NOATTR | CMS_USE_KEYID));
  ASSERT_TRUE(
      CMS_final(cms.get(), data_bio.get(), /*dcont=*/nullptr, CMS_BINARY));
  ASSERT_TRUE(BIO_reset(out.get()));
  ASSERT_TRUE(i2d_CMS_bio(out.get(), cms.get()));
  expected = GetTestData("crypto/pkcs7/test/sign_sha1_key_id.p7s");
  EXPECT_EQ(Bytes(BIOMemContents(out.get())), Bytes(expected));

  // If SKID is requested, but there is none, signing should fail.
  bssl::UniquePtr<X509> cert_no_skid(X509_dup(cert.get()));
  ASSERT_TRUE(cert_no_skid.get());
  int loc =
      X509_get_ext_by_NID(cert_no_skid.get(), NID_subject_key_identifier, -1);
  ASSERT_GE(loc, 0);
  X509_EXTENSION_free(X509_delete_ext(cert_no_skid.get(), loc));
  ASSERT_TRUE(BIO_reset(data_bio.get()));
  cms.reset(CMS_sign(
      cert_no_skid.get(), key.get(), nullptr, data_bio.get(),
      CMS_DETACHED | CMS_NOCERTS | CMS_NOATTR | CMS_BINARY | CMS_USE_KEYID));
  EXPECT_FALSE(cms);
  EXPECT_TRUE(ErrorEquals(ERR_get_error(), ERR_LIB_CMS,
                          CMS_R_CERTIFICATE_HAS_NO_KEYID));
}
