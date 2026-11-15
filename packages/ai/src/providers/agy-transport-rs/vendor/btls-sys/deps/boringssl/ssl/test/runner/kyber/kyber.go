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

package kyber

// This code is ported from kyber.c.

import (
	"crypto/sha3"
	"crypto/subtle"
	"io"
)

const (
	CiphertextSize = 1088
	PublicKeySize  = 1184
	PrivateKeySize = 2400
)

const (
	degree               = 256
	rank                 = 3
	prime                = 3329
	log2Prime            = 12
	halfPrime            = (prime - 1) / 2
	du                   = 10
	dv                   = 4
	inverseDegree        = 3303
	encodedVectorSize    = log2Prime * degree / 8 * rank
	compressedVectorSize = du * rank * degree / 8
	barrettMultiplier    = 5039
	barrettShift         = 24
)

func reduceOnce(x uint16) uint16 {
	if x >= 2*prime {
		panic("reduce_once: value out of range")
	}
	subtracted := x - prime
	mask := 0 - (subtracted >> 15)
	return (mask & x) | (^mask & subtracted)
}

func reduce(x uint32) uint16 {
	if x >= prime+2*prime*prime {
		panic("reduce: value out of range")
	}
	product := uint64(x) * barrettMultiplier
	quotient := uint32(product >> barrettShift)
	remainder := uint32(x) - quotient*prime
	return reduceOnce(uint16(remainder))
}

// lt returns 0xff..f if a < b and 0 otherwise
func lt(a, b uint32) uint32 {
	return uint32(0 - int32(a^((a^b)|((a-b)^a)))>>31)
}

// Compresses (lossily) an input |x| mod 3329 into |bits| many bits by grouping
// numbers close to each other together. The formula used is
// round(2^|bits|/prime*x) mod 2^|bits|.
// Uses Barrett reduction to achieve constant time. Since we need both the
// remainder (for rounding) and the quotient (as the result), we cannot use
// |reduce| here, but need to do the Barrett reduction directly.
func compress(x uint16, bits int) uint16 {
	product := uint32(x) << bits
	quotient := uint32((uint64(product) * barrettMultiplier) >> barrettShift)
	remainder := product - quotient*prime

	// Adjust the quotient to round correctly:
	//   0 <= remainder <= halfPrime round to 0
	//   halfPrime < remainder <= prime + halfPrime round to 1
	//   prime + halfPrime < remainder < 2 * prime round to 2
	quotient += 1 & lt(halfPrime, remainder)
	quotient += 1 & lt(prime+halfPrime, remainder)
	return uint16(quotient) & ((1 << bits) - 1)
}

func decompress(x uint16, bits int) uint16 {
	product := uint32(x) * prime
	power := uint32(1) << bits
	// This is |product| % power, since |power| is a power of 2.
	remainder := product & (power - 1)
	// This is |product| / power, since |power| is a power of 2.
	lower := product >> bits
	// The rounding logic works since the first half of numbers mod |power| have a
	// 0 as first bit, and the second half has a 1 as first bit, since |power| is
	// a power of 2. As a 12 bit number, |remainder| is always positive, so we
	// will shift in 0s for a right shift.
	return uint16(lower + (remainder >> (bits - 1)))
}

type scalar [degree]uint16

func (s *scalar) zero() {
	clear(s[:])
}

// This bit of Python will be referenced in some of the following comments:
//
// p = 3329
//
// def bitreverse(i):
//     ret = 0
//     for n in range(7):
//         bit = i & 1
//         ret <<= 1
//         ret |= bit
//         i >>= 1
//     return ret

