-- CreateTable
CREATE TABLE "conversions" (
    "id" TEXT NOT NULL,
    "quote_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_asset" TEXT NOT NULL,
    "target_asset" TEXT NOT NULL,
    "source_amount" DECIMAL(38,18) NOT NULL,
    "target_amount" DECIMAL(38,18) NOT NULL,
    "status" TEXT NOT NULL,
    "exchange_execution_id" TEXT,
    "failure_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "aggregate_id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response_status" INTEGER,
    "response_body" JSONB,
    "conversion_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversions_user_id_idx" ON "conversions"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversions_quote_id_key" ON "conversions"("quote_id");

-- CreateIndex
CREATE INDEX "outbox_messages_published_at_created_at_idx" ON "outbox_messages"("published_at", "created_at");

-- CreateIndex
CREATE INDEX "idempotency_records_created_at_idx" ON "idempotency_records"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_scope_idempotency_key_key" ON "idempotency_records"("scope", "idempotency_key");
