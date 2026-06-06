import { searchExactEvidence } from "./exactSearch";
import { searchSemanticEvidence } from "./semanticSearch";
import type { EvidenceResult } from "./types";

export type HybridRetrievalOptions = {
	exactLimit?: number;
	semanticLimit?: number;
	finalLimit?: number;
};

const DEFAULT_EXACT_LIMIT = 8;
const DEFAULT_SEMANTIC_LIMIT = 8;
const DEFAULT_FINAL_LIMIT = 10;
const MAX_FINAL_LIMIT = 16;

const AI_PROJECT_TERMS = [
	"ai",
	"ml",
	"machine learning",
	"llm",
	"rag",
	"langchain",
	"langgraph",
	"huggingface",
	"faiss",
	"nlp",
	"transformer",
	"tensorflow",
	"pytorch",
	"scikit",
	"model",
	"prediction",
	"semantic",
	"agent",
	"agents",
	"embedding",
	"vector",
];

export async function retrieveHybridEvidence(
	db: D1Database,
	vectorize: VectorizeIndex,
	geminiApiKeys: string[],
	query: string,
	options: HybridRetrievalOptions = {},
): Promise<EvidenceResult[]> {
	const normalizedQuery = query.trim();

	if (!normalizedQuery) {
		return [];
	}

	const projectQuery = isProjectOrRepositoryQuery(normalizedQuery);
	const broadProjectQuery = projectQuery && isBroadProjectQuery(normalizedQuery);
	const finalLimit = clampFinalLimit(options.finalLimit);

	const [exactSearchResult, semanticSearchResult, curatedProjectResult] =
		await Promise.allSettled([
			searchExactEvidence(db, normalizedQuery, {
				limit: options.exactLimit ?? (projectQuery ? 12 : DEFAULT_EXACT_LIMIT),
			}),
			searchSemanticEvidence(db, vectorize, geminiApiKeys, normalizedQuery, {
				limit: options.semanticLimit ?? (projectQuery ? 14 : DEFAULT_SEMANTIC_LIMIT),
			}),
			broadProjectQuery ? searchCuratedProjectSeeds(db) : Promise.resolve([]),
		]);

	const exactResults =
		exactSearchResult.status === "fulfilled" ? exactSearchResult.value : [];

	const semanticResults =
		semanticSearchResult.status === "fulfilled" ? semanticSearchResult.value : [];

	const curatedProjectResults =
		curatedProjectResult.status === "fulfilled" ? curatedProjectResult.value : [];

	if (exactSearchResult.status === "rejected" && semanticSearchResult.status === "rejected") {
		throw semanticSearchResult.reason;
	}

	const mergedResults = mergeEvidenceResults(
		[...curatedProjectResults, ...exactResults],
		semanticResults,
	);

	const curatedResults = broadProjectQuery
		? mergedResults.filter((result) => !shouldExcludeForBroadProjectAnswer(result))
		: mergedResults;

	const mentionedRepositoryNames = getMentionedRepositoryNames(
		curatedResults,
		normalizedQuery,
	);

	const commitHistoryQuery = isCommitHistoryQuery(normalizedQuery);

	// Resume-led seeding is only for truly general "what projects have you built"
	// questions. When a specific repository is named (e.g. "tell me about the
	// Assessment-Creator project"), scope to that repo instead so its README is
	// not displaced by unrelated resume chunks.
	const broadGeneralQuery = broadProjectQuery && mentionedRepositoryNames.size === 0;

	const commitEvidence =
		commitHistoryQuery && mentionedRepositoryNames.size > 0
			? await searchRepositoryCommitEvidence(db, mentionedRepositoryNames)
			: [];

	const repositoryExpansionResults =
		mentionedRepositoryNames.size > 0
			? await searchMentionedRepositoryEvidence(db, mentionedRepositoryNames)
			: [];

	const scopedBaseResults =
		projectQuery && mentionedRepositoryNames.size > 0
			? curatedResults.filter(
					(result) =>
						result.sourceType === "resume" ||
						!result.repositoryName ||
						mentionedRepositoryNames.has(result.repositoryName),
				)
			: curatedResults;

	const scopedResults =
		repositoryExpansionResults.length > 0
			? [...repositoryExpansionResults, ...scopedBaseResults]
			: scopedBaseResults;

	const rankedResults = projectQuery
		? diversifyProjectEvidence(scopedResults, normalizedQuery, broadGeneralQuery)
		: scopedResults;

	const dedupedResults = dedupeEvidenceForDisplay(
		rankedResults,
		projectQuery,
		broadGeneralQuery,
		normalizedQuery,
	);

	// Commit-history questions must lead with the actual commit evidence, which
	// generic project ranking buries beneath README/metadata chunks.
	const finalResults =
		commitEvidence.length > 0
			? dedupeByChunkId([...commitEvidence, ...dedupedResults])
			: dedupedResults;

	return finalResults.slice(0, finalLimit);
}

