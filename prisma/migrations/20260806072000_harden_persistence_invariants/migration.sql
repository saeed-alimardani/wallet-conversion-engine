-- Backfill the execution identity for pre-hardening accepted conversions from their
-- transactionally-created outbox row.
UPDATE "conversions" AS c
SET "exchange_execution_id" = o."id"
FROM "outbox_messages" AS o
WHERE o."aggregate_id" = c."id"
  AND c."status" = 'FUNDS_RESERVED'
  AND c."exchange_execution_id" IS NULL;

-- A global key cannot be introduced safely if historical scopes reused one key.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "idempotency_records"
        GROUP BY "idempotency_key"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot make idempotency keys globally unique: duplicate historical keys exist';
    END IF;
END $$;

DROP INDEX "idempotency_records_scope_idempotency_key_key";
CREATE UNIQUE INDEX "idempotency_records_idempotency_key_key"
    ON "idempotency_records"("idempotency_key");

ALTER TABLE "wallet_accounts"
    ADD CONSTRAINT "wallet_accounts_non_negative_check"
        CHECK ("balance" >= 0 AND "available" >= 0 AND "reserved" >= 0),
    ADD CONSTRAINT "wallet_accounts_balance_invariant_check"
        CHECK ("available" + "reserved" = "balance"),
    ADD CONSTRAINT "wallet_accounts_asset_nonempty_check"
        CHECK (length(btrim("asset")) > 0);

ALTER TABLE "quotes"
    ADD CONSTRAINT "quotes_positive_values_check"
        CHECK ("source_amount" > 0 AND "target_amount" > 0 AND "rate" > 0),
    ADD CONSTRAINT "quotes_distinct_assets_check"
        CHECK ("source_asset" <> "target_asset"),
    ADD CONSTRAINT "quotes_lifecycle_check"
        CHECK (
            ("status" = 'ACTIVE' AND "accepted_at" IS NULL)
            OR ("status" = 'ACCEPTED' AND "accepted_at" IS NOT NULL)
        ),
    ADD CONSTRAINT "quotes_expiry_check"
        CHECK ("expires_at" > "created_at");

ALTER TABLE "conversions"
    ADD CONSTRAINT "conversions_positive_amounts_check"
        CHECK ("source_amount" > 0 AND "target_amount" > 0),
    ADD CONSTRAINT "conversions_distinct_assets_check"
        CHECK ("source_asset" <> "target_asset"),
    ADD CONSTRAINT "conversions_lifecycle_check"
        CHECK (
            (
                "status" = 'CREATED'
                AND "exchange_execution_id" IS NULL
                AND "completed_at" IS NULL
                AND "failure_reason" IS NULL
            )
            OR (
                "status" IN ('FUNDS_RESERVED', 'EXECUTION_REQUESTED')
                AND "exchange_execution_id" IS NOT NULL
                AND "completed_at" IS NULL
                AND "failure_reason" IS NULL
            )
            OR (
                "status" = 'COMPLETED'
                AND "exchange_execution_id" IS NOT NULL
                AND "completed_at" IS NOT NULL
                AND "failure_reason" IS NULL
            )
            OR (
                "status" = 'FAILED'
                AND "exchange_execution_id" IS NOT NULL
                AND "completed_at" IS NOT NULL
                AND "failure_reason" IS NOT NULL
            )
            OR (
                "status" = 'REQUIRES_RECONCILIATION'
                AND "exchange_execution_id" IS NOT NULL
                AND "completed_at" IS NULL
                AND "failure_reason" IS NOT NULL
            )
        );

ALTER TABLE "outbox_messages"
    ADD CONSTRAINT "outbox_messages_event_type_check"
        CHECK ("event_type" = 'ConversionExecutionRequested');

ALTER TABLE "idempotency_records"
    ADD CONSTRAINT "idempotency_records_nonempty_check"
        CHECK (
            length(btrim("scope")) > 0
            AND length(btrim("idempotency_key")) > 0
            AND length(btrim("request_hash")) > 0
        ),
    ADD CONSTRAINT "idempotency_records_response_consistency_check"
        CHECK (
            (
                "response_status" IS NULL
                AND "response_body" IS NULL
                AND "conversion_id" IS NULL
            )
            OR (
                "response_status" IS NOT NULL
                AND "response_body" IS NOT NULL
                AND "conversion_id" IS NOT NULL
            )
        );

ALTER TABLE "processed_messages"
    ADD CONSTRAINT "processed_messages_outcome_check"
        CHECK ("outcome" IN ('SUCCESS', 'FAILURE', 'UNKNOWN'));
