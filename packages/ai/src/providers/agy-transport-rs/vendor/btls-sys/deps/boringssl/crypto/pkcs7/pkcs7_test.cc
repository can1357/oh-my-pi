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

#include <gtest/gtest.h>

#include <openssl/bytestring.h>
#include <openssl/crypto.h>
#include <openssl/mem.h>
#include <openssl/pem.h>
#include <openssl/pkcs7.h>
#include <openssl/span.h>
#include <openssl/stack.h>
#include <openssl/x509.h>

#include <string>

#include "../internal.h"
#include "../test/test_data.h"
#include "../test/test_util.h"


// kPEMCert is the result of exporting the mail.google.com certificate from
// Chrome and then running it through:
//   openssl pkcs7 -inform DER -in mail.google.com -outform PEM
static const char kPEMCert[] =
    "-----BEGIN PKCS7-----\n"
    "MIID+wYJKoZIhvcNAQcCoIID7DCCA+gCAQExADALBgkqhkiG9w0BBwGgggPQMIID\n"
    "zDCCArSgAwIBAgIIWesoywKxoNQwDQYJKoZIhvcNAQELBQAwSTELMAkGA1UEBhMC\n"
    "VVMxEzARBgNVBAoTCkdvb2dsZSBJbmMxJTAjBgNVBAMTHEdvb2dsZSBJbnRlcm5l\n"
    "dCBBdXRob3JpdHkgRzIwHhcNMTUwMjExMTQxNTA2WhcNMTUwNTEyMDAwMDAwWjBp\n"
    "MQswCQYDVQQGEwJVUzETMBEGA1UECAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91\n"
    "bnRhaW4gVmlldzETMBEGA1UECgwKR29vZ2xlIEluYzEYMBYGA1UEAwwPbWFpbC5n\n"
    "b29nbGUuY29tMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE7MdALmCkcRRf/tzQ\n"
    "a8eu3J7S5CTQa5ns0ReF9ktlbB1RL56BVGAu4p7BrT32D6gDpiggXq3gxN81A0TG\n"
    "C2yICKOCAWEwggFdMB0GA1UdJQQWMBQGCCsGAQUFBwMBBggrBgEFBQcDAjAsBgNV\n"
    "HREEJTAjgg9tYWlsLmdvb2dsZS5jb22CEGluYm94Lmdvb2dsZS5jb20wCwYDVR0P\n"
    "BAQDAgeAMGgGCCsGAQUFBwEBBFwwWjArBggrBgEFBQcwAoYfaHR0cDovL3BraS5n\n"
    "b29nbGUuY29tL0dJQUcyLmNydDArBggrBgEFBQcwAYYfaHR0cDovL2NsaWVudHMx\n"
    "Lmdvb2dsZS5jb20vb2NzcDAdBgNVHQ4EFgQUQqsYsRoWLiG6qmV2N1mpYaHawxAw\n"
    "DAYDVR0TAQH/BAIwADAfBgNVHSMEGDAWgBRK3QYWG7z2aLV29YG2u2IaulqBLzAX\n"
    "BgNVHSAEEDAOMAwGCisGAQQB1nkCBQEwMAYDVR0fBCkwJzAloCOgIYYfaHR0cDov\n"
    "L3BraS5nb29nbGUuY29tL0dJQUcyLmNybDANBgkqhkiG9w0BAQsFAAOCAQEAKNh3\n"
    "isNuGBisPKVlekOsZR6S8oP/fS/xt6Hqvg0EwFXvhxoJ40rxAB2LMykY17e+ln3P\n"
    "MwBBlRkwY1btcDT15JwzgaZb38rq/r+Pkb5Qgmx/InA/pw0QHDtwHQp5uXZuvu6p\n"
    "J/SlCwyq7EOvByWdVQcMU/dhGa3idXEkn/zwfqcG6YjdWKoDmXWZYv3RiP3wJcRB\n"
    "9+3U1wOe3uebnZLRWO6/w0to1XY8TFHklyw5rwIE5sbxOx5N3Ne8+GgPrUDvGAz0\n"
    "rAUKnh3b7GNXL1qlZh2qkhB6rUzvtPpg397Asg3xVtExCHOk4zPqzzicttoEbVVy\n"
    "0T8rIMUNwC4Beh4JVjEA\n"
    "-----END PKCS7-----\n";

