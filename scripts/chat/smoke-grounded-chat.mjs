const endpoint = process.env.CHAT_SMOKE_URL ?? "http://localhost:5173/api/chat";

const questions = [
	"What has Vansh done with LangGraph agents?",
];

for (const question of questions) {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			message: question,
		}),
	});

	if (!response.ok) {
		throw new Error(
			`Chat smoke request failed: ${response.status} ${await response.text()}`,
		);
	}

	const payload = await response.json();

	console.log(`Question: ${question}`);
	console.log(`Supported: ${payload.supported}`);
	console.log(`Model: ${payload.model}`);
	console.log(`Evidence count: ${payload.evidence?.length ?? 0}`);
	console.log(`Citation count: ${payload.citations?.length ?? 0}`);
	console.log("");
	console.log(payload.answer);

	if (!payload.answer || typeof payload.answer !== "string") {
		throw new Error("Chat response did not include an answer.");
	}

	if (!Array.isArray(payload.evidence) || payload.evidence.length === 0) {
		throw new Error("Chat response did not include retrieved evidence.");
	}
}