export function mergeEvidenceResults(
	exactResults: EvidenceResult[],
	semanticResults: EvidenceResult[],
): EvidenceResult[] {
	const merged = new Map<string, EvidenceResult>();

	for (const result of semanticResults) {
		merged.set(result.chunkId, result);
	}

	for (const result of exactResults) {
		const existing = merged.get(result.chunkId);

		if (!existing) {
			merged.set(result.chunkId, result);
			continue;
		}

		merged.set(result.chunkId, {
			...existing,
			score: combineScores(result.score, existing.score),
			retrievalMode: "hybrid",
			metadata: {
				...(existing.metadata ?? {}),
				...(result.metadata ?? {}),
			},
		});
	}

	return [...merged.values()].sort(compareEvidence);
}

function diversifyProjectEvidence(
	results: EvidenceResult[],
	query: string,
	broadQuery: boolean,
): EvidenceResult[] {
	const selected: EvidenceResult[] = [];
	const selectedChunkIds = new Set<string>();
	const selectedDocumentIds = new Set<string>();
	const selectedRepositories = new Set<string>();

	const pushResult = (result: EvidenceResult): void => {
		if (selectedChunkIds.has(result.chunkId)) {
			return;
		}

		selected.push(result);
		selectedChunkIds.add(result.chunkId);
		selectedDocumentIds.add(result.documentId);
	};

	const githubResults = results
		.filter((result) => result.sourceType !== "resume")
		.filter((result) => isRelevantProjectEvidence(result, query))
		.sort((left, right) => compareProjectEvidence(left, right, query));

	const resumeResults = results
		.filter((result) => result.sourceType === "resume")
		.sort(compareEvidence);

	// Broad "what projects have you built / your RAG projects" questions are best
	// answered from the resume: many repos have no README and only a thin
	// "No description provided" metadata chunk, so lead with the resume's
	// per-project descriptions before the repository chunks.
	if (broadQuery) {
		// Lead with the resume chunks whose text actually matches the query's key
		// terms (including short technical tokens like "n8n", "rag", "llm"), so a
		// question about a specific project surfaces that project's description
		// rather than another section that merely shares a generic keyword.
		const orderedResume = [...resumeResults].sort(
			(left, right) =>
				scoreResumeQueryRelevance(right, query) - scoreResumeQueryRelevance(left, query),
		);

		for (const result of orderedResume.slice(0, 3)) {
			pushResult(result);
		}
	}

	const githubLimit = broadQuery ? 9 : 6;

	for (const result of githubResults) {
		const repositoryKey = result.repositoryName ?? result.documentId;

		if (selectedRepositories.has(repositoryKey)) {
			continue;
		}

		pushResult(result);
		selectedRepositories.add(repositoryKey);

		if (selected.length >= githubLimit) {
			break;
		}
	}

	if (!broadQuery) {
		const resumeSupportLimit = selected.length >= 4 ? 2 : 1;

		for (const result of resumeResults.slice(0, resumeSupportLimit)) {
			pushResult(result);
		}
	}

	for (const result of results) {
		if (result.sourceType === "resume" && selected.length < 8) {
			continue;
		}

		pushResult(result);
	}

	return selected;
}

function shouldExcludeForBroadProjectAnswer(result: EvidenceResult): boolean {
	if (result.sourceType === "resume") {
		return false;
	}

	const curation = getCurationMetadata(result);

	return (
		curation.status === "exclude_from_general_answers" ||
		curation.status === "low_signal" ||
		curation.status === "duplicate" ||
		curation.status === "non_working_copy" ||
		curation.priority === "exclude_from_general_answers" ||
		curation.lowSignal === true
	);
}