/* kPEMCRL is the result of downloading the Equifax CRL and running:
     openssl crl2pkcs7 -inform DER -in secureca.crl  */
static const char kPEMCRL[] =
    "-----BEGIN PKCS7-----\n"
    "MIIDhQYJKoZIhvcNAQcCoIIDdjCCA3ICAQExADALBgkqhkiG9w0BBwGgAKGCA1gw\n"
    "ggNUMIICvTANBgkqhkiG9w0BAQUFADBOMQswCQYDVQQGEwJVUzEQMA4GA1UEChMH\n"
    "RXF1aWZheDEtMCsGA1UECxMkRXF1aWZheCBTZWN1cmUgQ2VydGlmaWNhdGUgQXV0\n"
    "aG9yaXR5Fw0xNTAyMjcwMTIzMDBaFw0xNTAzMDkwMTIzMDBaMIICPDAUAgMPWOQX\n"
    "DTE0MDQyNzA4MTkyMlowFAIDFHYZFw0xNDA2MTgxNTAwMDNaMBQCAw+a+xcNMTQw\n"
    "NDI5MTgwOTE3WjAUAgMUi8AXDTE0MDcwOTE5NDYzM1owFAIDFOScFw0xNDA0MTYy\n"
    "MzM5MzVaMBQCAw+GBxcNMTQwNTIxMTU1MDUzWjAUAgMS4ikXDTE0MDYxNzE4NTUx\n"
    "NVowFAIDDUJmFw0xMjA2MjcxNzEwNTNaMBQCAwMeMxcNMDIwNTE1MTMwNjExWjAU\n"
    "AgMS4iMXDTE0MDYwNjIwNDAyMVowFAIDE5yrFw0xMDA3MjkxNjQ0MzlaMBQCAxLG\n"
    "ChcNMTQwNjA2MjIyMTM5WjAUAgMDJYUXDTAyMDUxNDE4MTE1N1owFAIDFIbmFw0x\n"
    "NDA3MjUwMjAwMzhaMBQCAxOcoRcNMTAwNzI5MTY0NzMyWjAUAgMVTVwXDTE0MDQz\n"
    "MDAwMDQ0MlowFAIDD/otFw0xNDA2MTcxODUwMTFaMBQCAxN1VRcNMTUwMTE4MDIy\n"
    "MTMzWjAUAgMPVpYXDTE0MDYyNDEyMzEwMlowFAIDC4CKFw0xMjA2MjcxNzEwMjVa\n"
    "MBQCAw+UFhcNMTAwMzAxMTM0NTMxWjAUAgMUFrMXDTE0MDYxODE0MzI1NlowFAID\n"
    "CuGFFw0xMjA2MjcxNzEwMTdaMBQCAxTMPhcNMTQwNzExMTI1NTMxWjAUAgMQW8sX\n"
    "DTEwMDczMDIxMzEyMFowFAIDFWofFw0xNDAyMjYxMjM1MTlaMA0GCSqGSIb3DQEB\n"
    "BQUAA4GBAB1cJwcRA/IAvfRGPnH9EISD2dLSGaAg9xpDPazaM/y3QmAapKiyB1xR\n"
    "FsBCgAoP8EdbS3iQr8esSPjKPBNe9tGIrlWjDIpiRyn4crgkF6+yBh6ncnarlh3g\n"
    "fNQMQoI9So4Vdy88Kow6BBBV3Lu6sZHue+cjxXETrmshNdNk8ABUMQA=\n"
    "-----END PKCS7-----\n";

