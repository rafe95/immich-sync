-- Per-user ownership: instances, jobs and runs belong to a user. Existing rows go to the oldest admin.
-- The foreign keys deliberately have no ON DELETE action: erasing a user deletes their rows explicitly.

alter table instances add column owner_id uuid references users (id);
alter table jobs add column owner_id uuid references users (id);
alter table runs add column owner_id uuid references users (id);
alter table users add column deleting_at timestamptz;

update instances set owner_id = (select id from users where role = 'admin' order by created_at limit 1) where owner_id is null;
update jobs set owner_id = (select id from users where role = 'admin' order by created_at limit 1) where owner_id is null;
update runs set owner_id = (select id from users where role = 'admin' order by created_at limit 1) where owner_id is null;

create index instances_owner_id on instances (owner_id);
create index jobs_owner_id on jobs (owner_id);
create index runs_owner_id on runs (owner_id);

-- Aliases and the default instance are per owner now.
alter table instances drop constraint instances_alias_key;
alter table instances add constraint instances_owner_id_alias_key unique (owner_id, alias);
drop index instances_single_default;
create unique index instances_single_default_per_owner on instances (owner_id) where is_default;
