import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	createIsoTimestamp,
	createRunId,
	sqlJson,
	sqlNumber,
	sqlString,
} from "./lib/sql.mjs";

const resumePreviewPath = "local-data/generated/resume-corpus-preview.json";
const githubPreviewPath = "local-data/generated/github-corpus-preview.json";
const sqlOutputPath = "local-data/generated/development-corpus.sql";
const reportOutputPath = "local-data/generated/development-corpus-report.json";

const [resumePreview, githubPreview] = await Promise.all([
	readJson(resumePreviewPath),
	readJson(githubPreviewPath),
]);

const timestamp = createIsoTimestamp();
const runId = createRunId(timestamp);

const documents = [
	resumePreview.document,
	...githubPreview.documents,
];

const chunks = [
	...resumePreview.chunks,
	...githubPreview.chunks,
];

assertUnique(documents.map((document) => document.id), "document ids");
assertUnique(documents.map((document) => document.source_key), "document source keys");
assertUnique(chunks.map((chunk) => chunk.id), "chunk ids");
assertUnique(chunks.map((chunk) => chunk.vector_id), "chunk vector ids");

const sql = [
	"PRAGMA foreign_keys=ON;",
	"",
	"DELETE FROM source_documents",
	"WHERE source_key LIKE 'resume:%'",
	"   OR source_key LIKE 'github:%';",
	"",
	"DELETE FROM ingestion_runs",
	`WHERE id = ${sqlString(runId)};`,
	"",
	"INSERT INTO ingestion_runs (",
	"\tid,",
	"\ttrigger_type,",
	"\tstatus,",
	"\tstarted_at,",
	"\tcompleted_at,",
	"\tdocuments_processed,",
	"\tchunks_indexed",
	") VALUES (",
	`\t${sqlString(runId)},`,
	"\t'manual',",
	"\t'completed',",
	`\t${sqlString(timestamp)},`,
	`\t${sqlString(timestamp)},`,
	`\t${sqlNumber(documents.length)},`,
	`\t${sqlNumber(chunks.length)}`,
	");",
	"",
	...documents.map((document) => createDocumentInsert(document, runId, timestamp)),
	...chunks.map(createChunkInsert),
	"",
].join("\n");

const report = {
	run_id: runId,
	generated_at: timestamp,
	resume: resumePreview.report,
	github: githubPreview.report,
	total: {
		document_count: documents.length,
		chunk_count: chunks.length,
		character_count: documents.reduce(
			(total, document) => total + document.content.length,
			0,
		),
		largest_chunk_chars: Math.max(
			...chunks.map((chunk) => chunk.content.length),
		),
	},
};

await mkdir(dirname(sqlOutputPath), { recursive: true });
await writeFile(sqlOutputPath, sql, "utf8");
await writeFile(reportOutputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

console.log(`Development corpus SQL written to: ${sqlOutputPath}`);
console.log(`Development corpus report written to: ${reportOutputPath}`);
console.log(`Documents prepared: ${report.total.document_count}`);
console.log(`Chunks prepared: ${report.total.chunk_count}`);
console.log(`Characters prepared: ${report.total.character_count}`);
console.log(`Largest chunk characters: ${report.total.largest_chunk_chars}`);

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		throw new Error(
			`Could not read ${path}. Run the resume and GitHub preview scripts first. ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	}
}

function assertUnique(values, label) {
	const seen = new Set();

	for (const value of values) {
		if (seen.has(value)) {
			throw new Error(`Duplicate ${label} value found: ${value}`);
		}

		seen.add(value);
	}
}

function createDocumentInsert(document, ingestionRunId, timestamp) {
	return [
		"INSERT INTO source_documents (",
		"\tid,",
		"\tsource_type,",
		"\tsource_key,",
		"\trepository_owner,",
		"\trepository_name,",
		"\tfile_path,",
		"\tcommit_sha,",
		"\tpublic_url,",
		"\ttitle,",
		"\tcontent,",
		"\tcontent_hash,",
		"\tmetadata_json,",
		"\tlast_ingestion_run_id,",
		"\tindexed_at",
		") VALUES (",
		`\t${sqlString(document.id)},`,
		`\t${sqlString(document.source_type)},`,
		`\t${sqlString(document.source_key)},`,
		`\t${sqlString(document.repository_owner ?? null)},`,
		`\t${sqlString(document.repository_name ?? null)},`,
		`\t${sqlString(document.file_path ?? null)},`,
		`\t${sqlString(document.commit_sha ?? null)},`,
		`\t${sqlString(document.public_url)},`,
		`\t${sqlString(document.title)},`,
		`\t${sqlString(document.content)},`,
		`\t${sqlString(document.content_hash)},`,
		`\t${sqlJson(document.metadata)},`,
		`\t${sqlString(ingestionRunId)},`,
		`\t${sqlString(timestamp)}`,
		");",
		"",
	].join("\n");
}

function createChunkInsert(chunk) {
	return [
		"INSERT INTO source_chunks (",
		"\tid,",
		"\tdocument_id,",
		"\tchunk_index,",
		"\tcontent,",
		"\ttitle,",
		"\tsource_type,",
		"\trepository_name,",
		"\tfile_path,",
		"\tcommit_sha,",
		"\tpublic_url,",
		"\tcontent_hash,",
		"\tvector_id,",
		"\tmetadata_json",
		") VALUES (",
		`\t${sqlString(chunk.id)},`,
		`\t${sqlString(chunk.document_id)},`,
		`\t${sqlNumber(chunk.chunk_index)},`,
		`\t${sqlString(chunk.content)},`,
		`\t${sqlString(chunk.title)},`,
		`\t${sqlString(chunk.source_type)},`,
		`\t${sqlString(chunk.repository_name ?? null)},`,
		`\t${sqlString(chunk.file_path ?? null)},`,
		`\t${sqlString(chunk.commit_sha ?? null)},`,
		`\t${sqlString(chunk.public_url)},`,
		`\t${sqlString(chunk.content_hash)},`,
		`\t${sqlString(chunk.vector_id)},`,
		`\t${sqlJson(chunk.metadata)}`,
		");",
		"",
	].join("\n");
}
