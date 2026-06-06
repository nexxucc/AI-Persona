import { isGeminiQuotaError, withGeminiKeyRotation } from "../ai/geminiKeys";
import type { EvidenceResult } from "../retrieval/types";

export const GROUNDED_CHAT_MODEL = "gemini-2.5-flash";

export type GroundedCitation = {
	index: number;
	title: string;
	sourceType: EvidenceResult["sourceType"];
	repositoryName: string | null;
	filePath: string | null;
	publicUrl: string;
};

export type GroundedAnswer = {
	answer: string;
	supported: boolean;
	citations: GroundedCitation[];
	model: string;
};

type GeminiPayload = {
	candidates?: Array<{
		finishReason?: string;
		content?: {
			parts?: Array<{
				text?: string;
			}>;
		};
	}>;
};

const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_CHARS = 950;
const MAX_GENERATION_ATTEMPTS = 2;
const BASE_RETRY_DELAY_MS = 2500;

export async function generateGroundedAnswer(
	apiKeys: string[],
	question: string,
	evidence: EvidenceResult[],
): Promise<GroundedAnswer> {
	const trimmedQuestion = question.trim();

	if (!trimmedQuestion) {
		throw new Error("Cannot answer an empty question.");
	}

	const selectedEvidence = evidence.slice(0, MAX_EVIDENCE_ITEMS);

	if (selectedEvidence.length === 0) {
		return createUnsupportedAnswer();
	}

	try {
		let payload = (await generateContentWithRotation(
			apiKeys,
			buildGroundedPrompt(trimmedQuestion, selectedEvidence),
		)) as GeminiPayload;

		let answer = cleanAnswer(extractAnswer(payload));
		let finishReason = payload.candidates?.[0]?.finishReason ?? "UNKNOWN";

		if (finishReason !== "STOP" || isIncompleteAnswer(answer)) {
			payload = (await generateContentWithRotation(
				apiKeys,
				buildGroundedPrompt(trimmedQuestion, selectedEvidence, true),
			)) as GeminiPayload;

			answer = cleanAnswer(extractAnswer(payload));
			finishReason = payload.candidates?.[0]?.finishReason ?? "UNKNOWN";
		}

		if (!answer || finishReason !== "STOP" || isIncompleteAnswer(answer)) {
			return createEvidenceFallbackAnswer(trimmedQuestion, selectedEvidence);
		}

		return {
			answer,
			supported: !answer.toLowerCase().includes("not enough information"),
			citations: createCitations(selectedEvidence),
			model: GROUNDED_CHAT_MODEL,
		};
	} catch (error) {
		const failure = error instanceof Error ? error : new Error(String(error));

		if (isGeminiQuotaError(failure)) {
			return createEvidenceFallbackAnswer(trimmedQuestion, selectedEvidence);
		}

		throw failure;
	}
}

/**
 * Generate content, rotating across all keys on quota errors and retrying
 * transient (5xx/UNAVAILABLE) errors per key.
 */
async function generateContentWithRotation(
	apiKeys: string[],
	prompt: string,
): Promise<unknown> {
	return withGeminiKeyRotation(apiKeys, (apiKey) =>
		generateContentWithTransientRetry(apiKey, prompt),
	);
}

async function generateContentWithTransientRetry(
	apiKey: string,
	prompt: string,
): Promise<unknown> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
		try {
			return await generateContent(apiKey, prompt);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

			if (isGeminiQuotaError(lastError)) {
				throw lastError;
			}

			if (!isRetryableGeminiError(lastError) || attempt === MAX_GENERATION_ATTEMPTS) {
				throw lastError;
			}

			await sleep(BASE_RETRY_DELAY_MS * attempt);
		}
	}

	throw lastError ?? new Error("Gemini grounded answer request failed.");
}

