-- ============================================================
-- Current-state RLS policy for `schedules`.
--
-- This is a DERIVED reference, not the source of truth — it exists so an
-- agent can see a table's full current policy set without reading every
-- historical migration. The migrations in /supabase/migrations are what
-- actually ran against the database and stay authoritative; do not
-- "reconcile" a table by editing an already-applied migration, and don't
-- treat this file as something you can run standalone against a fresh DB
-- (it depends on the table already existing, created in 016_schedules.sql).
--
-- Defined in: 016_schedules.sql
--
-- Business rules on top of this policy (triggers in 016, not RLS): no
-- overlapping blocks per user/day, the profile must belong to the same
-- user, and an active Strict block cannot be updated or deleted. The
-- schedule is applied exclusively through the apply_schedule() RPC.
-- ============================================================

CREATE POLICY "Users manage own schedules"
  ON schedules
  FOR ALL
  USING (auth.uid() = user_id);
