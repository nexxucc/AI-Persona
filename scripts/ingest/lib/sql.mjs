export function sqlString(value) {
	if (value === null || value === undefined) {
		return "NULL";
	}

	return `'${String(value).replace(/\u0000/g, "").replaceAll("'", "''")}'`;
}

export function sqlNumber(value) {
	if (!Number.isFinite(value)) {
		throw new Error(`Invalid SQL number: ${value}`);
	}

	return String(value);
}

export function sqlJson(value) {
	return sqlString(JSON.stringify(value ?? {}));
}

export function createIsoTimestamp() {
	return new Date().toISOString();
}

export function createRunId(timestamp = createIsoTimestamp()) {
	return `ingestion_${timestamp.replace(/[-:.]/g, "").replace("T", "_").replace("Z", "")}`;
}
