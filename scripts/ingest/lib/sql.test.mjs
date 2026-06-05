import assert from "node:assert/strict";
import test from "node:test";
import { createRunId, sqlJson, sqlNumber, sqlString } from "./sql.mjs";

test("sqlString escapes quotes and handles null", () => {
	assert.equal(sqlString("Vansh's project"), "'Vansh''s project'");
	assert.equal(sqlString(null), "NULL");
	assert.equal(sqlString(undefined), "NULL");
});

test("sqlJson serialises objects as escaped SQL strings", () => {
	assert.equal(sqlJson({ title: "Vansh's Resume" }), `'{"title":"Vansh''s Resume"}'`);
});

test("sqlNumber rejects non-finite values", () => {
	assert.equal(sqlNumber(42), "42");
	assert.throws(() => sqlNumber(Number.NaN), /Invalid SQL number/);
});

test("createRunId creates migration-safe identifiers", () => {
	const runId = createRunId("2026-06-05T10:20:30.123Z");

	assert.equal(runId, "ingestion_20260605_102030123");
});
