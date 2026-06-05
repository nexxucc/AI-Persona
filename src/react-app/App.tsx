import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";

const RESUME_URL =
	"https://drive.google.com/file/d/14u3hvLuxnV5Dyt1noX-nKdhYHW6W4VrG/view";
const GITHUB_URL = "https://github.com/nexxucc";
const EMAIL = "vanshatarch@gmail.com";
const PHONE_DISPLAY = "+91 9108218530";
const PHONE_LINK = "tel:+919108218530";
const AGENT_CALL_LINK = "tel:+12396869043";
const CONVERSATION_ID_STORAGE_KEY = "ai-persona-conversation-id";
const MESSAGES_STORAGE_KEY = "ai-persona-messages";

type Citation = {
	index: number;
	title: string;
	sourceType: string;
	repositoryName: string | null;
	filePath: string | null;
	publicUrl: string;
};

type Evidence = {
	chunkId: string;
	title: string;
	sourceType: string;
	repositoryName: string | null;
	filePath: string | null;
	publicUrl: string;
	retrievalMode: "exact" | "semantic" | "hybrid";
};

type ChatResponse = {
	answer: string;
	supported: boolean;
	model: string;
	citations: Citation[];
	evidence: Evidence[];
};

type ChatMessage = {
	role: "user" | "assistant";
	content: string;
	response?: ChatResponse;
};

const defaultSuggestions = [
	"What kind of AI projects have you worked on?",
	"Can you walk me through your recent projects?",
];

const suggestionGroups = {
	ai: [
		"Which AI project are you most confident explaining?",
		"What did you build in your RAG projects?",
	],
	internship: [
		"What did you work on during your internships?",
		"What impact did your internship work have?",
	],
	frontend: [
		"What have you built with React?",
		"What frontend projects should I look at first?",
	],
	backend: [
		"What backend systems have you worked on?",
		"How have you used databases in your projects?",
	],
	github: [
		"Which GitHub repositories best represent your work?",
		"What project would you recommend I review first?",
	],
	skills: [
		"What are your strongest technical skills?",
		"What tools and frameworks do you work with?",
	],
} satisfies Record<string, string[]>;

