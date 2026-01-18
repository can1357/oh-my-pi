for (const [key, value] of Object.entries(process.env)) {
	if (key.startsWith("PI_") && value !== undefined) {
		const ompKey = `OMP_${key.slice(3)}`; // PI_FOO -> OMP_FOO
		if (process.env[ompKey] === undefined) {
			process.env[ompKey] = value;
		}
	}
}