static void TestCertReparse(bssl::Span<const uint8_t> der) {
  bssl::UniquePtr<STACK_OF(X509)> certs(sk_X509_new_null());
  ASSERT_TRUE(certs);
  bssl::UniquePtr<STACK_OF(X509)> certs2(sk_X509_new_null());
  ASSERT_TRUE(certs2);
  uint8_t *result_data, *result2_data;
  size_t result_len, result2_len;

  CBS pkcs7 = der;
  ASSERT_TRUE(PKCS7_get_certificates(certs.get(), &pkcs7));
  EXPECT_EQ(0u, CBS_len(&pkcs7));

  bssl::ScopedCBB cbb;
  ASSERT_TRUE(CBB_init(cbb.get(), der.size()));
  ASSERT_TRUE(PKCS7_bundle_certificates(cbb.get(), certs.get()));
  ASSERT_TRUE(CBB_finish(cbb.get(), &result_data, &result_len));
  bssl::UniquePtr<uint8_t> free_result_data(result_data);

  CBS_init(&pkcs7, result_data, result_len);
  ASSERT_TRUE(PKCS7_get_certificates(certs2.get(), &pkcs7));
  EXPECT_EQ(0u, CBS_len(&pkcs7));

  // PKCS#7 stores certificates in a SET OF, so |PKCS7_bundle_certificates| may
  // not preserve the original order. All of our test inputs are already sorted,
  // but this check should be relaxed if we add others.
  ASSERT_EQ(sk_X509_num(certs.get()), sk_X509_num(certs2.get()));
  for (size_t i = 0; i < sk_X509_num(certs.get()); i++) {
    X509 *a = sk_X509_value(certs.get(), i);
    X509 *b = sk_X509_value(certs2.get(), i);
    ASSERT_EQ(0, X509_cmp(a, b));
  }

  ASSERT_TRUE(CBB_init(cbb.get(), der.size()));
  ASSERT_TRUE(PKCS7_bundle_certificates(cbb.get(), certs2.get()));
  ASSERT_TRUE(CBB_finish(cbb.get(), &result2_data, &result2_len));
  bssl::UniquePtr<uint8_t> free_result2_data(result2_data);

  EXPECT_EQ(Bytes(result_data, result_len), Bytes(result2_data, result2_len));

  // Parse with the legacy API instead.
  const uint8_t *ptr = der.data();
  bssl::UniquePtr<PKCS7> pkcs7_obj(d2i_PKCS7(nullptr, &ptr, der.size()));
  ASSERT_TRUE(pkcs7_obj);
  EXPECT_EQ(ptr, der.data() + der.size());

  ASSERT_TRUE(PKCS7_type_is_signed(pkcs7_obj.get()));
  const STACK_OF(X509) *certs3 = pkcs7_obj->d.sign->cert;
  ASSERT_EQ(sk_X509_num(certs.get()), sk_X509_num(certs3));
  for (size_t i = 0; i < sk_X509_num(certs.get()); i++) {
    X509 *a = sk_X509_value(certs.get(), i);
    X509 *b = sk_X509_value(certs3, i);
    ASSERT_EQ(0, X509_cmp(a, b));
  }

  // Serialize the original object. This should echo back the original saved
  // bytes.
  uint8_t *result3_data = nullptr;
  int result3_len = i2d_PKCS7(pkcs7_obj.get(), &result3_data);
  ASSERT_GT(result3_len, 0);
  bssl::UniquePtr<uint8_t> free_result3_data(result3_data);
  EXPECT_EQ(Bytes(der), Bytes(result3_data, result3_len));

  // Make a new object with the legacy API.
  pkcs7_obj.reset(
      PKCS7_sign(nullptr, nullptr, certs.get(), nullptr, PKCS7_DETACHED));
  ASSERT_TRUE(pkcs7_obj);

  ASSERT_TRUE(PKCS7_type_is_signed(pkcs7_obj.get()));
  const STACK_OF(X509) *certs4 = pkcs7_obj->d.sign->cert;
  ASSERT_EQ(sk_X509_num(certs.get()), sk_X509_num(certs4));
  for (size_t i = 0; i < sk_X509_num(certs.get()); i++) {
    X509 *a = sk_X509_value(certs.get(), i);
    X509 *b = sk_X509_value(certs4, i);
    ASSERT_EQ(0, X509_cmp(a, b));
  }

  // This new object should serialize canonically.
  uint8_t *result4_data = nullptr;
  int result4_len = i2d_PKCS7(pkcs7_obj.get(), &result4_data);
  ASSERT_GT(result4_len, 0);
  bssl::UniquePtr<uint8_t> free_result4_data(result4_data);
  EXPECT_EQ(Bytes(result_data, result_len), Bytes(result4_data, result4_len));
}