function isRelevantProjectEvidence(result: EvidenceResult, query: string): boolean {
	if (result.sourceType === "resume") {
		return true;
	}

	if (shouldExcludeForBroadProjectAnswer(result)) {
		return false;
	}

	if (result.metadata?.curated_seed === true) {
		return true;
	}

	const curation = getCurationMetadata(result);

	if (
		curation.status === "canonical" ||
		curation.status === "active" ||
		curation.priority === "high"
	) {
		return true;
	}

	const searchableText = [
		result.title,
		result.repositoryName,
		result.filePath,
		result.content,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	const normalizedQuery = query.toLowerCase();
	const queryTerms = extractMeaningfulTerms(normalizedQuery);

	if (queryTerms.some((term) => searchableText.includes(term))) {
		return true;
	}

	if (isAiProjectQuery(normalizedQuery)) {
		return AI_PROJECT_TERMS.some((term) => searchableText.includes(term));
	}

	return false;
}

const RESUME_RELEVANCE_STOPWORDS = new Set([
	"what",
	"did",
	"does",
	"with",
	"and",
	"the",
	"your",
	"you",
	"kind",
	"have",
	"has",
	"worked",
	"work",
	"vansh",
	"jain",
	"project",
	"projects",
	"about",
	"tell",
	"for",
	"are",
	"his",
	"built",
	"build",
	"made",
	"most",
]);

function scoreResumeQueryRelevance(result: EvidenceResult, query: string): number {
	const content = result.content.toLowerCase();
	const terms = new Set(
		query
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter((term) => term.length >= 3 && !RESUME_RELEVANCE_STOPWORDS.has(term)),
	);

	let score = 0;

	for (const term of terms) {
		if (content.includes(term)) {
			score += 1;
		}
	}

	return score;
}

function extractMeaningfulTerms(query: string): string[] {
	return query
		.split(/[^a-z0-9]+/i)
		.map((term) => term.trim().toLowerCase())
		.filter((term) => term.length >= 4)
		.filter(
			(term) =>
				![
					"what",
					"kind",
					"have",
					"worked",
					"with",
					"your",
					"you",
					"about",
					"tell",
					"project",
					"projects",
					"repo",
					"repository",
					"github",
				].includes(term),
		);
}

function compareEvidence(left: EvidenceResult, right: EvidenceResult): number {
	const modeDifference =
		modePriority(right.retrievalMode) - modePriority(left.retrievalMode);

	if (modeDifference !== 0) {
		return modeDifference;
	}

	return normalizeScore(right.score) - normalizeScore(left.score);
}

function compareProjectEvidence(
	left: EvidenceResult,
	right: EvidenceResult,
	query: string,
): number {
	const relevanceDifference =
		projectRelevanceScore(right, query) - projectRelevanceScore(left, query);

	if (relevanceDifference !== 0) {
		return relevanceDifference;
	}

	const sourceDifference =
		sourcePriority(right.sourceType) - sourcePriority(left.sourceType);

	if (sourceDifference !== 0) {
		return sourceDifference;
	}

	return compareEvidence(left, right);
}

function projectRelevanceScore(result: EvidenceResult, query: string): number {
	const searchableText = [
		result.title,
		result.repositoryName,
		result.filePath,
		result.content,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();

	const queryTerms = extractMeaningfulTerms(query);
	const curation = getCurationMetadata(result);
	let score = 0;

	if (result.metadata?.curated_seed === true) {
		score += 50;
	}

	if (curation.priority === "high") {
		score += 25;
	}

	if (curation.status === "canonical") {
		score += 20;
	}

	if (curation.status === "active") {
		score += 12;
	}

	if (curation.status === "prototype") {
		score += 4;
	}

	if (curation.priority === "low") {
		score -= 4;
	}

	if (curation.canonicalRepository) {
		score -= 8;
	}

	for (const term of queryTerms) {
		if (searchableText.includes(term)) {
			score += 4;
		}
	}

	if (isAiProjectQuery(query)) {
		for (const term of AI_PROJECT_TERMS) {
			if (searchableText.includes(term)) {
				score += 1;
			}
		}
	}

	if (result.sourceType === "github_readme") {
		score += 7;
	}

	if (result.sourceType === "github_document") {
		score += 6;
	}

	if (result.sourceType === "github_manifest") {
		score += 4;
	}

	if (result.sourceType === "github_repository") {
		score += 3;
	}

	if (result.sourceType === "github_commit") {
		score += 2;
	}

	// A bare repository-metadata chunk with no description carries no substance
	// to explain a project; push it below resume / README / document evidence.
	if (
		result.sourceType === "github_repository" &&
		searchableText.includes("no description provided")
	) {
		score -= 12;
	}

	if (shouldExcludeForBroadProjectAnswer(result)) {
		score -= 100;
	}

	return score;
}

function modePriority(mode: EvidenceResult["retrievalMode"]): number {
	if (mode === "hybrid") {
		return 3;
	}

	if (mode === "semantic") {
		return 2;
	}

	return 1;
}

function sourcePriority(sourceType: EvidenceResult["sourceType"]): number {
	if (sourceType === "github_readme") {
		return 6;
	}

	if (sourceType === "github_document") {
		return 5;
	}

	if (sourceType === "github_manifest") {
		return 4;
	}

	if (sourceType === "github_repository") {
		return 3;
	}

	if (sourceType === "github_commit") {
		return 2;
	}

	return 1;
}

function combineScores(exactScore: number, semanticScore: number): number {
	return normalizeScore(semanticScore) + 1 / (1 + Math.abs(exactScore));
}

function normalizeScore(score: number): number {
	if (!Number.isFinite(score)) {
		return 0;
	}

	return score;
}

function clampFinalLimit(limit: number | undefined): number {
	if (typeof limit !== "number" || !Number.isInteger(limit)) {
		return DEFAULT_FINAL_LIMIT;
	}

	return Math.min(Math.max(limit, 1), MAX_FINAL_LIMIT);
}

function isProjectOrRepositoryQuery(query: string): boolean {
	const normalizedQuery = query.toLowerCase();

	return [
		"project",
		"projects",
		"built",
		"build",
		"github",
		"repo",
		"repository",
		"repositories",
		"readme",
		"commit",
		"tech stack",
		"design",
		"tradeoff",
		"tradeoffs",
		"differently",
		"improve",
		"architecture",
		"implementation",
		"chandraquant",
		"nlp",
		"rag",
		"shopify",
		"drone",
		"cell signal",
	].some((keyword) => normalizedQuery.includes(keyword));
}

function isCommitHistoryQuery(query: string): boolean {
	const normalizedQuery = query.toLowerCase();

	return [
		"commit",
		"commits",
		"commit history",
		"recent changes",
		"what changed",
		"recently changed",
		"repository history",
		"repo history",
		"change history",
	].some((keyword) => normalizedQuery.includes(keyword));
}

function dedupeByChunkId(results: EvidenceResult[]): EvidenceResult[] {
	const seen = new Set<string>();
	const deduped: EvidenceResult[] = [];

	for (const result of results) {
		if (seen.has(result.chunkId)) {
			continue;
		}

		seen.add(result.chunkId);
		deduped.push(result);
	}

	return deduped;
}

async function searchRepositoryCommitEvidence(
	db: D1Database,
	repositoryNames: Set<string>,
): Promise<EvidenceResult[]> {
	const names = [...repositoryNames].filter(Boolean);

	if (names.length === 0) {
		return [];
	}

	const placeholders = names.map(() => "?").join(", ");

	const rows = await db
		.prepare(
			`
			SELECT
				id AS chunk_id,
				document_id,
				title,
				source_type,
				repository_name,
				file_path,
				commit_sha,
				public_url,
				content,
				metadata_json AS metadata
			FROM source_chunks
			WHERE repository_name IN (${placeholders})
				AND source_type = 'github_commit'
			ORDER BY repository_name ASC, chunk_index ASC, id ASC
			LIMIT 8;
			`,
		)
		.bind(...names)
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
		}>();

	return rows.results.map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 120 - index,
		retrievalMode: "exact",
		metadata: {
			...parseMetadata(row.metadata),
			commit_evidence: true,
		},
	}));
}

