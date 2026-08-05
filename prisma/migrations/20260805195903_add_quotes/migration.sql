-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_asset" TEXT NOT NULL,
    "target_asset" TEXT NOT NULL,
    "source_amount" DECIMAL(38,18) NOT NULL,
    "target_amount" DECIMAL(38,18) NOT NULL,
    "rate" DECIMAL(38,18) NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "accepted_at" TIMESTAMP(3),

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "quotes_user_id_idx" ON "quotes"("user_id");
