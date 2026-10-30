-- Unverified joiners are muted and held ("quarantine") instead of being kicked on sight.
ALTER TABLE join_requests
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'request',   -- request | quarantine
  ADD COLUMN notice_message_id BIGINT;
