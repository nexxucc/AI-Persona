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

const MAX_EVIDENCE_ITEMS = 8;
const MAX_EVIDENCE_CHARS = 1200;
const MAX_GENERATION_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 8000;

export async function generateGroundedAnswer(
	apiKey: string,
	question: string,
	evidence: EvidenceResult[],
): Promise<GroundedAnswer> {
	const trimmedQuestion = question.trim();

	if (!trimmedQuestion) {
		throw new Error("Cannot answer an empty question.");
	}

	const selectedEvidence = evidence.slice(0, MAX_EVIDENCE_ITEMS);

	if (selectedEvidence.length === 0) {
		return {
			answer:
				"I do not have enough retrieved evidence to answer that reliably.",
			supported: false,
			citations: [],
			model: GROUNDED_CHAT_MODEL,
		};
	}

	const prompt = buildGroundedPrompt(trimmedQuestion, selectedEvidence);

	const payload = (await generateContentWithRetry(
		apiKey,
		prompt,
	)) as {
		candidates?: Array<{
			content?: {
				parts?: Array<{
					text?: string;
				}>;
			};
		}>;
	};

	const answer = payload.candidates?.[0]?.content?.parts
		?.map((part) => part.text ?? "")
		.join("")
		.trim();

	if (!answer) {
		throw new Error("Gemini returned an empty grounded answer.");
	}

	return {
		answer,
		supported: !answer.toLowerCase().includes("not enough retrieved evidence"),
		citations: selectedEvidence.map((item, index) => ({
			index: index + 1,
			title: item.title,
			sourceType: item.sourceType,
			repositoryName: item.repositoryName,
			filePath: item.filePath,
			publicUrl: item.publicUrl,
		})),
		model: GROUNDED_CHAT_MODEL,
	};
}

async function generateContentWithRetry(
	apiKey: string,
	prompt: string,
): Promise<unknown> {
	let lastError: Error | null = null;

	for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt += 1) {
		try {
			return await generateContent(apiKey, prompt);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));

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
					temperature: 0.2,
					topP: 0.8,
					maxOutputTokens: 700,
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
		error.message.includes(" 429 ") ||
		error.message.includes(" 500 ") ||
		error.message.includes(" 502 ") ||
		error.message.includes(" 503 ") ||
		error.message.includes(" 504 ") ||
		error.message.includes("RESOURCE_EXHAUSTED") ||
		error.message.includes("UNAVAILABLE")
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildGroundedPrompt(
	question: string,
	evidence: EvidenceResult[],
): string {
	return [
		"You are Vansh Jain's AI representative for interview and recruiter conversations.",
		"",
		"Answer the question using only the retrieved evidence below.",
		"Do not use outside knowledge.",
		"Do not invent facts, dates, metrics, employers, skills, contact details, or project outcomes.",
		"If the evidence is insufficient, say that there is not enough retrieved evidence to answer reliably.",
		"Use concise, professional language.",
		"Include bracket citations like [1] or [2] for factual claims.",
		"",
		`Question: ${question}`,
		"",
		"Retrieved evidence:",
		...evidence.map(formatEvidenceItem),
	].join("\n");
}

function formatEvidenceItem(item: EvidenceResult, index: number): string {
	const sourceParts = [
		`title=${item.title}`,
		`source_type=${item.sourceType}`,
		item.repositoryName ? `repository=${item.repositoryName}` : null,
		item.filePath ? `file_path=${item.filePath}` : null,
		`url=${item.publicUrl}`,
	].filter(Boolean);

	return [
		`[${index + 1}] ${sourceParts.join(" | ")}`,
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