static void TestCRLReparse(bssl::Span<const uint8_t> der) {
  bssl::UniquePtr<STACK_OF(X509_CRL)> crls(sk_X509_CRL_new_null());
  ASSERT_TRUE(crls);
  bssl::UniquePtr<STACK_OF(X509_CRL)> crls2(sk_X509_CRL_new_null());
  ASSERT_TRUE(crls2);
  uint8_t *result_data, *result2_data;
  size_t result_len, result2_len;

  CBS pkcs7 = der;
  ASSERT_TRUE(PKCS7_get_CRLs(crls.get(), &pkcs7));
  EXPECT_EQ(0u, CBS_len(&pkcs7));

  bssl::ScopedCBB cbb;
  ASSERT_TRUE(CBB_init(cbb.get(), der.size()));
  ASSERT_TRUE(PKCS7_bundle_CRLs(cbb.get(), crls.get()));
  ASSERT_TRUE(CBB_finish(cbb.get(), &result_data, &result_len));
  bssl::UniquePtr<uint8_t> free_result_data(result_data);

  CBS_init(&pkcs7, result_data, result_len);
  ASSERT_TRUE(PKCS7_get_CRLs(crls2.get(), &pkcs7));
  EXPECT_EQ(0u, CBS_len(&pkcs7));

  // PKCS#7 stores CRLs in a SET OF, so |PKCS7_bundle_CRLs| may not preserve the
  // original order. All of our test inputs are already sorted, but this check
  // should be relaxed if we add others.
  ASSERT_EQ(sk_X509_CRL_num(crls.get()), sk_X509_CRL_num(crls.get()));
  for (size_t i = 0; i < sk_X509_CRL_num(crls.get()); i++) {
    X509_CRL *a = sk_X509_CRL_value(crls.get(), i);
    X509_CRL *b = sk_X509_CRL_value(crls2.get(), i);
    ASSERT_EQ(0, X509_CRL_cmp(a, b));
  }

  ASSERT_TRUE(CBB_init(cbb.get(), der.size()));
  ASSERT_TRUE(PKCS7_bundle_CRLs(cbb.get(), crls2.get()));
  ASSERT_TRUE(CBB_finish(cbb.get(), &result2_data, &result2_len));
  bssl::UniquePtr<uint8_t> free_result2_data(result2_data);

  EXPECT_EQ(Bytes(result_data, result_len), Bytes(result2_data, result2_len));

  // Parse with the legacy API instead.
  const uint8_t *ptr = der.data();
  bssl::UniquePtr<PKCS7> pkcs7_obj(d2i_PKCS7(nullptr, &ptr, der.size()));
  ASSERT_TRUE(pkcs7_obj);
  EXPECT_EQ(ptr, der.data() + der.size());

  ASSERT_TRUE(PKCS7_type_is_signed(pkcs7_obj.get()));
  const STACK_OF(X509_CRL) *crls3 = pkcs7_obj->d.sign->crl;
  ASSERT_EQ(sk_X509_CRL_num(crls.get()), sk_X509_CRL_num(crls3));
  for (size_t i = 0; i < sk_X509_CRL_num(crls.get()); i++) {
    X509_CRL *a = sk_X509_CRL_value(crls.get(), i);
    X509_CRL *b = sk_X509_CRL_value(crls3, i);
    ASSERT_EQ(0, X509_CRL_cmp(a, b));
  }

  ptr = result_data;
  pkcs7_obj.reset(d2i_PKCS7(nullptr, &ptr, result_len));
  ASSERT_TRUE(pkcs7_obj);
  EXPECT_EQ(ptr, result_data + result_len);

  ASSERT_TRUE(PKCS7_type_is_signed(pkcs7_obj.get()));
  const STACK_OF(X509_CRL) *crls4 = pkcs7_obj->d.sign->crl;
  ASSERT_EQ(sk_X509_CRL_num(crls.get()), sk_X509_CRL_num(crls4));
  for (size_t i = 0; i < sk_X509_CRL_num(crls.get()); i++) {
    X509_CRL *a = sk_X509_CRL_value(crls.get(), i);
    X509_CRL *b = sk_X509_CRL_value(crls4, i);
    ASSERT_EQ(0, X509_CRL_cmp(a, b));
  }
}

