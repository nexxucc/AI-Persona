import type { EvidenceResult, EvidenceSourceType } from "./types";

export type ExactEvidenceResult = EvidenceResult & {
	retrievalMode: "exact";
};

export type ExactSearchOptions = {
	limit?: number;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 12;

export async function searchExactEvidence(
	db: D1Database,
	query: string,
	options: ExactSearchOptions = {},
): Promise<ExactEvidenceResult[]> {
	const normalizedQuery = query.trim();

	if (!normalizedQuery) {
		return [];
	}

	const limit = clampLimit(options.limit);
	const ftsQuery = buildFtsQuery(normalizedQuery);

	if (!ftsQuery) {
		return [];
	}

	const result = await db
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
				bm25(source_chunks_fts) AS score
			FROM source_chunks_fts
			JOIN source_chunks
				ON source_chunks_fts.rowid = source_chunks.rowid
			WHERE source_chunks_fts MATCH ?
			ORDER BY score ASC
			LIMIT ?
			`,
		)
		.bind(ftsQuery, limit)
		.all<{
			chunk_id: string;
			document_id: string;
			title: string;
			source_type: EvidenceSourceType;
			repository_name: string | null;
			file_path: string | null;
			commit_sha: string | null;
			public_url: string;
			content: string;
			score: number;
		}>();

	return (result.results ?? []).map((row) => ({
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
	}));
}

export function buildFtsQuery(query: string): string {
	const terms = extractSearchTerms(query);

	return terms.map((term) => `"${escapeFtsPhrase(term)}"`).join(" OR ");
}

export function extractSearchTerms(query: string): string[] {
	const normalized = query
		.replace(/[^\p{L}\p{N}_./+#-]+/gu, " ")
		.split(/\s+/)
		.map((term) => term.trim())
		.filter(Boolean)
		.filter((term) => term.length >= 2);

	return [...new Set(normalized)].slice(0, 12);
}

function escapeFtsPhrase(value: string): string {
	return value.replaceAll('"', '""');
}

function clampLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		return DEFAULT_LIMIT;
	}

	return Math.min(Math.max(limit, 1), MAX_LIMIT);
}
