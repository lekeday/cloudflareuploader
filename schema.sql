-- DSpace Cloudflare D1 Database Schema
-- Run with: npx wrangler d1 execute dspace-db --local --file=schema.sql

CREATE TABLE IF NOT EXISTS dspace_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL DEFAULT 'Default Repository',
    url TEXT NOT NULL,
    username TEXT NOT NULL,
    encrypted_password TEXT DEFAULT '',
    detected_version TEXT DEFAULT 'unknown', -- 'v6', 'v7', 'unknown'
    api_details TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS department_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    collection_uuid_or_handle TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS upload_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    filepath TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT,
    isbn TEXT,
    department TEXT NOT NULL,
    dspace_version TEXT NOT NULL,
    file_size_bytes INTEGER DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'uploading', 'success', 'failed'
    item_handle_or_uuid TEXT,
    response_message TEXT,
    is_duplicate INTEGER DEFAULT 0,
    retry_count INTEGER DEFAULT 0,
    uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_upload_logs_status_uploaded ON upload_logs(status, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_upload_logs_dept_status ON upload_logs(department, status);
