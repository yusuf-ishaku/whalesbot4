-- Core schema. Single-community per deployment: no tenant ids anywhere.

CREATE TABLE deployments (
  id            BIGSERIAL PRIMARY KEY,
  code_version  TEXT NOT NULL,
  booted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE runtime_config (
  version     INTEGER PRIMARY KEY,
  config      JSONB NOT NULL,
  changed_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_accounts (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE members (
  telegram_id        BIGINT PRIMARY KEY,
  telegram_username  TEXT,
  wallet             TEXT UNIQUE,                 -- lowercase 0x address; one wallet per account
  status             TEXT NOT NULL DEFAULT 'new'  -- new | verified | grace | removed | banned
                     CHECK (status IN ('new','verified','grace','removed','banned')),
  current_tier       TEXT,
  grace_started_at   TIMESTAMPTZ,
  warned_at          TIMESTAMPTZ,
  last_check_at      TIMESTAMPTZ,
  last_check_result  JSONB,                       -- engine output incl. per-source read status
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE verification_codes (
  code         TEXT PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES members(telegram_id),
  expires_at   TIMESTAMPTZ NOT NULL,
  used         BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE group_memberships (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES members(telegram_id),
  group_id     TEXT NOT NULL,
  tier_id      TEXT,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at   TIMESTAMPTZ,
  reason       TEXT
);
CREATE INDEX group_memberships_active ON group_memberships (telegram_id) WHERE removed_at IS NULL;

CREATE TABLE overrides (
  id           BIGSERIAL PRIMARY KEY,
  telegram_id  BIGINT NOT NULL REFERENCES members(telegram_id),
  type         TEXT NOT NULL CHECK (type IN ('allowlist','ban')),
  set_by       TEXT NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ
);

CREATE TABLE audit_events (
  id        BIGSERIAL PRIMARY KEY,
  at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor     TEXT NOT NULL,        -- system | member:<id> | admin:<email>
  action    TEXT NOT NULL,
  subject   BIGINT,               -- telegram id when applicable
  details   JSONB NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_events_at ON audit_events (at DESC);
CREATE INDEX audit_events_subject ON audit_events (subject);
