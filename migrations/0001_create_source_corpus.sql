CREATE TABLE ingestion_runs (
	id TEXT PRIMARY KEY NOT NULL,
	trigger_type TEXT NOT NULL CHECK (trigger_type IN ('manual', 'scheduled', 'ci')),
	status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
	started_at TEXT NOT NULL,
	completed_at TEXT,
	documents_processed INTEGER NOT NULL DEFAULT 0 CHECK (documents_processed >= 0),
	chunks_indexed INTEGER NOT NULL DEFAULT 0 CHECK (chunks_indexed >= 0),
	error_message TEXT
);

CREATE TABLE source_documents (
	id TEXT PRIMARY KEY NOT NULL,
	source_type TEXT NOT NULL CHECK (
		source_type IN (
			'resume',
			'github_repository',
			'github_readme',
			'github_document',
			'github_manifest',
			'github_commit'
		)
	),
	source_key TEXT NOT NULL UNIQUE,
	repository_owner TEXT,
	repository_name TEXT,
	file_path TEXT,
	commit_sha TEXT,
	public_url TEXT NOT NULL,
	title TEXT NOT NULL,
	content TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	metadata_json TEXT NOT NULL DEFAULT '{}',
	last_ingestion_run_id TEXT REFERENCES ingestion_runs(id),
	indexed_at TEXT NOT NULL,
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE source_chunks (
	id TEXT PRIMARY KEY NOT NULL,
	document_id TEXT NOT NULL REFERENCES source_documents(id) ON DELETE CASCADE,
	chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
	content TEXT NOT NULL,
	title TEXT NOT NULL,
	source_type TEXT NOT NULL,
	repository_name TEXT,
	file_path TEXT,
	commit_sha TEXT,
	public_url TEXT NOT NULL,
	content_hash TEXT NOT NULL,
	vector_id TEXT NOT NULL UNIQUE,
	metadata_json TEXT NOT NULL DEFAULT '{}',
	created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE (document_id, chunk_index)
);

CREATE INDEX idx_source_documents_type
	ON source_documents (source_type);

CREATE INDEX idx_source_documents_repository
	ON source_documents (repository_name, file_path);

CREATE INDEX idx_source_documents_commit
	ON source_documents (repository_name, commit_sha);

CREATE INDEX idx_source_chunks_document
	ON source_chunks (document_id, chunk_index);

CREATE INDEX idx_source_chunks_repository
	ON source_chunks (repository_name, file_path);

CREATE INDEX idx_source_chunks_commit
	ON source_chunks (repository_name, commit_sha);

CREATE VIRTUAL TABLE source_chunks_fts USING fts5(
	content,
	title,
	repository_name,
	file_path,
	commit_sha,
	content='source_chunks',
	content_rowid='rowid',
	tokenize='unicode61'
);

CREATE TRIGGER source_chunks_after_insert
AFTER INSERT ON source_chunks
BEGIN
	INSERT INTO source_chunks_fts (
		rowid,
		content,
		title,
		repository_name,
		file_path,
		commit_sha
	)
	VALUES (
		new.rowid,
		new.content,
		new.title,
		new.repository_name,
		new.file_path,
		new.commit_sha
	);
END;

CREATE TRIGGER source_chunks_after_delete
AFTER DELETE ON source_chunks
BEGIN
	INSERT INTO source_chunks_fts (
		source_chunks_fts,
		rowid,
		content,
		title,
		repository_name,
		file_path,
		commit_sha
	)
	VALUES (
		'delete',
		old.rowid,
		old.content,
		old.title,
		old.repository_name,
		old.file_path,
		old.commit_sha
	);
END;

CREATE TRIGGER source_chunks_after_update
AFTER UPDATE ON source_chunks
BEGIN
	INSERT INTO source_chunks_fts (
		source_chunks_fts,
		rowid,
		content,
		title,
		repository_name,
		file_path,
		commit_sha
	)
	VALUES (
		'delete',
		old.rowid,
		old.content,
		old.title,
		old.repository_name,
		old.file_path,
		old.commit_sha
	);

	INSERT INTO source_chunks_fts (
		rowid,
		content,
		title,
		repository_name,
		file_path,
		commit_sha
	)
	VALUES (
		new.rowid,
		new.content,
		new.title,
		new.repository_name,
		new.file_path,
		new.commit_sha
	);
END;
