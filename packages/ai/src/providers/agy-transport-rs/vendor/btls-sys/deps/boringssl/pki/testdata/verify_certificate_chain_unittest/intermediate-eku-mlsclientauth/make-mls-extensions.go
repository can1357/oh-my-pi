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

//go:build ignore

// make-mls-extensions.go generates test certs to test mls extension handling.
package main

import (
	"crypto/ecdsa"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/pem"
	"math/big"
	"os"
	"time"
)

var leafKey, intermediateKey, rootKey *ecdsa.PrivateKey

func init() {
	leafKey = mustParseECDSAKey(leafKeyPEM)
	intermediateKey = mustParseECDSAKey(intermediateKeyPEM)
	rootKey = mustParseECDSAKey(rootKeyPEM)
}

type templateAndKey struct {
	template x509.Certificate
	key      *ecdsa.PrivateKey
}

func rcsMlsParticipantExtension() (ext pkix.Extension, err error) {
	var oidParticipantInfo = asn1.ObjectIdentifier{2, 23, 146, 2, 1, 4}
	ext = pkix.Extension{}
	ext.Id = oidParticipantInfo
	ext.Critical = true
	// Not really a valid value, but doesn't matter to us.
	ext.Value, err = asn1.Marshal([]asn1.ObjectIdentifier{oidParticipantInfo})
	return ext, err
}

func rcsAcsMlsParticipantExtension() (ext pkix.Extension, err error) {
	var oidParticipantInfo = asn1.ObjectIdentifier{2, 23, 146, 2, 1, 5}
	ext = pkix.Extension{}
	ext.Id = oidParticipantInfo
	ext.Critical = true
	// Not really a valid value, but doesn't matter to us.
	ext.Value, err = asn1.Marshal([]asn1.ObjectIdentifier{oidParticipantInfo})
	return ext, err
}

func mustGenerateCertificate(path string, subject, issuer *templateAndKey) []byte {
	cert, err := x509.CreateCertificate(rand.Reader, &subject.template, &issuer.template, &subject.key.PublicKey, issuer.key)
	if err != nil {
		panic(err)
	}
	file, err := os.Create(path)
	if err != nil {
		panic(err)
	}
	defer file.Close()
	err = pem.Encode(file, &pem.Block{Type: "CERTIFICATE", Bytes: cert})
	if err != nil {
		panic(err)
	}
	return cert
}

func main() {
	notBefore, err := time.Parse(time.RFC3339, "0000-01-01T00:00:00Z")
	if err != nil {
		panic(err)
	}
	notAfter, err := time.Parse(time.RFC3339, "9999-12-31T23:59:59Z")
	if err != nil {
		panic(err)
	}

	root := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(1),
			Subject:               pkix.Name{CommonName: "MLS Cert Root"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  true,
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("root"),
		},
		key: rootKey,
	}
	intermediate := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(2),
			Subject:               pkix.Name{CommonName: "MLS Cert Intermediate"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  true,
			KeyUsage:              x509.KeyUsageCertSign,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("intermediate"),
			UnknownExtKeyUsage:    []asn1.ObjectIdentifier{[]int{2, 23, 146, 2, 1, 3}},
		},
		key: intermediateKey,
	}

	ParticipantExt, err := rcsMlsParticipantExtension()
	if err != nil {
		panic(err)
	}

	AcsParticipantExt, err := rcsAcsMlsParticipantExtension()
	if err != nil {
		panic(err)
	}

	leaf := templateAndKey{
		template: x509.Certificate{
			SerialNumber:          new(big.Int).SetInt64(3),
			Subject:               pkix.Name{CommonName: "MLS Cert Leaf"},
			NotBefore:             notBefore,
			NotAfter:              notAfter,
			BasicConstraintsValid: true,
			IsCA:                  false,
			KeyUsage:              x509.KeyUsageDigitalSignature,
			SignatureAlgorithm:    x509.ECDSAWithSHA256,
			SubjectKeyId:          []byte("leaf"),
			UnknownExtKeyUsage:    []asn1.ObjectIdentifier{[]int{2, 23, 146, 2, 1, 3}},
			ExtraExtensions:       append([]pkix.Extension{}, ParticipantExt, AcsParticipantExt),
		},
		key: leafKey,
	}

	// Generate a valid certificate chain from the templates.
	mustGenerateCertificate("mls_client_root.pem", &root, &root)
	mustGenerateCertificate("mls_client_intermediate.pem", &intermediate, &root)
	mustGenerateCertificate("mls_client_leaf.pem", &leaf, &intermediate)
	intermediateInvalid := intermediate
	intermediateInvalid.template.UnknownExtKeyUsage = []asn1.ObjectIdentifier{[]int{2, 23, 146, 2, 1, 3},
		[]int{2, 23, 133, 8, 1}}
	mustGenerateCertificate("mls_client_intermediate_extra_eku.pem", &intermediateInvalid, &root)
	leafInvalid := leaf
	leafInvalid.template.UnknownExtKeyUsage = []asn1.ObjectIdentifier{[]int{2, 23, 146, 2, 1, 3},
		[]int{2, 23, 133, 8, 1}}
	leafInvalid.template.KeyUsage |= x509.KeyUsageKeyEncipherment
	mustGenerateCertificate("mls_client_leaf_extra_eku.pem", &leafInvalid, &intermediateInvalid)
}

const leafKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgoPUXNXuH9mgiS/nk
024SYxryxMa3CyGJldiHymLxSquhRANCAASRKti8VW2Rkma+Kt9jQkMNitlCs0l5
w8u3SSwm7HZREvmcBCJBjVIREacRqI0umhzR2V5NLzBBP9yPD/A+Ch5X
-----END PRIVATE KEY-----`

const intermediateKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgWHKCKgY058ahE3t6
vpxVQgzlycgCVMogwjK0y3XMNfWhRANCAATiOnyojN4xS5C8gJ/PHL5cOEsMbsoE
Y6KT9xRQSh8lEL4d1Vb36kqUgkpqedEImo0Og4Owk6VWVVR/m4Lk+yUw
-----END PRIVATE KEY-----`

const rootKeyPEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgBwND/eHytW0I417J
Hr+qcPlp5N1jM3ACXys57bPujg+hRANCAAQmdqXYl1GvY7y3jcTTK6MVXIQr44Tq
ChRYI6IeV9tIB6jIsOY+Qol1bk8x/7A5FGOnUWFVLEAPEPSJwPndjolt
-----END PRIVATE KEY-----`

func mustParseECDSAKey(in string) *ecdsa.PrivateKey {
	keyBlock, _ := pem.Decode([]byte(in))
	if keyBlock == nil || keyBlock.Type != "PRIVATE KEY" {
		panic("could not decode private key")
	}
	key, err := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
	if err != nil {
		panic(err)
	}
	return key.(*ecdsa.PrivateKey)
}
