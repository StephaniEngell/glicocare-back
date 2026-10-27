CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL CHECK (length(trim(name)) >= 2),
  email varchar(254) NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL CHECK (length(trim(name)) >= 2),
  timezone varchar(100) NOT NULL DEFAULT 'America/Sao_Paulo',
  locale varchar(10) NOT NULL DEFAULT 'pt-BR',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(20) NOT NULL CHECK (role IN ('owner','caregiver')),
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (patient_id,user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS memberships_active_user_idx ON memberships(patient_id,user_id) WHERE status='active';
CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  email varchar(254) NOT NULL,
  role varchar(20) NOT NULL CHECK (role='caregiver'),
  token_hash char(64) NOT NULL UNIQUE,
  status varchar(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS invitations_pending_patient_email_idx ON invitations(patient_id,email) WHERE status='pending';
CREATE TABLE IF NOT EXISTS care_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  author_user_id uuid NOT NULL REFERENCES users(id),
  occurred_at timestamptz NOT NULL,
  notes varchar(4000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS glucose_measurements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES care_events(id) ON DELETE CASCADE,
  measured_at timestamptz NOT NULL,
  value_mg_dl integer NOT NULL CHECK (value_mg_dl BETWEEN 1 AND 2000),
  meal_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS insulin_applications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES care_events(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL CHECK (status IN ('applied','pending')),
  units numeric(8,2) CHECK (units IS NULL OR units > 0),
  applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status='applied' OR (units IS NULL AND applied_at IS NULL))
);
CREATE TABLE IF NOT EXISTS sweet_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL UNIQUE REFERENCES care_events(id) ON DELETE CASCADE,
  consumed_at timestamptz NOT NULL,
  details varchar(1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL UNIQUE REFERENCES patients(id) ON DELETE CASCADE,
  local_time time NOT NULL DEFAULT '22:00',
  timezone varchar(100) NOT NULL DEFAULT 'America/Sao_Paulo',
  enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint text NOT NULL UNIQUE,
  keys jsonb NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reminder_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id uuid NOT NULL REFERENCES reminders(id) ON DELETE CASCADE,
  occurrence_date date NOT NULL,
  status varchar(20) NOT NULL CHECK (status IN ('queued','sent','partial','failed')),
  attempted_at timestamptz,
  sent_count integer NOT NULL DEFAULT 0,
  failed_count integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reminder_id,occurrence_date)
);
CREATE TABLE IF NOT EXISTS reminder_recipient_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_id uuid NOT NULL REFERENCES reminder_deliveries(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status varchar(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (delivery_id,subscription_id)
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  action varchar(30) NOT NULL,
  resource_type varchar(40) NOT NULL,
  resource_id varchar(100) NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS password_resets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash char(64) NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash char(64) NOT NULL,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 1,
  PRIMARY KEY (key_hash,window_start)
);
CREATE INDEX IF NOT EXISTS memberships_user_active_idx ON memberships(user_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS care_events_patient_date_idx ON care_events(patient_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS care_events_author_date_idx ON care_events(author_user_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS glucose_measurements_measured_at_idx ON glucose_measurements(measured_at DESC);
CREATE INDEX IF NOT EXISTS insulin_applications_applied_at_idx ON insulin_applications(applied_at DESC);
CREATE INDEX IF NOT EXISTS sweet_events_consumed_at_idx ON sweet_events(consumed_at DESC);
CREATE INDEX IF NOT EXISTS audit_logs_patient_date_idx ON audit_logs(patient_id,created_at DESC);
CREATE INDEX IF NOT EXISTS invitations_expiration_idx ON invitations(status,expires_at);
CREATE INDEX IF NOT EXISTS reminder_deliveries_state_idx ON reminder_deliveries(status,attempted_at);
CREATE INDEX IF NOT EXISTS reminder_recipient_retry_idx ON reminder_recipient_deliveries(status,next_attempt_at) WHERE status='queued';