async function generateContent(apiKey: string, prompt: string): Promise<unknown> {
	const response = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${GROUNDED_CHAT_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`,
		{
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				contents: [
					{
						role: "user",
						parts: [
							{
								text: prompt,
							},
						],
					},
				],
				generationConfig: {
					temperature: 0.35,
					topP: 0.85,
					maxOutputTokens: 700,
					thinkingConfig: {
						thinkingBudget: 0,
					},
				},
			}),
		},
	);

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(
			`Gemini grounded answer request failed: ${response.status} ${errorBody}`,
		);
	}

	return response.json();
}

function isRetryableGeminiError(error: Error): boolean {
	return (
		error.message.includes(" 500 ") ||
		error.message.includes(" 502 ") ||
		error.message.includes(" 503 ") ||
		error.message.includes(" 504 ") ||
		error.message.includes("UNAVAILABLE")
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildGroundedPrompt(
	question: string,
	evidence: EvidenceResult[],
	retryForCompletion = false,
): string {
	return [
		"You are answering as Vansh Jain in first person for interview and recruiter conversations.",
		"",
		"Answer the question in first person using only the retrieved evidence below.",
		"Do not use outside knowledge.",
		"Do not invent facts, dates, metrics, employers, skills, contact details, or project outcomes.",
		"Do not say you are an AI representative.",
		"Do not refer to Vansh in third person unless the question specifically asks for third-person wording.",
		"Do not include bracket citations like [1], [2], or source markers inside the answer text.",
		"Do not use Markdown formatting. Do not use bold text, headings, lists, or bullets.",
		"Do not copy the evidence word-for-word. Rephrase it naturally while preserving the meaning.",
		"Write like a concise message I would send to a recruiter or interviewer.",
		"Prefer direct, specific answers over resume-style repetition.",
		"When the question is about projects or repositories, combine resume evidence with GitHub README, manifest, repository, or commit evidence when available.",
		"Use repository evidence for tech stack, purpose, implementation details, design tradeoffs, setup, files, and what could be improved.",
		"If the question asks what I would improve, it is allowed to give a future-facing improvement based on visible evidence gaps, such as missing documentation, unclear evaluation details, limited README explanation, missing deployment notes, or unclear tradeoff documentation. Make it clear as what I would improve now, not as a past fact.",
		"Do not refuse improvement questions just because the evidence does not explicitly contain a section called improvements.",
		"Keep the answer complete, natural, and self-contained.",
		"Keep the answer to one to three short paragraphs unless the question clearly asks for more detail.",
		retryForCompletion
			? "The previous answer was incomplete. Return a complete answer with a clear final sentence."
			: null,
		"If the evidence is insufficient, say that I do not have enough information to answer reliably.",
		"",
		`Question: ${question}`,
		"",
		"Retrieved evidence:",
		...evidence.map(formatEvidenceItem),
	]
		.filter(Boolean)
		.join("\n");
}

function formatEvidenceItem(item: EvidenceResult, index: number): string {
	const sourceParts = [
		`source_number=${index + 1}`,
		`title=${item.title}`,
		`source_type=${item.sourceType}`,
		item.repositoryName ? `repository=${item.repositoryName}` : null,
		item.filePath ? `file_path=${item.filePath}` : null,
		`url=${item.publicUrl}`,
	].filter(Boolean);

	return [
		`Source ${index + 1}: ${sourceParts.join(" | ")}`,
		truncate(item.content, MAX_EVIDENCE_CHARS),
		"",
	].join("\n");
}

function truncate(value: string, maxCharacters: number): string {
	if (value.length <= maxCharacters) {
		return value;
	}

	return `${value.slice(0, maxCharacters - 20).trimEnd()}\n[truncated]`;
}

function extractAnswer(payload: GeminiPayload): string {
	return (
		payload.candidates?.[0]?.content?.parts
			?.map((part) => part.text ?? "")
			.join("")
			.trim() ?? ""
	);
}

function isIncompleteAnswer(answer: string): boolean {
	const trimmedAnswer = answer.trim();

	if (!trimmedAnswer) {
		return true;
	}

	if (/[.!?]$/.test(trimmedAnswer)) {
		return false;
	}

	return /\b(and|or|but|because|with|for|to|at|in|the|a|an|of|on|from|as|by)$/i.test(
		trimmedAnswer,
	);
}

function cleanAnswer(answer: string): string {
	return answer
		.replace(/\*\*(.*?)\*\*/g, "$1")
		.replace(/\s*\[[0-9]+]\s*/g, " ")
		.replace(/[ \t]{2,}/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function createCitations(evidence: EvidenceResult[]): GroundedCitation[] {
	return evidence.map((item, index) => ({
		index: index + 1,
		title: item.title,
		sourceType: item.sourceType,
		repositoryName: item.repositoryName,
		filePath: item.filePath,
		publicUrl: item.publicUrl,
	}));
}

function createUnsupportedAnswer(): GroundedAnswer {
	return {
		answer: "I do not have enough information to answer that reliably.",
		supported: false,
		citations: [],
		model: GROUNDED_CHAT_MODEL,
	};
}

function createEvidenceFallbackAnswer(
	question: string,
	evidence: EvidenceResult[],
): GroundedAnswer {
	return {
		answer: createEvidenceFallbackText(question, evidence),
		supported: evidence.length > 0,
		citations: createCitations(evidence),
		model: `${GROUNDED_CHAT_MODEL}-evidence-fallback`,
	};
}

function createEvidenceFallbackText(
	question: string,
	evidence: EvidenceResult[],
): string {
	const repositoryGroups = groupEvidenceByRepository(evidence);

	if (repositoryGroups.length >= 3 || isBroadProjectQuestion(question)) {
		const summaries = repositoryGroups
			.slice(0, 6)
			.map((group) => formatRepositoryFallbackSummary(group))
			.filter(Boolean);

		return `I have worked across a mix of AI, ML, and software projects. ${summaries.join(" ")} This is based on the retrieved repository evidence available right now.`;
	}

	if (repositoryGroups.length > 0) {
		const group = repositoryGroups[0];
		const language = extractPrimaryLanguage(group.items);
		const description = extractDescription(group.items);
		const files = extractUsefulFiles(group.items);
		const tools = extractTools(group.items);
		const improvement = asksForImprovement(question)
			? "If I were improving it, I would make the README and project documentation more explicit about the goal, model pipeline, evaluation results, and design tradeoffs, because the indexed evidence has useful source and commit material but limited explanatory text."
			: "";

		return [
			`${group.repositoryName} is one of my indexed GitHub projects${language ? `, with ${language} as the primary language` : ""}${description ? `, and it is described as ${description}` : ""}.`,
			files.length > 0 ? `The retrieved implementation evidence includes ${files.join(", ")}.` : "",
			tools.length > 0 ? `The source evidence references ${tools.join(", ")}.` : "",
			improvement,
		]
			.filter(Boolean)
			.join(" ");
	}

	const titles = evidence.slice(0, 4).map((item) => item.title).filter(Boolean);

	if (titles.length === 0) {
		return "I do not have enough retrieved evidence to answer reliably.";
	}

	return `I found relevant indexed evidence for this, including ${titles.join(", ")}. I can answer from that material, but I would avoid adding details that are not present in the retrieved sources.`;
}

type RepositoryEvidenceGroup = {
	repositoryName: string;
	items: EvidenceResult[];
};

function groupEvidenceByRepository(evidence: EvidenceResult[]): RepositoryEvidenceGroup[] {
	const groups = new Map<string, EvidenceResult[]>();

	for (const item of evidence) {
		if (!item.repositoryName) {
			continue;
		}

		groups.set(item.repositoryName, [...(groups.get(item.repositoryName) ?? []), item]);
	}

	return [...groups.entries()].map(([repositoryName, items]) => ({
		repositoryName,
		items,
	}));
}

function formatRepositoryFallbackSummary(group: RepositoryEvidenceGroup): string {
	const language = extractPrimaryLanguage(group.items);
	const description = extractDescription(group.items);

	if (description && language) {
		return `${group.repositoryName} is indexed as a ${language} project focused on ${description}.`;
	}

	if (description) {
		return `${group.repositoryName} is indexed as a project focused on ${description}.`;
	}

	if (language) {
		return `${group.repositoryName} is indexed as a ${language} project.`;
	}

	return `${group.repositoryName} is included in my curated GitHub evidence.`;
}

function extractPrimaryLanguage(items: EvidenceResult[]): string | null {
	for (const item of items) {
		const metadataLanguage = item.metadata?.language;

		if (typeof metadataLanguage === "string" && metadataLanguage !== "None") {
			return metadataLanguage;
		}

		const language = extractMetadataLine(item.content, "Primary language");

		if (language && language !== "None") {
			return language;
		}
	}

	return null;
}

function extractDescription(items: EvidenceResult[]): string | null {
	for (const item of items) {
		const description = extractMetadataLine(item.content, "Description");

		if (description && description !== "No description provided") {
			return normalizeInlineText(description);
		}
	}

	for (const item of items) {
		const line = item.content
			.split("\n")
			.map((value) =>
				value
					.replace(/^#+\s*/, "")
					.replace(/^>\s*/, "")
					.replace(/[*_`]/g, "")
					.trim(),
			)
			.find((value) => value.length >= 18 && value.toLowerCase() !== "undefined");

		if (line) {
			return normalizeInlineText(line);
		}
	}

	return null;
}

