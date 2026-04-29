-- One row per inbound webhook. Two-phase write: insert at entry with
-- outcome=RECEIVED, update at exit with terminal outcome. raw_body is
-- PII-redacted at insert (account numbers, BVN/NIN masked). Pruned by
-- webhook-log-prune scheduler job (default WEBHOOK_LOG_RETENTION_DAYS=90).

CREATE TABLE "webhook_logs" (
  "id"                 UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider"           VARCHAR(50)  NOT NULL,
  "received_at"        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  "http_method"        VARCHAR(10)  NOT NULL,
  "http_path"          VARCHAR(255) NOT NULL,
  "headers"            JSONB,
  "raw_body"           TEXT         NOT NULL,
  "body_length"        INTEGER      NOT NULL,
  "signature_valid"    BOOLEAN,
  "outcome"            VARCHAR(50)  NOT NULL,
  "outcome_detail"     VARCHAR(1000),
  "processed_at"       TIMESTAMPTZ,
  "external_reference" VARCHAR(255)
);

CREATE INDEX "webhook_logs_provider_received_at_idx"
  ON "webhook_logs" ("provider", "received_at" DESC);

CREATE INDEX "webhook_logs_outcome_received_at_idx"
  ON "webhook_logs" ("outcome", "received_at" DESC);

CREATE INDEX "webhook_logs_external_reference_idx"
  ON "webhook_logs" ("external_reference");

CREATE INDEX "webhook_logs_received_at_idx"
  ON "webhook_logs" ("received_at");