function App() {
	const [conversationId] = useState(() => getOrCreateConversationId());
	const [messages, setMessages] = useState<ChatMessage[]>(() => loadStoredMessages());
	const [input, setInput] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [suggestions, setSuggestions] = useState(defaultSuggestions);
	const [isContactOpen, setIsContactOpen] = useState(false);
	const [isDarkMode, setIsDarkMode] = useState(() => {
		return window.localStorage.getItem("theme") === "dark";
	});
	const [showInitials, setShowInitials] = useState(false);
	const chatEndRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, isLoading]);

	useEffect(() => {
		window.localStorage.setItem("theme", isDarkMode ? "dark" : "light");
	}, [isDarkMode]);

	useEffect(() => {
		sessionStorage.setItem(MESSAGES_STORAGE_KEY, JSON.stringify(messages));
	}, [messages]);

	const themeLabel = useMemo(
		() => (isDarkMode ? "Switch to light mode" : "Switch to dark mode"),
		[isDarkMode],
	);

	async function submitQuestion(question: string) {
		const trimmedQuestion = question.trim();

		if (!trimmedQuestion || isLoading) {
			return;
		}

		setInput("");
		setError(null);
		setIsLoading(true);
		setSuggestions(getSuggestionsForQuestion(trimmedQuestion));

		setMessages((currentMessages) => [
			...currentMessages,
			{
				role: "user",
				content: trimmedQuestion,
			},
		]);

		try {
			const response = await fetch("/api/chat", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					message: trimmedQuestion,
					conversationId,
				}),
			});

			if (!response.ok) {
				const body = await response.text();
				throw new Error(response.status === 429 ? "The chat is temporarily rate limited. Please try again shortly." : `Chat request failed: ${response.status} ${body}`);
			}

			const payload = (await response.json()) as ChatResponse;

			setMessages((currentMessages) => [
				...currentMessages,
				{
					role: "assistant",
					content: payload.answer,
					response: payload,
				},
			]);
		} catch (requestError) {
			const message =
				requestError instanceof Error
					? requestError.message
					: "The chat request failed.";

			setError(message);
		} finally {
			setIsLoading(false);
		}
	}

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		void submitQuestion(input);
	}

	return (
		<div className={`app-shell ${isDarkMode ? "theme-dark" : ""}`}>
			<aside className="sidebar">
				<div className="profile-block">
					<div className="avatar" aria-hidden="true">
						{showInitials ? (
							"VJ"
						) : (
							<img
								src="/profile.jpg"
								alt=""
								onError={() => setShowInitials(true)}
							/>
						)}
					</div>
					<h1>Vansh Jain</h1>
				</div>

				<nav className="nav-list" aria-label="Page navigation">
					<a className="nav-link active" href="#conversation">
						Conversation
					</a>
					<a
						className="nav-link"
						href={GITHUB_URL}
						target="_blank"
						rel="noreferrer"
					>
						GitHub
					</a>
					<button
						className="nav-link nav-button"
						type="button"
						onClick={() => setIsContactOpen(true)}
					>
						Contact me
					</button>
				</nav>

				<div className="sidebar-footer">
					<a className="primary-link" href={RESUME_URL} target="_blank" rel="noreferrer">
						View Resume
					</a>
				</div>
			</aside>

			<main className="main-canvas" id="conversation">
				<header className="mobile-header">
					<div className="avatar small" aria-hidden="true">
						{showInitials ? (
							"VJ"
						) : (
							<img
								src="/profile.jpg"
								alt=""
								onError={() => setShowInitials(true)}
							/>
						)}
					</div>
					<strong>Vansh Jain</strong>
				</header>

				<button
					className="theme-toggle"
					type="button"
					aria-label={themeLabel}
					onClick={() => setIsDarkMode((currentValue) => !currentValue)}
				>
					{isDarkMode ? <SunIcon /> : <MoonIcon />}
				</button>

				<section className="conversation">
					<div className="intro-panel">
						<h2>Ask away</h2>
					</div>

					<div className="chat-list" aria-label="Chat messages">
						{messages.length === 0 ? (
							<div className="empty-chat">
								<p>Start with anything you would ask in an interview.</p>
							</div>
						) : (
							messages.map((message, index) => (
								<article
									className={`chat-message ${message.role}`}
									key={`${message.role}-${index}`}
								>
									<div className="message-meta">
										{message.role === "user" ? "You" : "Vansh"}
									</div>

									<div className="message-content">
										<p>{message.content}</p>
									</div>
								</article>
							))
						)}

						{isLoading ? (
							<article className="chat-message assistant">
								<div className="message-meta">Vansh</div>
								<div className="message-content muted">
									<TypingIndicator />
								</div>
							</article>
						) : null}

						{error ? (
							<div className="error-card">
								<strong>Something went wrong</strong>
								<p>{error}</p>
							</div>
						) : null}

						<div ref={chatEndRef} />
					</div>
				</section>

				<form className="composer" onSubmit={handleSubmit}>
					<div className="suggestion-row">
						{suggestions.map((question) => (
							<button
								type="button"
								key={question}
								onClick={() => void submitQuestion(question)}
								disabled={isLoading}
							>
								{question}
							</button>
						))}
					</div>

					<div className="input-box">
						<input
							value={input}
							onChange={(event) => setInput(event.target.value)}
							placeholder="Ask about projects, skills, or experience..."
							aria-label="Ask a question"
						/>
						<button type="submit" disabled={isLoading || !input.trim()}>
							Send
						</button>
					</div>
				</form>
			</main>

			{isContactOpen ? (
				<div
					className="modal-backdrop"
					role="presentation"
					onClick={() => setIsContactOpen(false)}
				>
					<section
						className="contact-modal"
						role="dialog"
						aria-modal="true"
						aria-labelledby="contact-title"
						onClick={(event) => event.stopPropagation()}
					>
						<button
							className="modal-close"
							type="button"
							aria-label="Close contact options"
							onClick={() => setIsContactOpen(false)}
						>
							Close
						</button>

						<p className="overline">Contact</p>
						<h2 id="contact-title">Reach me</h2>

						<div className="contact-list">
							<a href={`mailto:${EMAIL}`}>{EMAIL}</a>
							<a href={PHONE_LINK}>{PHONE_DISPLAY}</a>
							<a href={AGENT_CALL_LINK}>Call AI agent</a>
						</div>
					</section>
				</div>
			) : null}
		</div>
	);
}

