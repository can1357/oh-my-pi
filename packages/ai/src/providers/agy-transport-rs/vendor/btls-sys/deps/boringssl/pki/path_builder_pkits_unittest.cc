// Copyright 2016 The Chromium Authors
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

#include "path_builder.h"

#include <cstdint>

#include <openssl/pool.h>
#include "cert_issuer_source_static.h"
#include "common_cert_errors.h"
#include "crl.h"
#include "encode_values.h"
#include "input.h"
#include "parse_certificate.h"
#include "parsed_certificate.h"
#include "simple_path_builder_delegate.h"
#include "trust_store_in_memory.h"
#include "verify_certificate_chain.h"

#include "nist_pkits_unittest.h"

constexpr int64_t kOneYear = 60 * 60 * 24 * 365;

BSSL_NAMESPACE_BEGIN

namespace {

class CrlCheckingPathBuilderDelegate : public SimplePathBuilderDelegate {
 public:
  CrlCheckingPathBuilderDelegate(const std::vector<std::string> &der_crls,
                                 int64_t verify_time, int64_t max_age,
                                 size_t min_rsa_modulus_length_bits,
                                 DigestPolicy digest_policy)
      : SimplePathBuilderDelegate(min_rsa_modulus_length_bits, digest_policy),
        der_crls_(der_crls),
        verify_time_(verify_time),
        max_age_(max_age) {}

  void CheckPathAfterVerification(const CertPathBuilder &path_builder,
                                  CertPathBuilderResultPath *path) override {
    SimplePathBuilderDelegate::CheckPathAfterVerification(path_builder, path);

    if (!path->IsValid()) {
      return;
    }

    // It would be preferable if this test could use
    // CheckValidatedChainRevocation somehow, but that only supports getting
    // CRLs by http distributionPoints. So this just settles for writing a
    // little bit of wrapper code to test CheckCRL directly.
    const ParsedCertificateList &certs = path->certs;
    for (size_t reverse_i = 0; reverse_i < certs.size(); ++reverse_i) {
      size_t i = certs.size() - reverse_i - 1;

      // Trust anchors bypass OCSP/CRL revocation checks. (The only way to
      // revoke trust anchors is via CRLSet or the built-in SPKI block list).
      if (reverse_i == 0 && path->last_cert_trust.IsTrustAnchor()) {
        continue;
      }

      // RFC 5280 6.3.3.  [If the CRL was not specified in a distribution
      //                  point], assume a DP with both the reasons and the
      //                  cRLIssuer fields omitted and a distribution point
      //                  name of the certificate issuer.
      // Since this implementation only supports URI names in distribution
      // points, this means a default-initialized ParsedDistributionPoint is
      // sufficient.
      ParsedDistributionPoint fake_cert_dp;
      const ParsedDistributionPoint *cert_dp = &fake_cert_dp;

      // If the target cert does have a distribution point, use it.
      std::vector<ParsedDistributionPoint> distribution_points;
      ParsedExtension crl_dp_extension;
      if (certs[i]->GetExtension(der::Input(kCrlDistributionPointsOid),
                                 &crl_dp_extension)) {
        ASSERT_TRUE(ParseCrlDistributionPoints(crl_dp_extension.value,
                                               &distribution_points));
        // TODO(mattm): some test cases (some of the 4.14.* onlySomeReasons
        // tests)) have two CRLs and two distribution points, one point
        // corresponding to each CRL.  Should select the matching point for
        // each CRL.  (Doesn't matter currently since we don't support
        // reasons.)

        // Look for a DistributionPoint without reasons.
        for (const auto &dp : distribution_points) {
          if (!dp.reasons) {
            cert_dp = &dp;
            break;
          }
        }
        // If there were only DistributionPoints with reasons, just use the
        // first one.
        if (cert_dp == &fake_cert_dp && !distribution_points.empty()) {
          cert_dp = &distribution_points[0];
        }
      }

      bool cert_good = false;

      for (const auto &der_crl : der_crls_) {
        CRLRevocationStatus crl_status =
            CheckCRL(der_crl, certs, i, *cert_dp, verify_time_, max_age_);
        if (crl_status == CRLRevocationStatus::REVOKED) {
          path->errors.GetErrorsForCert(i)->AddError(
              cert_errors::kCertificateRevoked);
          return;
        }
        if (crl_status == CRLRevocationStatus::GOOD) {
          cert_good = true;
          break;
        }
      }
      if (!cert_good) {
        // PKITS tests assume hard-fail revocation checking.
        // From PKITS 4.4: "When running the tests in this section, the
        // application should be configured in such a way that the
        // certification path is not accepted unless valid, up-to-date
        // revocation data is available for every certificate in the path."
        path->errors.GetErrorsForCert(i)->AddError(
            cert_errors::kUnableToCheckRevocation);
      }
    }
  }

