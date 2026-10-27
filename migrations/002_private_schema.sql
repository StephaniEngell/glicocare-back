CREATE SCHEMA IF NOT EXISTS glicocare;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'users', 'patients', 'memberships', 'invitations', 'care_events',
    'glucose_measurements', 'insulin_applications', 'sweet_events', 'reminders',
    'push_subscriptions', 'reminder_deliveries', 'reminder_recipient_deliveries',
    'audit_logs', 'password_resets', 'rate_limits'
  ] LOOP
    IF to_regclass(format('public.%I', table_name)) IS NOT NULL
       AND to_regclass(format('glicocare.%I', table_name)) IS NULL THEN
      EXECUTE format('ALTER TABLE public.%I SET SCHEMA glicocare', table_name);
    END IF;
  END LOOP;
END $$;

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA glicocare FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA glicocare FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA glicocare TO glicocare_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA glicocare TO glicocare_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA glicocare TO glicocare_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA glicocare
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA glicocare
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA glicocare
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO glicocare_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA glicocare
  GRANT USAGE, SELECT ON SEQUENCES TO glicocare_runtime;
ALTER ROLE glicocare_runtime IN DATABASE postgres SET search_path TO glicocare, public;
