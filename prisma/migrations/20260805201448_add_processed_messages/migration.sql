-- CreateTable
CREATE TABLE "processed_messages" (
    "event_id" TEXT NOT NULL,
    "conversion_id" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processed_messages_pkey" PRIMARY KEY ("event_id")
);

-- CreateIndex
CREATE INDEX "processed_messages_conversion_id_idx" ON "processed_messages"("conversion_id");
