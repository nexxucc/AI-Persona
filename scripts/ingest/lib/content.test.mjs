import assert from "node:assert/strict";
import test from "node:test";
import {
	chunkMarkdown,
	createStableId,
	normaliseMarkdown,
	parseMarkdownSections,
} from "./content.mjs";

const sampleResume = `# Candidate Name

## Experience

### Example Organisation — Engineer

- Built an evidence retrieval workflow for public project information.
- Validated grounded answers against an approved source set.

## Projects

### Retrieval Tool

- Implemented deterministic chunking and exact-search preparation.
- Documented system constraints and measurable evaluation targets.
`;

test("normaliseMarkdown removes trailing whitespace and excessive blank lines", () => {
	const source = "# Candidate  \r\n\r\n\r\n\r\n## Skills\r\n\r\n- TypeScript  \r\n";
	const normalised = normaliseMarkdown(source);

	assert.equal(normalised, "# Candidate\n\n## Skills\n\n- TypeScript\n");
});

test("parseMarkdownSections retains hierarchical heading context", () => {
	const sections = parseMarkdownSections(sampleResume);

	assert.equal(sections.length, 2);
	assert.deepEqual(sections[0].headingPath, [
		"Candidate Name",
		"Experience",
		"Example Organisation — Engineer",
	]);
	assert.deepEqual(sections[1].headingPath, [
		"Candidate Name",
		"Projects",
		"Retrieval Tool",
	]);
});

test("chunkMarkdown creates bounded chunks with source headings", () => {
	const chunks = chunkMarkdown(sampleResume, { maxChars: 150 });

	assert.ok(chunks.length >= 2);
	assert.ok(chunks.every((chunk) => chunk.content.length <= 150));
	assert.ok(
		chunks.some((chunk) => chunk.content.includes("### Retrieval Tool")),
	);
});

test("createStableId returns deterministic identifiers", () => {
	const first = createStableId("chunk", "resume:section:content");
	const second = createStableId("chunk", "resume:section:content");
	const different = createStableId("chunk", "resume:different-content");

	assert.equal(first, second);
	assert.notEqual(first, different);
	assert.match(first, /^chunk_[0-9a-f]{24}$/);
});