function isBroadProjectQuery(query: string): boolean {
	const normalizedQuery = query.toLowerCase();

	return [
		"project",
		"projects",
		"built",
		"build",
		"github",
		"repo",
		"repository",
		"repositories",
		"work",
		"worked",
		"ai",
		"ml",
		"machine learning",
		"top",
		"best",
		"strongest",
		"review",
	].some((keyword) => normalizedQuery.includes(keyword));
}

function isAiProjectQuery(query: string): boolean {
	return [
		"ai",
		"ml",
		"machine learning",
		"llm",
		"rag",
		"nlp",
		"agent",
		"agents",
	].some((keyword) => query.includes(keyword));
}

async function searchCuratedProjectSeeds(db: D1Database): Promise<EvidenceResult[]> {
	const rows = await db
		.prepare(
			`
			WITH ranked_project_chunks AS (
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
					ROW_NUMBER() OVER (
						PARTITION BY source_chunks.repository_name
						ORDER BY
							CASE
								WHEN source_chunks.title LIKE '%Evidence Summary%' THEN 1
								WHEN source_chunks.file_path = 'README.md' THEN 2
								WHEN source_chunks.file_path = 'PROJECT_SUMMARY.md' THEN 3
								WHEN source_chunks.file_path LIKE '%/README.md' THEN 4
								ELSE 5
							END,
							source_chunks.chunk_index ASC
					) AS repository_rank
				FROM source_chunks
				WHERE source_chunks.repository_name IS NOT NULL
				AND source_chunks.source_type IN (
					'github_repository',
					'github_readme',
					'github_document',
					'github_manifest'
				)
				AND (
					source_chunks.title LIKE '%Evidence Summary%'
					OR source_chunks.file_path = 'README.md'
					OR source_chunks.file_path = 'PROJECT_SUMMARY.md'
					OR source_chunks.file_path LIKE '%/README.md'
				)
				AND (
					json_extract(source_chunks.metadata_json, '$.curation.status') = 'canonical'
					OR json_extract(source_chunks.metadata_json, '$.curation.status') = 'active'
					OR json_extract(source_chunks.metadata_json, '$.curation.priority') = 'high'
				)
				AND COALESCE(json_extract(source_chunks.metadata_json, '$.curation.priority'), '') != 'exclude_from_general_answers'
				AND COALESCE(json_extract(source_chunks.metadata_json, '$.curation.status'), '') NOT IN (
					'exclude_from_general_answers',
					'low_signal',
					'duplicate',
					'non_working_copy'
				)
			)
			SELECT
				chunk_id,
				document_id,
				title,
				source_type,
				repository_name,
				file_path,
				commit_sha,
				public_url,
				content,
				metadata
			FROM ranked_project_chunks
			WHERE repository_rank = 1
			ORDER BY
				CASE
					WHEN json_extract(metadata, '$.curation.priority') = 'high' THEN 1
					WHEN json_extract(metadata, '$.curation.status') = 'canonical' THEN 2
					WHEN json_extract(metadata, '$.curation.status') = 'active' THEN 3
					ELSE 4
				END,
				repository_name ASC
			LIMIT 16;
			`,
		)
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
		}>();

	return rows.results.map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 100 - index,
		retrievalMode: "exact",
		metadata: {
			...parseMetadata(row.metadata),
			curated_seed: true,
		},
	}));
}

