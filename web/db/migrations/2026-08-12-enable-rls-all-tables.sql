-- Close the PostgREST hole flagged by Supabase's rls_disabled_in_public advisor.
-- The app only ever reaches Postgres server-side through the pooler `postgres`
-- role, which is BYPASSRLS, so enabling RLS without policies denies the browser
-- facing anon/authenticated roles while leaving every runtime query untouched.
-- Run this AFTER the V0.3 migrations, so the tables they add are covered too.
-- Safe to run more than once.

ALTER TABLE app_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE videos ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotation_taxonomy_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE shot_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE shots ENABLE ROW LEVEL SECURITY;
ALTER TABLE field_answers ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotation_creative_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE annotation_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignment_review_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_revision_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_review_rounds ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_revision_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE approved_analysis_releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE wecom_app_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- Second layer: drop the table grants PostgREST relies on. Guarded on role
-- existence so the local demo Postgres, which has no Supabase roles, still runs
-- this file unchanged.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM authenticated;
  END IF;
END
$$;
