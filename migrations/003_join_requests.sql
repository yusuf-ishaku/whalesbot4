-- Pending Telegram join requests: held while the requester verifies a wallet, then approved or declined.
CREATE TABLE join_requests (
  id            BIGSERIAL PRIMARY KEY,
  group_id      TEXT NOT NULL,
  telegram_id   BIGINT NOT NULL REFERENCES members(telegram_id),
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT   -- approved | declined_short | declined_other | declined_banned | expired | failed
);
CREATE UNIQUE INDEX join_requests_pending ON join_requests (group_id, telegram_id) WHERE resolved_at IS NULL;
