-- Captcha state, invite tracking, override tiers, group link codes. One wallet per account is now
-- enforced in code (configurable), so the blanket UNIQUE constraint on members.wallet goes.

ALTER TABLE members
  ADD COLUMN captcha_answer     TEXT,
  ADD COLUMN captcha_expires_at TIMESTAMPTZ,
  ADD COLUMN captcha_passed     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN reminded_at        TIMESTAMPTZ;

ALTER TABLE members DROP CONSTRAINT members_wallet_key;
CREATE INDEX members_wallet_idx ON members (wallet);

ALTER TABLE group_memberships
  ALTER COLUMN joined_at DROP NOT NULL,
  ALTER COLUMN joined_at DROP DEFAULT,
  ADD COLUMN invited_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN invite_link       TEXT,
  ADD COLUMN invite_expires_at TIMESTAMPTZ;
CREATE INDEX group_memberships_group ON group_memberships (group_id) WHERE removed_at IS NULL;

ALTER TABLE overrides ADD COLUMN tier_id TEXT;

CREATE TABLE link_codes (
  code        TEXT PRIMARY KEY,
  tier_id     TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT false
);
