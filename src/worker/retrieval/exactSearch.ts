import type { EvidenceResult } from "./types";

export type ExactSearchOptions = {
	limit?: number;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;

export async function searchExactEvidence(
	db: D1Database,
	query: string,
	options: ExactSearchOptions = {},
): Promise<EvidenceResult[]> {
	const normalizedQuery = query.trim();

	if (!normalizedQuery) {
		return [];
	}

	const ftsQuery = buildFtsQuery(normalizedQuery);
	const limit = clampLimit(options.limit);

	const rows = await db
		.prepare(
			`
			SELECT
				source_chunks.id AS chunk_id,
				source_chunks.document_id,
				source_chunks.title,
				source_chunks.source_type,
				source_chunks.repository_name,
				source_chunks.file_path,
				source_chunks.commit_sha,
				source_chunks.public_url,
				source_chunks.content,
				source_chunks.metadata_json AS metadata,
				bm25(source_chunks_fts) AS score
			FROM source_chunks_fts
			JOIN source_chunks
				ON source_chunks_fts.rowid = source_chunks.rowid
			WHERE source_chunks_fts MATCH ?
			ORDER BY score
			LIMIT ?;
			`,
		)
		.bind(ftsQuery, limit)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceResult["sourceType"];
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			metadata: string | null;
			score: number;
		}>();

	return rows.results.map((row) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: row.score,
		retrievalMode: "exact",
		metadata: parseMetadata(row.metadata),
	}));
}

function buildFtsQuery(query: string): string {
	const quotedTerms = query
		.split(/\s+/)
		.map((term) => term.replace(/"/g, "").trim())
		.filter(Boolean)
		.map((term) => `"${term}"`);

	return quotedTerms.length > 0 ? quotedTerms.join(" OR ") : `"${query}"`;
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		return DEFAULT_LIMIT;
	}

	return Math.min(Math.max(limit, 1), MAX_LIMIT);
}

function parseMetadata(value: string | null | undefined): Record<string, unknown> {
	if (!value) {
		return {};
	}

	try {
		const parsedValue = JSON.parse(value);
		return parsedValue && typeof parsedValue === "object"
			? parsedValue as Record<string, unknown>
			: {};
	} catch {
		return {};
	}
}
