import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const outputPath = "local-data/generated/development-chunks.json";

const query = `
SELECT
	id,
	vector_id,
	title,
	source_type,
	repository_name,
	file_path,
	commit_sha,
	public_url,
	content,
	metadata_json
FROM source_chunks
ORDER BY id;
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
		query,
	],
	{
		maxBuffer: 1024 * 1024 * 64,
	},
);

const parsed = JSON.parse(stdout);
const rows = parsed[0]?.results ?? [];

if (!Array.isArray(rows) || rows.length === 0) {
	throw new Error("No source chunks were returned from persona-db-dev.");
}

const chunks = rows.map((row) => ({
	id: row.id,
	vector_id: row.vector_id,
	title: row.title,
	source_type: row.source_type,
	repository_name: row.repository_name,
	file_path: row.file_path,
	commit_sha: row.commit_sha,
	public_url: row.public_url,
	content: row.content,
	metadata: JSON.parse(row.metadata_json ?? "{}"),
}));

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(chunks, null, 2)}\n`, "utf8");

console.log(`Development chunks exported: ${chunks.length}`);
console.log(`Output written to: ${outputPath}`);