function extractUsefulFiles(items: EvidenceResult[]): string[] {
	return [
		...new Set(
			items
				.map((item) => item.filePath)
				.filter((filePath): filePath is string => Boolean(filePath))
				.filter((filePath) => filePath !== "README.md")
				.slice(0, 4),
		),
	];
}

function extractTools(items: EvidenceResult[]): string[] {
	const content = items.map((item) => item.content).join("\n").toLowerCase();

	return [
		"pandas",
		"numpy",
		"yfinance",
		"scikit-learn",
		"random forest",
		"gradient boosting",
		"skyfield",
		"matplotlib",
		"langchain",
		"langgraph",
		"faiss",
		"cloudflare",
		"vectorize",
	].filter((tool) => content.includes(tool)).slice(0, 8);
}

function asksForImprovement(question: string): boolean {
	const normalizedQuestion = question.toLowerCase();

	return ["improve", "improvement", "differently", "better", "tradeoff", "tradeoffs"].some((term) =>
		normalizedQuestion.includes(term),
	);
}

function isBroadProjectQuestion(question: string): boolean {
	const normalizedQuestion = question.toLowerCase();

	return (
		normalizedQuestion.includes("projects") ||
		normalizedQuestion.includes("worked on") ||
		normalizedQuestion.includes("what kind of")
	);
}

function extractMetadataLine(content: string, label: string): string | null {
	const pattern = new RegExp(`^- ${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: (.+)$`, "m");
	return pattern.exec(content)?.[1]?.trim() ?? null;
}

function normalizeInlineText(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
