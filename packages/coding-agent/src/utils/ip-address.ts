/** IP literal parsing and classification shared by the egress proxy and approval gating. */

/** The four octets of a dotted-quad IPv4 literal, or `undefined` when `value` is not one. */
export function parseIPv4(value: string): number[] | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		octets.push(octet);
	}
	return octets;
}

/** The eight 16-bit groups of an IPv6 literal (zone and embedded IPv4 tail allowed), or `undefined`. */
export function parseIPv6(value: string): number[] | undefined {
	let text = value;
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);
	if (!text.includes(":")) return undefined;
	// An embedded dotted IPv4 tail (`::ffff:1.2.3.4`) becomes two hex groups.
	const lastColon = text.lastIndexOf(":");
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseIPv4(tail);
		if (!v4) return undefined;
		text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const parseGroups = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const group of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
			groups.push(Number.parseInt(group, 16));
		}
		return groups;
	};
	const gap = text.indexOf("::");
	if (gap === -1) {
		const groups = parseGroups(text);
		return groups?.length === 8 ? groups : undefined;
	}
	if (text.indexOf("::", gap + 1) !== -1) return undefined;
	const head = parseGroups(text.slice(0, gap));
	const rest = parseGroups(text.slice(gap + 2));
	if (!head || !rest || head.length + rest.length >= 8) return undefined;
	return [...head, ...Array.from({ length: 8 - head.length - rest.length }, () => 0), ...rest];
}

function isPublicIPv4([a, b, c]: number[]): boolean {
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast/reserved
	if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
	if (a === 169 && b === 254) return false; // link-local
	if (a === 172 && b >= 16 && b <= 31) return false; // private
	if (a === 192 && b === 168) return false; // private
	if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	return true;
}

function embeddedIPv4(high: number, low: number): number[] {
	return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** False for loopback, private, link-local, unspecified, multicast and reserved addresses, and for non-literals. */
export function isPublicAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4) return isPublicIPv4(v4);
	const v6 = parseIPv6(address);
	if (!v6) return false;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = v6;
	const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	// ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped)
	if (zeroPrefix && (g5 === 0 || g5 === 0xffff)) return isPublicIPv4(embeddedIPv4(g6, g7));
	// NAT64 well-known prefix
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isPublicIPv4(embeddedIPv4(g6, g7));
	}
	if (g0 === 0x2002) return isPublicIPv4(embeddedIPv4(g1, g2)); // 6to4
	if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
	if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
	if ((g0 & 0xff00) === 0xff00) return false; // multicast
	return true;
}

/** True for loopback (127/8, ::1), unspecified (0/8, ::) and link-local (169.254/16, fe80::/10), IPv4-mapped forms included. */
export function isHostLocalAddress(address: string): boolean {
	let v4 = parseIPv4(address);
	if (!v4) {
		const v6 = parseIPv6(address);
		if (!v6) return true;
		const [g0, g1, g2, g3, g4, g5, g6, g7] = v6;
		if ((g0 & 0xffc0) === 0xfe80) return true;
		// ::/96 (covers :: and ::1) and ::ffff:0:0/96 carry an IPv4 address in the low 32 bits.
		if (g0 !== 0 || g1 !== 0 || g2 !== 0 || g3 !== 0 || g4 !== 0 || (g5 !== 0 && g5 !== 0xffff)) return false;
		v4 = embeddedIPv4(g6, g7);
	}
	const [a, b] = v4;
	return a === 0 || a === 127 || (a === 169 && b === 254);
}
