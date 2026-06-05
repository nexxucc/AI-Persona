import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const queries = [
	"LangGraph",
	"AI-Persona",
	"Firebase",
	"Paytm Ideathon",
];

for (const query of queries) {
	const ftsQuery = buildFtsQuery(query);

	const sql = `
	SELECT
		source_chunks.title,
		source_chunks.source_type,
		source_chunks.repository_name,
		source_chunks.file_path
	FROM source_chunks_fts
	JOIN source_chunks
		ON source_chunks_fts.rowid = source_chunks.rowid
	WHERE source_chunks_fts MATCH ${sqlString(ftsQuery)}
	LIMIT 5;
	`;

	const { stdout } = await execFileAsync(
		"npx",
		[
			"wrangler",
			"d1",
			"execute",
			"persona-db-dev",
			"--remote",
			"--env",
			"development",
			"--json",
			"--command",
			sql,
		],
		{
			maxBuffer: 1024 * 1024 * 8,
		},
	);

	const parsed = JSON.parse(stdout);
	const rows = parsed[0]?.results ?? [];

	console.log(`Query: ${query}`);
	console.log(`FTS: ${ftsQuery}`);
	console.log(`Results: ${rows.length}`);

	for (const row of rows.slice(0, 3)) {
		console.log(
			`- ${row.title} | ${row.source_type} | ${row.repository_name ?? "none"} | ${row.file_path ?? "none"}`,
		);
	}

	console.log("");
}

function buildFtsQuery(query) {
	const terms = query
		.replace(/[^\p{L}\p{N}_./+#-]+/gu, " ")
		.split(/\s+/)
		.map((term) => term.trim())
		.filter(Boolean)
		.filter((term) => term.length >= 2);

	return [...new Set(terms)]
		.map((term) => `"${term.replaceAll('"', '""')}"`)
		.join(" OR ");
}

function sqlString(value) {
	return `'${String(value).replace(/\u0000/g, "").replaceAll("'", "''")}'`;
}
