CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL DEFAULT 'viewer',
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS octis_session_labels (
  session_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS octis_session_projects (
  session_key TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS octis_hidden_sessions (
  session_key TEXT PRIMARY KEY,
  hidden_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS octis_pinned_sessions (
  session_key TEXT PRIMARY KEY,
  pinned_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS octis_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  emoji TEXT DEFAULT '📁',
  color TEXT DEFAULT '#6366f1',
  description TEXT DEFAULT '',
  memory_file TEXT DEFAULT '',
  position INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS octis_todos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  text TEXT NOT NULL,
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_section TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  completed_at INTEGER,
  session_key TEXT,
  UNIQUE(project, text)
);

CREATE TABLE IF NOT EXISTS octis_session_ownership (
  session_key TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (session_key, user_id)
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT UNIQUE NOT NULL,
  p256dh TEXT NOT NULL,
  auth_key TEXT NOT NULL,
  user_agent TEXT DEFAULT '',
  subscription_json TEXT NOT NULL,
  created_at INTEGER DEFAULT (unixepoch())
);