function getCurationMetadata(result: EvidenceResult): {
	status?: string;
	priority?: string;
	canonicalRepository?: string;
	lowSignal?: boolean;
} {
	const metadata = result.metadata ?? {};
	const curation =
		metadata.curation && typeof metadata.curation === "object"
			? metadata.curation as Record<string, unknown>
			: {};

	return {
		status:
			asString(curation.status) ??
			asString(metadata.status) ??
			asString(metadata.curated_status),
		priority:
			asString(curation.priority) ??
			asString(metadata.priority) ??
			asString(metadata.curated_priority),
		canonicalRepository:
			asString(curation.canonical_repository) ??
			asString(metadata.canonical_repository),
		lowSignal:
			asBoolean(metadata.low_signal) ??
			asBoolean(curation.low_signal),
	};
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

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}



async function searchMentionedRepositoryEvidence(
	db: D1Database,
	repositoryNames: Set<string>,
): Promise<EvidenceResult[]> {
	const names = [...repositoryNames].filter(Boolean);

	if (names.length === 0) {
		return [];
	}

	const placeholders = names.map(() => "?").join(", ");

	const rows = await db
		.prepare(
			`
			WITH ranked_repository_chunks AS (
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
					ROW_NUMBER() OVER (
						PARTITION BY source_chunks.document_id
						ORDER BY source_chunks.chunk_index ASC
					) AS document_chunk_rank
				FROM source_chunks
				WHERE source_chunks.repository_name IN (${placeholders})
				AND source_chunks.source_type IN (
					'github_readme',
					'github_repository',
					'github_manifest',
					'github_document',
					'github_commit'
				)
			)
			SELECT
				chunk_id,
				document_id,
				title,
				source_type,
				repository_name,
				file_path,
				commit_sha,
				public_url,
				content,
				metadata
			FROM ranked_repository_chunks
			WHERE document_chunk_rank = 1
			ORDER BY
				CASE source_type
					WHEN 'github_readme' THEN 1
					WHEN 'github_repository' THEN 2
					WHEN 'github_manifest' THEN 3
					WHEN 'github_document' THEN 4
					WHEN 'github_commit' THEN 5
					ELSE 6
				END,
				CASE
					WHEN file_path = 'README.md' THEN 1
					WHEN title LIKE '%Evidence Summary%' THEN 2
					WHEN title LIKE '%Repository Metadata%' THEN 3
					WHEN file_path LIKE '%requirements%' THEN 4
					WHEN file_path LIKE '%pyproject%' THEN 5
					WHEN file_path LIKE 'src/%' THEN 6
					WHEN file_path LIKE 'scripts/%' THEN 7
					ELSE 8
				END
			LIMIT 24;
			`,
		)
		.bind(...names)
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
		}>();

	return rows.results.map((row, index) => ({
		chunkId: row.chunk_id,
		documentId: row.document_id,
		title: row.title,
		sourceType: row.source_type,
		repositoryName: row.repository_name,
		filePath: row.file_path,
		commitSha: row.commit_sha,
		publicUrl: row.public_url,
		content: row.content,
		score: 80 - index,
		retrievalMode: "exact",
		metadata: {
			...parseMetadata(row.metadata),
			repository_expansion: true,
		},
	}));
}