// kNTTRoots = [pow(17, bitreverse(i), p) for i in range(128)]
var nttRoots = [128]uint16{
	1, 1729, 2580, 3289, 2642, 630, 1897, 848, 1062, 1919, 193, 797,
	2786, 3260, 569, 1746, 296, 2447, 1339, 1476, 3046, 56, 2240, 1333,
	1426, 2094, 535, 2882, 2393, 2879, 1974, 821, 289, 331, 3253, 1756,
	1197, 2304, 2277, 2055, 650, 1977, 2513, 632, 2865, 33, 1320, 1915,
	2319, 1435, 807, 452, 1438, 2868, 1534, 2402, 2647, 2617, 1481, 648,
	2474, 3110, 1227, 910, 17, 2761, 583, 2649, 1637, 723, 2288, 1100,
	1409, 2662, 3281, 233, 756, 2156, 3015, 3050, 1703, 1651, 2789, 1789,
	1847, 952, 1461, 2687, 939, 2308, 2437, 2388, 733, 2337, 268, 641,
	1584, 2298, 2037, 3220, 375, 2549, 2090, 1645, 1063, 319, 2773, 757,
	2099, 561, 2466, 2594, 2804, 1092, 403, 1026, 1143, 2150, 2775, 886,
	1722, 1212, 1874, 1029, 2110, 2935, 885, 2154,
}

func (s *scalar) ntt() {
	offset := degree
	for step := 1; step < degree/2; step <<= 1 {
		offset >>= 1
		k := 0
		for i := 0; i < step; i++ {
			stepRoot := uint32(nttRoots[i+step])
			for j := k; j < k+offset; j++ {
				odd := reduce(stepRoot * uint32(s[j+offset]))
				even := s[j]
				s[j] = reduceOnce(odd + even)
				s[j+offset] = reduceOnce(even - odd + prime)
			}
			k += 2 * offset
		}
	}
}

// kInverseNTTRoots = [pow(17, -bitreverse(i), p) for i in range(128)]
var inverseNTTRoots = [128]uint16{
	1, 1600, 40, 749, 2481, 1432, 2699, 687, 1583, 2760, 69, 543,
	2532, 3136, 1410, 2267, 2508, 1355, 450, 936, 447, 2794, 1235, 1903,
	1996, 1089, 3273, 283, 1853, 1990, 882, 3033, 2419, 2102, 219, 855,
	2681, 1848, 712, 682, 927, 1795, 461, 1891, 2877, 2522, 1894, 1010,
	1414, 2009, 3296, 464, 2697, 816, 1352, 2679, 1274, 1052, 1025, 2132,
	1573, 76, 2998, 3040, 1175, 2444, 394, 1219, 2300, 1455, 2117, 1607,
	2443, 554, 1179, 2186, 2303, 2926, 2237, 525, 735, 863, 2768, 1230,
	2572, 556, 3010, 2266, 1684, 1239, 780, 2954, 109, 1292, 1031, 1745,
	2688, 3061, 992, 2596, 941, 892, 1021, 2390, 642, 1868, 2377, 1482,
	1540, 540, 1678, 1626, 279, 314, 1173, 2573, 3096, 48, 667, 1920,
	2229, 1041, 2606, 1692, 680, 2746, 568, 3312,
}

func (s *scalar) inverseNTT() {
	step := degree / 2
	for offset := 2; offset < degree; offset <<= 1 {
		step >>= 1
		k := 0
		for i := 0; i < step; i++ {
			stepRoot := uint32(inverseNTTRoots[i+step])
			for j := k; j < k+offset; j++ {
				odd := s[j+offset]
				even := s[j]
				s[j] = reduceOnce(odd + even)
				s[j+offset] = reduce(stepRoot * uint32(even-odd+prime))
			}
			k += 2 * offset
		}
	}
	for i := range s {
		s[i] = reduce(uint32(s[i]) * inverseDegree)
	}
}

func (s *scalar) add(b *scalar) {
	for i := range s {
		s[i] = reduceOnce(s[i] + b[i])
	}
}

func (s *scalar) sub(b *scalar) {
	for i := range s {
		s[i] = reduceOnce(s[i] - b[i] + prime)
	}
}

