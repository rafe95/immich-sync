-- Initial schema. See SPEC.md: Concepts, Instances, Scheduled jobs, Batch jobs, Execution.

create table instances (
  id              uuid primary key default gen_random_uuid(),
  alias           text not null unique check (alias ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  api_url         text not null,
  api_key_enc     bytea not null,          -- encrypted with SECRET_KEY, never returned by the API
  note            text,
  is_default      boolean not null default false,
  last_check      jsonb,                   -- result of the last "Test connection"
  last_checked_at timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
-- at most one default instance
create unique index instances_single_default on instances (is_default) where is_default;

create table jobs (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table job_steps (
  id         uuid primary key default gen_random_uuid(),
  job_id     uuid not null references jobs (id) on delete cascade,
  position   integer not null,
  operation  text not null check (operation in ('copy', 'move', 'sync_metadata')),
  source_id  uuid not null references instances (id) on delete restrict,
  target_id  uuid not null references instances (id) on delete restrict,
  options    jsonb not null default '{}', -- range, kind, metadata, ...
  on_failure text not null default 'continue' check (on_failure in ('continue', 'stop')),
  on_error   text not null default 'stop' check (on_error in ('stop', 'continue')),
  unique (job_id, position),
  check (source_id <> target_id)
);

create table schedules (
  id                uuid primary key default gen_random_uuid(),
  job_id            uuid not null unique references jobs (id) on delete cascade,
  cron              text not null,
  timezone          text not null,
  enabled           boolean not null default true,
  catch_up          boolean not null default false,
  move_confirmed_at timestamptz,            -- required when the job contains a move step
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table runs (
  id          uuid primary key default gen_random_uuid(),
  job_id      uuid references jobs (id) on delete set null,
  job_name    text not null,
  trigger     text not null check (trigger in ('manual', 'schedule')),
  started_by  text not null,               -- 'admin' or 'schedule'
  dry_run     boolean not null default false,
  status      text not null default 'queued' check (status in (
                'queued', 'running', 'completed', 'completed_with_failures',
                'failed', 'cancelled', 'interrupted')),
  settings    jsonb not null,              -- exact steps and options at start time
  summary     jsonb,
  created_at  timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz
);
create index runs_created_at on runs (created_at desc);

create table run_steps (
  id          uuid primary key default gen_random_uuid(),
  run_id      uuid not null references runs (id) on delete cascade,
  position    integer not null,
  status      text not null default 'pending' check (status in (
                'pending', 'running', 'completed', 'completed_with_failures',
                'error', 'cancelled', 'not_run')),
  summary     jsonb,
  started_at  timestamptz,
  finished_at timestamptz,
  unique (run_id, position)
);

-- Structured log events of a run: the console replays these, progress bars read them.
create table run_events (
  id      bigserial primary key,
  run_id  uuid not null references runs (id) on delete cascade,
  ts      timestamptz not null default now(),
  level   text not null check (level in ('debug', 'info', 'warning', 'error')),
  type    text not null,                   -- log | progress | asset | summary
  message text,
  data    jsonb
);
create index run_events_by_run on run_events (run_id, id);

create table settings (
  key   text primary key,
  value jsonb not null
);
