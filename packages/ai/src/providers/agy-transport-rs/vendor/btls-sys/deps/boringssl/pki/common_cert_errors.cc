// Copyright 2017 The Chromium Authors
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

#include "common_cert_errors.h"

BSSL_NAMESPACE_BEGIN
namespace cert_errors {

DEFINE_CERT_ERROR_ID(kInternalError, "Internal error");
DEFINE_CERT_ERROR_ID(kValidityFailedNotAfter, "Time is after notAfter");
DEFINE_CERT_ERROR_ID(kValidityFailedNotBefore, "Time is before notBefore");
DEFINE_CERT_ERROR_ID(kDistrustedByTrustStore, "Distrusted by trust store");

DEFINE_CERT_ERROR_ID(
    kSignatureAlgorithmMismatch,
    "Certificate.signatureAlgorithm != TBSCertificate.signature");

DEFINE_CERT_ERROR_ID(kChainIsEmpty, "Chain is empty");
DEFINE_CERT_ERROR_ID(kUnconsumedCriticalExtension,
                     "Unconsumed critical extension");
DEFINE_CERT_ERROR_ID(kKeyCertSignBitNotSet, "keyCertSign bit is not set");
DEFINE_CERT_ERROR_ID(kKeyUsageIncorrectForRcsMlsClient,
                     "KeyUsage must have only the digitalSignature bit set for "
                     "rcsMlsClient auth");
DEFINE_CERT_ERROR_ID(kMaxPathLengthViolated, "max_path_length reached");
DEFINE_CERT_ERROR_ID(kBasicConstraintsIndicatesNotCa,
                     "Basic Constraints indicates not a CA");
DEFINE_CERT_ERROR_ID(kTargetCertShouldNotBeCa,
                     "Certificate has Basic Constraints indicating it is a CA "
                     "when it should not be a CA");
DEFINE_CERT_ERROR_ID(kMissingBasicConstraints,
                     "Does not have Basic Constraints");
DEFINE_CERT_ERROR_ID(kNotPermittedByNameConstraints,
                     "Not permitted by name constraints");
DEFINE_CERT_ERROR_ID(kTooManyNameConstraintChecks,
                     "Too many name constraints checks");
DEFINE_CERT_ERROR_ID(kSubjectDoesNotMatchIssuer,
                     "subject does not match issuer");
DEFINE_CERT_ERROR_ID(kVerifySignedDataFailed, "VerifySignedData failed");
DEFINE_CERT_ERROR_ID(kSignatureAlgorithmsDifferentEncoding,
                     "Certificate.signatureAlgorithm is encoded differently "
                     "than TBSCertificate.signature");
DEFINE_CERT_ERROR_ID(kEkuLacksServerAuth,
                     "The extended key usage does not include server auth");
DEFINE_CERT_ERROR_ID(kEkuLacksServerAuthButHasAnyEKU,
                     "The extended key usage does not include server auth but "
                     "instead includes anyExtendeKeyUsage");
DEFINE_CERT_ERROR_ID(kEkuLacksClientAuth,
                     "The extended key usage does not include client auth");
DEFINE_CERT_ERROR_ID(kEkuLacksClientAuthButHasAnyEKU,
                     "The extended key usage does not include client auth but "
                     "instead includes anyExtendedKeyUsage");
DEFINE_CERT_ERROR_ID(kEkuLacksClientAuthOrServerAuth,
                     "The extended key usage does not include client auth "
                     "or server auth");
DEFINE_CERT_ERROR_ID(kEkuHasProhibitedOCSPSigning,
                     "The extended key usage includes OCSP signing which "
                     "is not permitted for this use");
DEFINE_CERT_ERROR_ID(kEkuHasProhibitedTimeStamping,
                     "The extended key usage includes time stamping which "
                     "is not permitted for this use");
DEFINE_CERT_ERROR_ID(kEkuHasProhibitedCodeSigning,
                     "The extended key usage includes code signing which "
                     "is not permitted for this use");
DEFINE_CERT_ERROR_ID(kEkuIncorrectForRcsMlsClient,
                     "The extended key usage does not contain only the "
                     "rcsMlsClient key purpose.");
DEFINE_CERT_ERROR_ID(kEkuIncorrectForC2PATimeStamping,
                     "The extended key usage does not contain the time "
                     "stamping key purpose, or contains prohibited key usages");
DEFINE_CERT_ERROR_ID(
    kEkuIncorrectForC2PAManifest,
    "The extended key usage must contain at least one of: email protection or "
    "document signing, and must not contain prohibited key usages");

DEFINE_CERT_ERROR_ID(kEkuNotPresent,
                     "Certificate does not have extended key usage");
DEFINE_CERT_ERROR_ID(kCertIsNotTrustAnchor,
                     "Certificate is not a trust anchor");
DEFINE_CERT_ERROR_ID(kNoValidPolicy, "No valid policy");
DEFINE_CERT_ERROR_ID(kPolicyMappingAnyPolicy,
                     "PolicyMappings must not map anyPolicy");
DEFINE_CERT_ERROR_ID(kFailedParsingSpki, "Couldn't parse SubjectPublicKeyInfo");
DEFINE_CERT_ERROR_ID(kUnacceptableSignatureAlgorithm,
                     "Unacceptable signature algorithm");
DEFINE_CERT_ERROR_ID(kUnacceptablePublicKey, "Unacceptable public key");
DEFINE_CERT_ERROR_ID(kCertificateRevoked, "Certificate is revoked");
DEFINE_CERT_ERROR_ID(kNoRevocationMechanism,
                     "Certificate lacks a revocation mechanism");
DEFINE_CERT_ERROR_ID(kUnableToCheckRevocation, "Unable to check revocation");
DEFINE_CERT_ERROR_ID(kNoIssuersFound, "No matching issuer found");
DEFINE_CERT_ERROR_ID(kDeadlineExceeded, "Deadline exceeded");
DEFINE_CERT_ERROR_ID(kIterationLimitExceeded, "Iteration limit exceeded");
DEFINE_CERT_ERROR_ID(kDepthLimitExceeded, "Depth limit exceeded");

}  // namespace cert_errors
BSSL_NAMESPACE_END
