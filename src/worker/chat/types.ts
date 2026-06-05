import type { EvidenceResult } from "../retrieval/types";
import type { GroundedCitation } from "./groundedAnswer";

export type ChatResponse = {
	answer: string;
	supported: boolean;
	model: string;
	citations: GroundedCitation[];
	evidence: EvidenceResult[];
};
