import { Module } from '@nestjs/common';
import { PrismaWalletRepository } from './infrastructure/prisma-wallet.repository';
import { WALLET_REPOSITORY } from './tokens';

/**
 * Wallet bounded context. No public controller in this feature — the spec's API surface
 * has no wallet-creation endpoint (funding is via seed data only, see prisma/seed.ts).
 * Exposes `WalletRepository` for the conversion context's accept-orchestration (Feature 3).
 */
@Module({
  providers: [{ provide: WALLET_REPOSITORY, useClass: PrismaWalletRepository }],
  exports: [WALLET_REPOSITORY],
})
export class WalletModule {}
