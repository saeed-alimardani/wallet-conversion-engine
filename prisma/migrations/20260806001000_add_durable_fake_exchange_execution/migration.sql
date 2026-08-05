-- CreateTable
CREATE TABLE "fake_exchange_executions" (
    "client_order_id" TEXT NOT NULL,
    "conversion_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_asset" TEXT NOT NULL,
    "target_asset" TEXT NOT NULL,
    "source_amount" DECIMAL(38,18) NOT NULL,
    "target_amount" DECIMAL(38,18) NOT NULL,
    "outcome" TEXT NOT NULL,
    "reason" TEXT,
    "external_reference" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "fake_exchange_executions_pkey" PRIMARY KEY ("client_order_id"),
    CONSTRAINT "fake_exchange_executions_outcome_check"
        CHECK ("outcome" IN ('SUCCESS', 'FAILURE', 'UNKNOWN'))
);

-- CreateIndex
CREATE INDEX "fake_exchange_executions_conversion_id_idx"
    ON "fake_exchange_executions"("conversion_id");