// kModRoots = [pow(17, 2*bitreverse(i) + 1, p) for i in range(128)]
var modRoots = [128]uint16{
	17, 3312, 2761, 568, 583, 2746, 2649, 680, 1637, 1692, 723, 2606,
	2288, 1041, 1100, 2229, 1409, 1920, 2662, 667, 3281, 48, 233, 3096,
	756, 2573, 2156, 1173, 3015, 314, 3050, 279, 1703, 1626, 1651, 1678,
	2789, 540, 1789, 1540, 1847, 1482, 952, 2377, 1461, 1868, 2687, 642,
	939, 2390, 2308, 1021, 2437, 892, 2388, 941, 733, 2596, 2337, 992,
	268, 3061, 641, 2688, 1584, 1745, 2298, 1031, 2037, 1292, 3220, 109,
	375, 2954, 2549, 780, 2090, 1239, 1645, 1684, 1063, 2266, 319, 3010,
	2773, 556, 757, 2572, 2099, 1230, 561, 2768, 2466, 863, 2594, 735,
	2804, 525, 1092, 2237, 403, 2926, 1026, 2303, 1143, 2186, 2150, 1179,
	2775, 554, 886, 2443, 1722, 1607, 1212, 2117, 1874, 1455, 1029, 2300,
	2110, 1219, 2935, 394, 885, 2444, 2154, 1175,
}

func (s *scalar) mult(a, b *scalar) {
	for i := 0; i < degree/2; i++ {
		realReal := uint32(a[2*i]) * uint32(b[2*i])
		imgImg := uint32(a[2*i+1]) * uint32(b[2*i+1])
		realImg := uint32(a[2*i]) * uint32(b[2*i+1])
		imgReal := uint32(a[2*i+1]) * uint32(b[2*i])
		s[2*i] = reduce(realReal + uint32(reduce(imgImg))*uint32(modRoots[i]))
		s[2*i+1] = reduce(imgReal + realImg)
	}
}

func (s *scalar) innerProduct(left, right *vector) {
	s.zero()
	var product scalar
	for i := range left {
		product.mult(&left[i], &right[i])
		s.add(&product)
	}
}

func (s *scalar) fromKeccakVartime(keccak io.Reader) {
	var buf [3]byte
	for i := 0; i < len(s); {
		keccak.Read(buf[:])
		d1 := uint16(buf[0]) + 256*uint16(buf[1]%16)
		d2 := uint16(buf[1])/16 + 16*uint16(buf[2])
		if d1 < prime {
			s[i] = d1
			i++
		}
		if d2 < prime && i < len(s) {
			s[i] = d2
			i++
		}
	}
}

func (s *scalar) centeredBinomialEta2(input *[33]byte) {
	entropy := sha3.SumSHAKE256(input[:], 128)

	for i := 0; i < len(s); i += 2 {
		b := uint16(entropy[i/2])

		value := uint16(prime)
		value += (b & 1) + ((b >> 1) & 1)
		value -= ((b >> 2) & 1) + ((b >> 3) & 1)
		s[i] = reduceOnce(value)

		b >>= 4
		value = prime
		value += (b & 1) + ((b >> 1) & 1)
		value -= ((b >> 2) & 1) + ((b >> 3) & 1)
		s[i+1] = reduceOnce(value)
	}
}

var masks = [8]uint16{0x01, 0x03, 0x07, 0x0f, 0x1f, 0x3f, 0x7f, 0xff}

func (s *scalar) encode(out []byte, bits int) []byte {
	var outByte byte
	outByteBits := 0

	for i := range s {
		element := s[i]
		elementBitsDone := 0

		for elementBitsDone < bits {
			chunkBits := bits - elementBitsDone
			outBitsRemaining := 8 - outByteBits
			if chunkBits >= outBitsRemaining {
				chunkBits = outBitsRemaining
				outByte |= byte(element&masks[chunkBits-1]) << outByteBits
				out[0] = outByte
				out = out[1:]
				outByteBits = 0
				outByte = 0
			} else {
				outByte |= byte(element&masks[chunkBits-1]) << outByteBits
				outByteBits += chunkBits
			}

			elementBitsDone += chunkBits
			element >>= chunkBits
		}
	}

	if outByteBits > 0 {
		out[0] = outByte
		out = out[1:]
	}

	return out
}

func (s *scalar) decode(in []byte, bits int) ([]byte, bool) {
	var inByte byte
	inByteBitsLeft := 0

	for i := range s {
		var element uint16
		elementBitsDone := 0

		for elementBitsDone < bits {
			if inByteBitsLeft == 0 {
				inByte = in[0]
				in = in[1:]
				inByteBitsLeft = 8
			}

			chunkBits := bits - elementBitsDone
			if chunkBits > inByteBitsLeft {
				chunkBits = inByteBitsLeft
			}

			element |= (uint16(inByte) & masks[chunkBits-1]) << elementBitsDone
			inByteBitsLeft -= chunkBits
			inByte >>= chunkBits

			elementBitsDone += chunkBits
		}

		if element >= prime {
			return nil, false
		}
		s[i] = element
	}

	return in, true
}

