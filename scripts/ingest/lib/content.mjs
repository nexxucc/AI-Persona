import { createHash } from "node:crypto";

export const DEFAULT_MAX_CHARS = 1200;

export function sha256(value) {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

export function createStableId(prefix, seed) {
	return `${prefix}_${sha256(seed).slice(0, 24)}`;
}

export function normaliseMarkdown(markdown) {
	return (
		markdown
			.replace(/\r\n?/g, "\n")
			.replace(/[ \t]+\n/g, "\n")
			.replace(/\n{3,}/g, "\n\n")
			.trim() + "\n"
	);
}

export function parseMarkdownSections(markdown) {
	const sections = [];
	const lines = normaliseMarkdown(markdown).split("\n");
	let headingPath = [];
	let bodyLines = [];

	const flushSection = () => {
		const body = bodyLines.join("\n").trim();

		if (body && headingPath.length > 0) {
			sections.push({
				headingPath: [...headingPath],
				body,
			});
		}

		bodyLines = [];
	};

	for (const line of lines) {
		const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);

		if (headingMatch) {
			flushSection();

			const level = headingMatch[1].length;
			headingPath = headingPath.slice(0, level - 1);
			headingPath[level - 1] = headingMatch[2].trim();
			continue;
		}

		bodyLines.push(line);
	}

	flushSection();

	return sections;
}

function renderHeadingPath(headingPath) {
	return headingPath
		.map((heading, index) => `${"#".repeat(index + 1)} ${heading}`)
		.join("\n");
}

function splitOversizedLine(line, limit) {
	if (line.length <= limit) {
		return [line];
	}

	const parts = [];
	const words = line.split(/\s+/);
	let current = "";

	for (const word of words) {
		if (word.length > limit) {
			if (current) {
				parts.push(current);
				current = "";
			}

			for (let index = 0; index < word.length; index += limit) {
				parts.push(word.slice(index, index + limit));
			}

			continue;
		}

		const candidate = current ? `${current} ${word}` : word;

		if (candidate.length > limit) {
			parts.push(current);
			current = word;
		} else {
			current = candidate;
		}
	}

	if (current) {
		parts.push(current);
	}

	return parts;
}

function chunkSection(section, maxChars) {
	const headingText = renderHeadingPath(section.headingPath);
	const availableBodyLength = maxChars - headingText.length - 2;

	if (availableBodyLength < 40) {
		throw new Error("Chunk size is too small for the section heading context.");
	}

	const lines = section.body
		.split("\n")
		.flatMap((line) => splitOversizedLine(line, availableBodyLength));

	const chunks = [];
	let body = "";

	const pushChunk = () => {
		const trimmedBody = body.trim();

		if (trimmedBody) {
			chunks.push({
				headingPath: [...section.headingPath],
				content: `${headingText}\n\n${trimmedBody}`,
			});
		}

		body = "";
	};

	for (const line of lines) {
		const candidate = body ? `${body}\n${line}` : line;
		const content = `${headingText}\n\n${candidate}`.trim();

		if (content.length > maxChars && body.trim()) {
			pushChunk();
			body = line;
		} else {
			body = candidate;
		}
	}

	pushChunk();

	return chunks;
}

export function chunkMarkdown(markdown, options = {}) {
	const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;

	if (!Number.isInteger(maxChars) || maxChars < 100) {
		throw new Error("maxChars must be an integer of at least 100.");
	}

	return parseMarkdownSections(markdown).flatMap((section) =>
		chunkSection(section, maxChars),
	);
}