function getMentionedRepositoryNames(
	results: EvidenceResult[],
	query: string,
): Set<string> {
	const mentionedRepositoryNames = new Set<string>();

	for (const result of results) {
		if (
			result.repositoryName &&
			isRepositoryExplicitlyMentioned(query, result.repositoryName)
		) {
			mentionedRepositoryNames.add(result.repositoryName);
		}
	}

	return mentionedRepositoryNames;
}

function dedupeEvidenceForDisplay(
	results: EvidenceResult[],
	projectQuery: boolean,
	broadQuery: boolean,
	query: string,
): EvidenceResult[] {
	const selected: EvidenceResult[] = [];
	const seenChunks = new Set<string>();
	const seenDocuments = new Set<string>();
	const repositoryCounts = new Map<string, number>();
	const resumeLimit = broadQuery ? 4 : 2;
	let resumeCount = 0;

	for (const result of results) {
		if (seenChunks.has(result.chunkId)) {
			continue;
		}

		if (seenDocuments.has(result.documentId)) {
			continue;
		}

		if (result.sourceType === "resume") {
			if (resumeCount >= resumeLimit) {
				continue;
			}

			resumeCount += 1;
		}

		if (projectQuery && result.repositoryName) {
			const repositoryCount = repositoryCounts.get(result.repositoryName) ?? 0;
			const repositoryLimit = getRepositoryEvidenceLimit(query, result.repositoryName);

			if (repositoryCount >= repositoryLimit) {
				continue;
			}

			repositoryCounts.set(result.repositoryName, repositoryCount + 1);
		}

		seenChunks.add(result.chunkId);
		seenDocuments.add(result.documentId);
		selected.push(result);
	}

	return selected;
}

function getRepositoryEvidenceLimit(query: string, repositoryName: string | null): number {
	if (!repositoryName) {
		return 1;
	}

	return isRepositoryExplicitlyMentioned(query, repositoryName) ? 5 : 1;
}

function isRepositoryExplicitlyMentioned(query: string, repositoryName: string): boolean {
	const normalizedQuery = normalizeForMention(query);
	const normalizedRepository = normalizeForMention(repositoryName);

	if (normalizedRepository && normalizedQuery.includes(normalizedRepository)) {
		return true;
	}

	return repositoryName
		.split(/[-_\s]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 4)
		.some((part) => normalizedQuery.includes(normalizeForMention(part)));
}

function normalizeForMention(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}
