-- A schedule firing that is skipped (previous run still active, move not confirmed) is recorded in history
-- as a run with status 'skipped'. Such a row never executes and never holds an instance lock.

alter table runs drop constraint runs_status_check;
alter table runs add constraint runs_status_check check (status in (
  'queued', 'running', 'completed', 'completed_with_failures',
  'failed', 'cancelled', 'interrupted', 'skipped'));