static void TestPEMCerts(const char *pem) {
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, strlen(pem)));
  ASSERT_TRUE(bio);
  bssl::UniquePtr<STACK_OF(X509)> certs(sk_X509_new_null());
  ASSERT_TRUE(certs);

  ASSERT_TRUE(PKCS7_get_PEM_certificates(certs.get(), bio.get()));
  ASSERT_EQ(1u, sk_X509_num(certs.get()));
}

static void TestPEMCRLs(const char *pem) {
  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(pem, strlen(pem)));
  ASSERT_TRUE(bio);
  bssl::UniquePtr<STACK_OF(X509_CRL)> crls(sk_X509_CRL_new_null());
  ASSERT_TRUE(crls);

  ASSERT_TRUE(PKCS7_get_PEM_CRLs(crls.get(), bio.get()));
  ASSERT_EQ(1u, sk_X509_CRL_num(crls.get()));
}

TEST(PKCS7Test, CertReparseNSS) {
  // nss.p7c contains the certificate chain of mail.google.com, as saved by NSS
  // using the Chrome UI.
  TestCertReparse(
      bssl::StringAsBytes(GetTestData("crypto/pkcs7/test/nss.p7c")));
}

TEST(PKCS7Test, CertReparseWindows) {
  // windows.p7c is the Equifax root certificate, as exported by Windows 7.
  TestCertReparse(
      bssl::StringAsBytes(GetTestData("crypto/pkcs7/test/windows.p7c")));
}

TEST(PKCS7Test, CrlReparse) {
  // openssl_crl.p7c is the Equifax CRL, converted to PKCS#7 form by:
  //   openssl crl2pkcs7 -inform DER -in secureca.crl
  TestCRLReparse(
      bssl::StringAsBytes(GetTestData("crypto/pkcs7/test/openssl_crl.p7c")));
}

TEST(PKCS7Test, PEMCerts) {
  TestPEMCerts(kPEMCert);
}

TEST(PKCS7Test, PEMCRLs) {
  TestPEMCRLs(kPEMCRL);
}

// Test that we output certificates in the canonical DER order.
TEST(PKCS7Test, SortCerts) {
  // nss.p7c contains three certificates in the canonical DER order.
  std::string nss_p7c = GetTestData("crypto/pkcs7/test/nss.p7c");
  CBS pkcs7 = bssl::StringAsBytes(nss_p7c);
  bssl::UniquePtr<STACK_OF(X509)> certs(sk_X509_new_null());
  ASSERT_TRUE(certs);
  ASSERT_TRUE(PKCS7_get_certificates(certs.get(), &pkcs7));
  ASSERT_EQ(3u, sk_X509_num(certs.get()));

  X509 *cert1 = sk_X509_value(certs.get(), 0);
  X509 *cert2 = sk_X509_value(certs.get(), 1);
  X509 *cert3 = sk_X509_value(certs.get(), 2);

  auto check_order = [&](X509 *new_cert1, X509 *new_cert2, X509 *new_cert3) {
    // Bundle the certificates in the new order.
    bssl::UniquePtr<STACK_OF(X509)> new_certs(sk_X509_new_null());
    ASSERT_TRUE(new_certs);
    ASSERT_TRUE(bssl::PushToStack(new_certs.get(), bssl::UpRef(new_cert1)));
    ASSERT_TRUE(bssl::PushToStack(new_certs.get(), bssl::UpRef(new_cert2)));
    ASSERT_TRUE(bssl::PushToStack(new_certs.get(), bssl::UpRef(new_cert3)));
    bssl::ScopedCBB cbb;
    ASSERT_TRUE(CBB_init(cbb.get(), nss_p7c.size()));
    ASSERT_TRUE(PKCS7_bundle_certificates(cbb.get(), new_certs.get()));

    // The bundle should be sorted back to the original order.
    CBS cbs;
    CBS_init(&cbs, CBB_data(cbb.get()), CBB_len(cbb.get()));
    bssl::UniquePtr<STACK_OF(X509)> result(sk_X509_new_null());
    ASSERT_TRUE(result);
    ASSERT_TRUE(PKCS7_get_certificates(result.get(), &cbs));
    ASSERT_EQ(sk_X509_num(certs.get()), sk_X509_num(result.get()));
    for (size_t i = 0; i < sk_X509_num(certs.get()); i++) {
      X509 *a = sk_X509_value(certs.get(), i);
      X509 *b = sk_X509_value(result.get(), i);
      EXPECT_EQ(0, X509_cmp(a, b));
    }
  };

  check_order(cert1, cert2, cert3);
  check_order(cert3, cert2, cert1);
  check_order(cert2, cert3, cert1);
}

