-- Multi-user accounts replace the single environment-configured admin login.
-- The first user is created through the first-run setup, not by a migration.

create table users (
  id            uuid primary key default gen_random_uuid(),
  username      text not null check (username ~ '^[A-Za-z0-9._-]{3,64}$'),
  role          text not null check (role in ('admin', 'user')),
  password_hash text not null,
  created_at    timestamptz not null default now(),
  last_login_at timestamptz
);
create unique index users_username_lower on users (lower(username));

-- Existing sessions belong to the old single-admin model.
delete from sessions;
alter table sessions add column user_id uuid not null references users (id) on delete cascade;
create index sessions_user_id on sessions (user_id);

-- Obsolete: the old changeable admin password hash.
delete from settings where key = 'admin_password_hash';
