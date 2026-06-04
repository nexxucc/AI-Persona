import { useEffect, useState } from "react";
import type { HealthResponse } from "../shared/types/health";
import "./App.css";

type ConnectionState =
	| { status: "checking" }
	| { status: "connected"; response: HealthResponse }
	| { status: "unavailable" };

function App() {
	const [connection, setConnection] = useState<ConnectionState>({
		status: "checking",
	});

	useEffect(() => {
		const controller = new AbortController();

		fetch("/api/health", { signal: controller.signal })
			.then((response) => {
				if (!response.ok) {
					throw new Error("API health check failed.");
				}

				return response.json() as Promise<HealthResponse>;
			})
			.then((response) => {
				setConnection({ status: "connected", response });
			})
			.catch((error: unknown) => {
				if (error instanceof Error && error.name === "AbortError") {
					return;
				}

				setConnection({ status: "unavailable" });
			});

		return () => controller.abort();
	}, []);

	return (
		<main className="app-shell">
			<header className="topbar">
				<div className="brand">
					<span className="brand-mark" aria-hidden="true">
						VJ
					</span>
					<div>
						<p className="brand-title">Vansh Jain</p>
						<p className="brand-subtitle">AI Representative</p>
					</div>
				</div>

				<StatusIndicator connection={connection} />
			</header>

			<section className="hero">
				<p className="eyebrow">AI Engineer Screening Assignment</p>
				<h1>Chat with Vansh&apos;s AI representative.</h1>
				<p className="hero-copy">
					This assistant will answer questions using evidence from a sanitised
					resume and public GitHub repositories, and will support interview
					scheduling through real calendar availability.
				</p>
			</section>

			<section className="workspace" aria-label="Chat workspace">
				<div className="chat-panel">
					<div className="chat-header">
						<div>
							<h2>Conversation</h2>
							<p>Evidence-grounded responses only</p>
						</div>
						<span className="development-pill">Foundation build</span>
					</div>

					<div className="empty-state">
						<p className="empty-title">Chat functionality is being connected.</p>
						<p>
							The application shell and backend health endpoint are active.
							Retrieval-grounded conversation will be enabled after the source
							index and evidence pipeline are implemented.
						</p>
					</div>

					<form className="composer" aria-label="Message composer">
						<input
							type="text"
							placeholder="Ask about experience, projects, or availability..."
							disabled
						/>
						<button type="button" disabled>
							Send
						</button>
					</form>
				</div>

				<aside className="details-panel" aria-label="Assistant capabilities">
					<h2>Designed to handle</h2>
					<ul>
						<li>Resume and experience questions</li>
						<li>Public GitHub repository details</li>
						<li>Evidence-backed technical discussion</li>
						<li>Real interview availability and booking</li>
					</ul>

					<div className="grounding-note">
						<p className="note-title">Grounding policy</p>
						<p>
							Factual responses will be generated only when supported by
							indexed public evidence.
						</p>
					</div>
				</aside>
			</section>
		</main>
	);
}

function StatusIndicator({ connection }: { connection: ConnectionState }) {
	if (connection.status === "connected") {
		return (
			<div className="status status-connected">
				<span aria-hidden="true" />
				API connected
			</div>
		);
	}

	if (connection.status === "unavailable") {
		return (
			<div className="status status-unavailable">
				<span aria-hidden="true" />
				API unavailable
			</div>
		);
	}

	return (
		<div className="status status-checking">
			<span aria-hidden="true" />
			Checking API
		</div>
	);
}

export default App;