// Test that we output certificates in the canonical DER order, using the
// CRYPTO_BUFFER version of the parse and bundle functions.
TEST(PKCS7Test, SortCertsRaw) {
  // nss.p7c contains three certificates in the canonical DER order.
  std::string nss_p7c = GetTestData("crypto/pkcs7/test/nss.p7c");
  CBS pkcs7 = bssl::StringAsBytes(nss_p7c);
  bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> certs(sk_CRYPTO_BUFFER_new_null());
  ASSERT_TRUE(certs);
  ASSERT_TRUE(PKCS7_get_raw_certificates(certs.get(), &pkcs7, nullptr));
  ASSERT_EQ(3u, sk_CRYPTO_BUFFER_num(certs.get()));

  CRYPTO_BUFFER *cert1 = sk_CRYPTO_BUFFER_value(certs.get(), 0);
  CRYPTO_BUFFER *cert2 = sk_CRYPTO_BUFFER_value(certs.get(), 1);
  CRYPTO_BUFFER *cert3 = sk_CRYPTO_BUFFER_value(certs.get(), 2);

  auto check_order = [&](CRYPTO_BUFFER *new_cert1, CRYPTO_BUFFER *new_cert2,
                         CRYPTO_BUFFER *new_cert3) {
    // Bundle the certificates in the new order.
    bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> new_certs(
        sk_CRYPTO_BUFFER_new_null());
    ASSERT_TRUE(new_certs);
    ASSERT_TRUE(bssl::PushToStack(new_certs.get(), bssl::UpRef(new_cert1)));
    ASSERT_TRUE(bssl::PushToStack(new_certs.get(), bssl::UpRef(new_cert2)));
    ASSERT_TRUE(bssl::PushToStack(new_certs.get(), bssl::UpRef(new_cert3)));
    bssl::ScopedCBB cbb;
    ASSERT_TRUE(CBB_init(cbb.get(), nss_p7c.size()));
    ASSERT_TRUE(PKCS7_bundle_raw_certificates(cbb.get(), new_certs.get()));

    // The bundle should be sorted back to the original order.
    CBS cbs;
    CBS_init(&cbs, CBB_data(cbb.get()), CBB_len(cbb.get()));
    bssl::UniquePtr<STACK_OF(CRYPTO_BUFFER)> result(
        sk_CRYPTO_BUFFER_new_null());
    ASSERT_TRUE(result);
    ASSERT_TRUE(PKCS7_get_raw_certificates(result.get(), &cbs, nullptr));
    ASSERT_EQ(sk_CRYPTO_BUFFER_num(certs.get()),
              sk_CRYPTO_BUFFER_num(result.get()));
    for (size_t i = 0; i < sk_CRYPTO_BUFFER_num(certs.get()); i++) {
      CRYPTO_BUFFER *a = sk_CRYPTO_BUFFER_value(certs.get(), i);
      CRYPTO_BUFFER *b = sk_CRYPTO_BUFFER_value(result.get(), i);
      EXPECT_EQ(Bytes(CRYPTO_BUFFER_data(a), CRYPTO_BUFFER_len(a)),
                Bytes(CRYPTO_BUFFER_data(b), CRYPTO_BUFFER_len(b)));
    }
  };

  check_order(cert1, cert2, cert3);
  check_order(cert3, cert2, cert1);
  check_order(cert2, cert3, cert1);
}