 private:
  std::vector<std::string> der_crls_;
  int64_t verify_time_;
  int64_t max_age_;
};

class PathBuilderPkitsTestDelegate {
 public:
  static void RunTest(std::vector<std::string> cert_ders,
                      std::vector<std::string> crl_ders,
                      const PkitsTestInfo &orig_info) {
    PkitsTestInfo info = orig_info;

    ASSERT_FALSE(cert_ders.empty());
    ParsedCertificateList certs;
    for (const std::string &der : cert_ders) {
      CertErrors errors;
      ASSERT_TRUE(ParsedCertificate::CreateAndAddToVector(
          bssl::UniquePtr<CRYPTO_BUFFER>(
              CRYPTO_BUFFER_new(reinterpret_cast<const uint8_t *>(der.data()),
                                der.size(), nullptr)),
          {}, &certs, &errors))
          << errors.ToDebugString();
    }
    // First entry in the PKITS chain is the trust anchor.
    // TODO(mattm): test with all possible trust anchors in the trust store?
    TrustStoreInMemory trust_store;

    trust_store.AddTrustAnchor(certs[0]);

    // TODO(mattm): test with other irrelevant certs in cert_issuer_sources?
    CertIssuerSourceStatic cert_issuer_source;
    for (size_t i = 1; i < cert_ders.size() - 1; ++i) {
      cert_issuer_source.AddCert(certs[i]);
    }

    std::shared_ptr<const ParsedCertificate> target_cert(certs.back());

    int64_t verify_time;
    ASSERT_TRUE(der::GeneralizedTimeToPosixTime(info.time, &verify_time));
    CrlCheckingPathBuilderDelegate path_builder_delegate(
        crl_ders, verify_time, /*max_age=*/kOneYear * 2, 1024,
        SimplePathBuilderDelegate::DigestPolicy::kWeakAllowSha1);

    std::string_view test_number = info.test_number;
    if (test_number == "4.4.19" || test_number == "4.5.3" ||
        test_number == "4.5.4" || test_number == "4.5.6") {
      // 4.4.19 - fails since CRL is signed by a certificate that is not part
      //          of the verified chain, which is not supported.
      // 4.5.3 - fails since non-URI distribution point names are not supported
      // 4.5.4, 4.5.6 - fails since CRL is signed by a certificate that is not
      //                part of verified chain, and also non-URI distribution
      //                point names not supported
      info.should_validate = false;
    } else if (test_number == "4.14.1" || test_number == "4.14.4" ||
               test_number == "4.14.5" || test_number == "4.14.7" ||
               test_number == "4.14.18" || test_number == "4.14.19" ||
               test_number == "4.14.22" || test_number == "4.14.24" ||
               test_number == "4.14.25" || test_number == "4.14.28" ||
               test_number == "4.14.29" || test_number == "4.14.30" ||
               test_number == "4.14.33") {
      // 4.14 tests:
      // .1 - fails since non-URI distribution point names not supported
      // .2, .3 - fails since non-URI distribution point names not supported
      //          (but test is expected to fail for other reason)
      // .4, .5 - fails since non-URI distribution point names not supported,
      //          also uses nameRelativeToCRLIssuer which is not supported
      // .6 - fails since non-URI distribution point names not supported, also
      //      uses nameRelativeToCRLIssuer which is not supported (but test is
      //      expected to fail for other reason)
      // .7 - fails since relative distributionPointName not supported
      // .8, .9 - fails since relative distributionPointName not supported (but
      //          test is expected to fail for other reason)
      // .10, .11, .12, .13, .14, .27, .35 - PASS
      // .15, .16, .17, .20, .21 - fails since onlySomeReasons is not supported
      //                           (but test is expected to fail for other
      //                           reason)
      // .18, .19 - fails since onlySomeReasons is not supported
      // .22, .24, .25, .28, .29, .30, .33 - fails since indirect CRLs are not
      //                                     supported
      // .23, .26, .31, .32, .34 - fails since indirect CRLs are not supported
      //                           (but test is expected to fail for other
      //                           reason)
      info.should_validate = false;
    } else if (test_number == "4.15.1" || test_number == "4.15.5") {
      // 4.15 tests:
      // .1 - fails due to unhandled critical deltaCRLIndicator extension
      // .2, .3, .6, .7, .8, .9, .10 - PASS since expected cert status is
      //                               reflected in base CRL and delta CRL is
      //                               ignored
      // .5 - fails, cert status is "on hold" in base CRL but the delta CRL
      //      which removes the cert from CRL is ignored
      info.should_validate = false;
    } else if (test_number == "4.15.4") {
      // 4.15.4 - Invalid delta-CRL Test4 has the target cert marked revoked in
      // a delta-CRL. Since delta-CRLs are not supported, the chain validates
      // successfully.
      info.should_validate = true;
    }

    CertPathBuilder path_builder(
        std::move(target_cert), &trust_store, &path_builder_delegate, info.time,
        KeyPurpose::ANY_EKU, info.initial_explicit_policy,
        info.initial_policy_set, info.initial_policy_mapping_inhibit,
        info.initial_inhibit_any_policy);
    path_builder.AddCertIssuerSource(&cert_issuer_source);

    CertPathBuilder::Result result = path_builder.Run();

    if (info.should_validate != result.HasValidPath()) {
      testing::Message msg;
      for (size_t i = 0; i < result.paths.size(); ++i) {
        const bssl::CertPathBuilderResultPath *result_path =
            result.paths[i].get();
        msg << "path " << i << " errors:\n"
            << result_path->errors.ToDebugString(result_path->certs) << "\n";
      }
      ASSERT_EQ(info.should_validate, result.HasValidPath()) << msg;
    }

    if (result.HasValidPath()) {
      EXPECT_EQ(info.user_constrained_policy_set,
                result.GetBestValidPath()->user_constrained_policy_set);
    }
  }
};

}  // namespace

INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest01SignatureVerification,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest02ValidityPeriods,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest03VerifyingNameChaining,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder,
                               PkitsTest04BasicCertificateRevocationTests,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(
    PathBuilder, PkitsTest05VerifyingPathswithSelfIssuedCertificates,
    PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder,
                               PkitsTest06VerifyingBasicConstraints,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest07KeyUsage,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest08CertificatePolicies,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest09RequireExplicitPolicy,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest10PolicyMappings,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest11InhibitPolicyMapping,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest12InhibitAnyPolicy,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest13NameConstraints,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest14DistributionPoints,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder, PkitsTest15DeltaCRLs,
                               PathBuilderPkitsTestDelegate);
INSTANTIATE_TYPED_TEST_SUITE_P(PathBuilder,
                               PkitsTest16PrivateCertificateExtensions,
                               PathBuilderPkitsTestDelegate);

BSSL_NAMESPACE_END