func (s *scalar) compress(bits int) {
	for i := range s {
		s[i] = compress(s[i], bits)
	}
}

func (s *scalar) decompress(bits int) {
	for i := range s {
		s[i] = decompress(s[i], bits)
	}
}

type vector [rank]scalar

func (v *vector) zero() {
	for i := range v {
		v[i].zero()
	}
}

func (v *vector) ntt() {
	for i := range v {
		v[i].ntt()
	}
}

func (v *vector) inverseNTT() {
	for i := range v {
		v[i].inverseNTT()
	}
}

func (v *vector) add(b *vector) {
	for i := range v {
		v[i].add(&b[i])
	}
}

func (out *vector) mult(m *matrix, v *vector) {
	out.zero()
	var product scalar
	for i := 0; i < rank; i++ {
		for j := 0; j < rank; j++ {
			product.mult(&m[i][j], &v[j])
			out[i].add(&product)
		}
	}
}

func (out *vector) multTranspose(m *matrix, v *vector) {
	out.zero()
	var product scalar
	for i := 0; i < rank; i++ {
		for j := 0; j < rank; j++ {
			product.mult(&m[j][i], &v[j])
			out[i].add(&product)
		}
	}
}

func (v *vector) generateSecretEta2(counter *byte, seed *[32]byte) {
	var input [33]byte
	copy(input[:], seed[:])
	for i := range v {
		input[32] = *counter
		*counter++
		v[i].centeredBinomialEta2(&input)
	}
}

func (v *vector) encode(out []byte, bits int) []byte {
	for i := range v {
		out = v[i].encode(out, bits)
	}
	return out
}

func (v *vector) decode(out []byte, bits int) ([]byte, bool) {
	var ok bool
	for i := range v {
		out, ok = v[i].decode(out, bits)
		if !ok {
			return nil, false
		}
	}

	return out, true
}

func (v *vector) compress(bits int) {
	for i := range v {
		v[i].compress(bits)
	}
}

func (v *vector) decompress(bits int) {
	for i := range v {
		v[i].decompress(bits)
	}
}

type matrix [rank][rank]scalar

func (m *matrix) expand(rho *[32]byte) {
	shake := sha3.NewSHAKE128()

	var input [34]byte
	copy(input[:], rho[:])

	for i := 0; i < rank; i++ {
		for j := 0; j < rank; j++ {
			input[32] = byte(i)
			input[33] = byte(j)

			shake.Reset()
			shake.Write(input[:])
			m[i][j].fromKeccakVartime(shake)
		}
	}
}

type PublicKey struct {
	t             vector
	rho           [32]byte
	publicKeyHash [32]byte
	m             matrix
}

func UnmarshalPublicKey(data *[PublicKeySize]byte) (*PublicKey, bool) {
	var ret PublicKey
	ret.publicKeyHash = sha3.Sum256(data[:])
	in, ok := ret.t.decode(data[:], log2Prime)
	if !ok {
		return nil, false
	}
	copy(ret.rho[:], in)
	ret.m.expand(&ret.rho)
	return &ret, true
}

func (pub *PublicKey) Marshal() *[PublicKeySize]byte {
	var ret [PublicKeySize]byte
	out := pub.t.encode(ret[:], log2Prime)
	copy(out, pub.rho[:])
	return &ret
}

func (pub *PublicKey) encryptCPA(message, entropy *[32]byte) *[CiphertextSize]byte {
	var counter uint8
	var secret, error vector
	secret.generateSecretEta2(&counter, entropy)
	error.generateSecretEta2(&counter, entropy)
	secret.ntt()

	var input [33]byte
	copy(input[:], entropy[:])
	input[32] = counter
	var scalarError scalar
	scalarError.centeredBinomialEta2(&input)

	var u vector
	u.mult(&pub.m, &secret)
	u.inverseNTT()
	u.add(&error)

	var v scalar
	v.innerProduct(&pub.t, &secret)
	v.inverseNTT()
	v.add(&scalarError)

	out := make([]byte, CiphertextSize)
	var expandedMessage scalar
	expandedMessage.decode(message[:], 1)
	expandedMessage.decompress(1)
	v.add(&expandedMessage)
	u.compress(du)
	it := u.encode(out, du)
	v.compress(dv)
	v.encode(it, dv)
	return (*[CiphertextSize]byte)(out)
}