// Test that we output CRLs in the canonical DER order.
TEST(PKCS7Test, SortCRLs) {
  static const char kCRL1[] = R"(
-----BEGIN X509 CRL-----
MIIBpzCBkAIBATANBgkqhkiG9w0BAQsFADBOMQswCQYDVQQGEwJVUzETMBEGA1UE
CAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91bnRhaW4gVmlldzESMBAGA1UECgwJ
Qm9yaW5nU1NMFw0xNjA5MjYxNTEwNTVaFw0xNjEwMjYxNTEwNTVaoA4wDDAKBgNV
HRQEAwIBATANBgkqhkiG9w0BAQsFAAOCAQEAnrBKKgvd9x9zwK9rtUvVeFeJ7+LN
ZEAc+a5oxpPNEsJx6hXoApYEbzXMxuWBQoCs5iEBycSGudct21L+MVf27M38KrWo
eOkq0a2siqViQZO2Fb/SUFR0k9zb8xl86Zf65lgPplALun0bV/HT7MJcl04Tc4os
dsAReBs5nqTGNEd5AlC1iKHvQZkM//MD51DspKnDpsDiUVi54h9C1SpfZmX8H2Vv
diyu0fZ/bPAM3VAGawatf/SyWfBMyKpoPXEG39oAzmjjOj8en82psn7m474IGaho
/vBbhl1ms5qQiLYPjm4YELtnXQoFyC72tBjbdFd/ZE9k4CNKDbxFUXFbkw==
-----END X509 CRL-----
)";
  static const char kCRL2[] = R"(
