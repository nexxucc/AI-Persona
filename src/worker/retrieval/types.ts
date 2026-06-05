export type EvidenceSourceType =
	| "resume"
	| "github_repository"
	| "github_readme"
	| "github_document"
	| "github_manifest"
	| "github_commit";

export type EvidenceResult = {
	chunkId: string;
	documentId: string;
	title: string;
	sourceType: EvidenceSourceType;
	repositoryName: string | null;
	filePath: string | null;
	commitSha: string | null;
	publicUrl: string;
	content: string;
	score: number;
	retrievalMode: "exact" | "semantic" | "hybrid";
};