function getOrCreateConversationId(): string {
	const existingId = sessionStorage.getItem(CONVERSATION_ID_STORAGE_KEY);

	if (existingId) {
		return existingId;
	}

	const nextId =
		globalThis.crypto?.randomUUID?.() ??
		`conversation-${Date.now()}-${Math.random().toString(16).slice(2)}`;

	sessionStorage.setItem(CONVERSATION_ID_STORAGE_KEY, nextId);

	return nextId;
}

function loadStoredMessages(): ChatMessage[] {
	const storedMessages = sessionStorage.getItem(MESSAGES_STORAGE_KEY);

	if (!storedMessages) {
		return [];
	}

	try {
		const parsedMessages = JSON.parse(storedMessages);

		if (!Array.isArray(parsedMessages)) {
			return [];
		}

		return parsedMessages.filter(isChatMessage);
	} catch {
		return [];
	}
}

function isChatMessage(value: unknown): value is ChatMessage {
	if (!value || typeof value !== "object") {
		return false;
	}

	const candidate = value as Partial<ChatMessage>;

	return (
		(candidate.role === "user" || candidate.role === "assistant") &&
		typeof candidate.content === "string"
	);
}

function getSuggestionsForQuestion(question: string): string[] {
	const normalizedQuestion = question.toLowerCase();

	if (containsAny(normalizedQuestion, ["langgraph", "agent", "ai", "rag", "llm", "machine learning"]) ) {
		return suggestionGroups.ai;
	}

	if (containsAny(normalizedQuestion, ["github", "repo", "repository", "project", "built"]) ) {
		return suggestionGroups.github;
	}

	if (containsAny(normalizedQuestion, ["react", "frontend", "firebase", "mobile"]) ) {
		return suggestionGroups.frontend;
	}

	if (containsAny(normalizedQuestion, ["backend", "database", "api", "server"]) ) {
		return suggestionGroups.backend;
	}

	if (containsAny(normalizedQuestion, ["intern", "internship", "experience", "work"]) ) {
		return suggestionGroups.internship;
	}

	if (containsAny(normalizedQuestion, ["skill", "stack", "tools", "framework"]) ) {
		return suggestionGroups.skills;
	}

	return defaultSuggestions;
}

function containsAny(value: string, keywords: string[]): boolean {
	return keywords.some((keyword) => value.includes(keyword));
}

function TypingIndicator() {
	return (
		<div className="typing-dots" aria-label="Vansh is typing">
			<span />
			<span />
			<span />
		</div>
	);
}

function SunIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<path d="M12 4V2M12 22v-2M4 12H2M22 12h-2M5.64 5.64 4.22 4.22M19.78 19.78l-1.42-1.42M18.36 5.64l1.42-1.42M4.22 19.78l1.42-1.42M12 16.5A4.5 4.5 0 1 0 12 7.5a4.5 4.5 0 0 0 0 9Z" />
		</svg>
	);
}

function MoonIcon() {
	return (
		<svg aria-hidden="true" viewBox="0 0 24 24">
			<path d="M20.25 14.5A8.5 8.5 0 0 1 9.5 3.75 8.5 8.5 0 1 0 20.25 14.5Z" />
		</svg>
	);
}

export default App;