-----BEGIN X509 CRL-----
MIIBvjCBpwIBATANBgkqhkiG9w0BAQsFADBOMQswCQYDVQQGEwJVUzETMBEGA1UE
CAwKQ2FsaWZvcm5pYTEWMBQGA1UEBwwNTW91bnRhaW4gVmlldzESMBAGA1UECgwJ
Qm9yaW5nU1NMFw0xNjA5MjYxNTEyNDRaFw0xNjEwMjYxNTEyNDRaMBUwEwICEAAX
DTE2MDkyNjE1MTIyNlqgDjAMMAoGA1UdFAQDAgECMA0GCSqGSIb3DQEBCwUAA4IB
AQCUGaM4DcWzlQKrcZvI8TMeR8BpsvQeo5BoI/XZu2a8h//PyRyMwYeaOM+3zl0d
sjgCT8b3C1FPgT+P2Lkowv7rJ+FHJRNQkogr+RuqCSPTq65ha4WKlRGWkMFybzVH
NloxC+aU3lgp/NlX9yUtfqYmJek1CDrOOGPrAEAwj1l/BUeYKNGqfBWYJQtPJu+5
OaSvIYGpETCZJscUWODmLEb/O3DM438vLvxonwGqXqS0KX37+CHpUlyhnSovxXxp
Pz4aF+L7OtczxL0GYtD2fR9B7TDMqsNmHXgQrixvvOY7MUdLGbd4RfJL3yA53hyO
xzfKY2TzxLiOmctG0hXFkH5J
-----END X509 CRL-----
)";

  bssl::UniquePtr<BIO> bio(BIO_new_mem_buf(kCRL1, strlen(kCRL1)));
  ASSERT_TRUE(bio);
  bssl::UniquePtr<X509_CRL> crl1(
      PEM_read_bio_X509_CRL(bio.get(), nullptr, nullptr, nullptr));
  ASSERT_TRUE(crl1);
  bio.reset(BIO_new_mem_buf(kCRL2, strlen(kCRL2)));
  ASSERT_TRUE(bio);
  bssl::UniquePtr<X509_CRL> crl2(
      PEM_read_bio_X509_CRL(bio.get(), nullptr, nullptr, nullptr));
  ASSERT_TRUE(crl2);

  // DER's SET OF ordering sorts by tag, then length, so |crl1| comes before
  // |crl2|.
  auto check_order = [&](X509_CRL *new_crl1, X509_CRL *new_crl2) {
    // Bundle the CRLs in the new order.
    bssl::UniquePtr<STACK_OF(X509_CRL)> new_crls(sk_X509_CRL_new_null());
    ASSERT_TRUE(new_crls);
    ASSERT_TRUE(bssl::PushToStack(new_crls.get(), bssl::UpRef(new_crl1)));
    ASSERT_TRUE(bssl::PushToStack(new_crls.get(), bssl::UpRef(new_crl2)));
    bssl::ScopedCBB cbb;
    ASSERT_TRUE(CBB_init(cbb.get(), 64));
    ASSERT_TRUE(PKCS7_bundle_CRLs(cbb.get(), new_crls.get()));

    // The bundle should be sorted back to the original order.
    CBS cbs;
    CBS_init(&cbs, CBB_data(cbb.get()), CBB_len(cbb.get()));
    bssl::UniquePtr<STACK_OF(X509_CRL)> result(sk_X509_CRL_new_null());
    ASSERT_TRUE(result);
    ASSERT_TRUE(PKCS7_get_CRLs(result.get(), &cbs));
    ASSERT_EQ(2u, sk_X509_CRL_num(result.get()));
    EXPECT_EQ(0, X509_CRL_cmp(crl1.get(), sk_X509_CRL_value(result.get(), 0)));
    EXPECT_EQ(0, X509_CRL_cmp(crl2.get(), sk_X509_CRL_value(result.get(), 1)));
  };

  check_order(crl1.get(), crl2.get());
  check_order(crl2.get(), crl1.get());
}

TEST(PKCS7Test, KernelModuleSigning) {
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

  bssl::UniquePtr<PKCS7> pkcs7(
      PKCS7_sign(cert.get(), key.get(), /*certs=*/nullptr, data_bio.get(),
                 PKCS7_NOATTR | PKCS7_BINARY | PKCS7_NOCERTS | PKCS7_DETACHED));
  ASSERT_TRUE(pkcs7);

  uint8_t *pkcs7_bytes = nullptr;
  const int pkcs7_len = i2d_PKCS7(pkcs7.get(), &pkcs7_bytes);
  ASSERT_GE(pkcs7_len, 0);
  bssl::UniquePtr<uint8_t> pkcs7_storage(pkcs7_bytes);

  // RSA signatures are deterministic so the output should not change.
  std::string expected = GetTestData("crypto/pkcs7/test/sign_sha256.p7s");
  EXPECT_EQ(Bytes(pkcs7_bytes, pkcs7_len), Bytes(expected));

  // Other option combinations should fail.
  EXPECT_FALSE(
      PKCS7_sign(cert.get(), key.get(), /*certs=*/nullptr, data_bio.get(),
                 PKCS7_NOATTR | PKCS7_BINARY | PKCS7_NOCERTS));
  EXPECT_FALSE(
      PKCS7_sign(cert.get(), key.get(), /*certs=*/nullptr, data_bio.get(),
                 PKCS7_BINARY | PKCS7_NOCERTS | PKCS7_DETACHED));
  EXPECT_FALSE(
      PKCS7_sign(cert.get(), key.get(), /*certs=*/nullptr, data_bio.get(),
                 PKCS7_NOATTR | PKCS7_TEXT | PKCS7_NOCERTS | PKCS7_DETACHED));
  EXPECT_FALSE(
      PKCS7_sign(cert.get(), key.get(), /*certs=*/nullptr, data_bio.get(),
                 PKCS7_NOATTR | PKCS7_BINARY | PKCS7_DETACHED));

  ERR_clear_error();
}
