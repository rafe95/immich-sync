-- Server-side admin sessions. Only a SHA-256 of the cookie token is stored, so a database
-- leak does not yield usable session cookies. csrf_token is the per-session CSRF secret.

create table sessions (
  id_hash    text primary key,
  csrf_token text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_expires_at on sessions (expires_at);
