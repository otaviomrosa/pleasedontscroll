-- ============================================================
-- Current-state RLS policy for `blocked_urls`.
--
-- This is a DERIVED reference, not the source of truth — it exists so an
-- agent can see a table's full current policy set without reading every
-- historical migration. The migrations in /supabase/migrations are what
-- actually ran against the database and stay authoritative; do not
-- "reconcile" a table by editing an already-applied migration, and don't
-- treat this file as something you can run standalone against a fresh DB
-- (it depends on the table already existing, created in 001_initial_schema.sql).
--
-- Defined in: 001_initial_schema.sql
-- Touched by: 003_profiles.sql (added the profile_id column; policy unchanged)
-- Touched by: 017_lock_down_client_writes.sql (grants, not policy: no UPDATE for
--   authenticated, entries are added or removed, never edited; anon holds nothing)
-- ============================================================

CREATE POLICY "Users manage own blocked_urls"
  ON blocked_urls
  FOR ALL
  USING (auth.uid() = user_id);
