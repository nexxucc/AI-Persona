import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	DEFAULT_MAX_CHARS,
	chunkMarkdown,
	createStableId,
	normaliseMarkdown,
	sha256,
} from "./lib/content.mjs";

const manifestPath = "sources/source-manifest.json";
const outputPath = "local-data/generated/resume-corpus-preview.json";

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const resumeSource = manifest.resume;

if (!resumeSource?.id || !resumeSource?.path || !resumeSource?.publicUrl) {
	throw new Error("The source manifest does not define a valid resume source.");
}

const rawResume = await readFile(resumeSource.path, "utf8");
const content = normaliseMarkdown(rawResume);
const contentChunks = chunkMarkdown(content);
const documentId = createStableId("document", resumeSource.id);

const document = {
	id: documentId,
	source_type: "resume",
	source_key: resumeSource.id,
	public_url: resumeSource.publicUrl,
	title: resumeSource.title,
	content,
	content_hash: sha256(content),
	metadata: {
		path: resumeSource.path,
		visibility: "public",
	},
};

const chunks = contentChunks.map((chunk, index) => {
	const identitySeed = `${resumeSource.id}:${index}:${chunk.content}`;

	return {
		id: createStableId("chunk", identitySeed),
		document_id: documentId,
		chunk_index: index,
		content: chunk.content,
		title: resumeSource.title,
		source_type: "resume",
		public_url: resumeSource.publicUrl,
		content_hash: sha256(chunk.content),
		vector_id: createStableId("vector", identitySeed),
		metadata: {
			heading_path: chunk.headingPath,
		},
	};
});

const largestChunkChars = Math.max(
	...chunks.map((chunk) => chunk.content.length),
);

const preview = {
	manifest_version: manifest.version,
	document,
	chunks,
	report: {
		document_count: 1,
		chunk_count: chunks.length,
		character_count: content.length,
		max_chunk_chars: DEFAULT_MAX_CHARS,
		largest_chunk_chars: largestChunkChars,
	},
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(preview, null, 2)}\n`, "utf8");

console.log(`Resume documents prepared: ${preview.report.document_count}`);
console.log(`Resume chunks prepared: ${preview.report.chunk_count}`);
console.log(`Resume characters indexed: ${preview.report.character_count}`);
console.log(`Largest chunk characters: ${preview.report.largest_chunk_chars}`);
console.log(`Local preview written to: ${outputPath}`);