func (pub *PublicKey) Encap(outSharedSecret []byte, entropy *[32]byte) *[CiphertextSize]byte {
	var input [64]byte
	copy(input[:], entropy[:])
	copy(input[32:], pub.publicKeyHash[:])
	prekeyAndRandomness := sha3.Sum512(input[:])
	ciphertext := pub.encryptCPA(entropy, (*[32]byte)(prekeyAndRandomness[32:]))
	ciphertextHash := sha3.Sum256(ciphertext[:])
	copy(prekeyAndRandomness[32:], ciphertextHash[:])
	copy(outSharedSecret, sha3.SumSHAKE256(prekeyAndRandomness[:], len(outSharedSecret)))
	return ciphertext
}

type PrivateKey struct {
	PublicKey
	s               vector
	foFailureSecret [32]byte
}

func NewPrivateKey(entropy *[64]byte) (*PrivateKey, *[PublicKeySize]byte) {
	hashed := sha3.Sum512(entropy[:32])
	rho := (*[32]byte)(hashed[:32])
	sigma := (*[32]byte)(hashed[32:])
	ret := new(PrivateKey)
	copy(ret.foFailureSecret[:], entropy[32:])
	copy(ret.rho[:], rho[:])
	ret.m.expand(rho)
	counter := uint8(0)
	ret.s.generateSecretEta2(&counter, sigma)
	ret.s.ntt()
	var error vector
	error.generateSecretEta2(&counter, sigma)
	error.ntt()
	ret.t.multTranspose(&ret.m, &ret.s)
	ret.t.add(&error)

	marshalledPublicKey := ret.PublicKey.Marshal()
	ret.publicKeyHash = sha3.Sum256(marshalledPublicKey[:])

	return ret, marshalledPublicKey
}

func (priv *PrivateKey) decryptCPA(ciphertext *[CiphertextSize]byte) [32]byte {
	var u vector
	u.decode(ciphertext[:], du)
	u.decompress(du)
	u.ntt()

	var v scalar
	v.decode(ciphertext[compressedVectorSize:], dv)
	v.decompress(dv)

	var mask scalar
	mask.innerProduct(&priv.s, &u)
	mask.inverseNTT()
	v.sub(&mask)
	v.compress(1)
	var out [32]byte
	v.encode(out[:], 1)
	return out
}

func (priv *PrivateKey) Decap(outSharedSecret []byte, ciphertext *[CiphertextSize]byte) {
	decrypted := priv.decryptCPA(ciphertext)
	h := sha3.New512()
	h.Write(decrypted[:])
	h.Write(priv.publicKeyHash[:])
	prekeyAndRandomness := h.Sum(nil)
	expectedCiphertext := priv.encryptCPA(&decrypted, (*[32]byte)(prekeyAndRandomness[32:]))
	equal := subtle.ConstantTimeCompare(ciphertext[:], expectedCiphertext[:])
	var secret [32]byte
	for i := range secret {
		secret[i] = byte(subtle.ConstantTimeSelect(equal, int(prekeyAndRandomness[i]), int(priv.foFailureSecret[i])))
	}
	ciphertextHash := sha3.Sum256(ciphertext[:])

	shake := sha3.NewSHAKE256()
	shake.Write(secret[:])
	shake.Write(ciphertextHash[:])
	shake.Read(outSharedSecret)
}

func (priv *PrivateKey) Marshal() *[PrivateKeySize]byte {
	var ret [PrivateKeySize]byte
	out := priv.s.encode(ret[:], log2Prime)
	publicKey := priv.PublicKey.Marshal()
	n := copy(out, publicKey[:])
	out = out[n:]
	n = copy(out, priv.publicKeyHash[:])
	out = out[n:]
	copy(out, priv.foFailureSecret[:])
	return &ret
}
