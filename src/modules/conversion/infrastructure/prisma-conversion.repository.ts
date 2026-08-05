import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/infrastructure/prisma/prisma.service';
import { PrismaDb } from '../../shared/infrastructure/prisma/prisma-client.types';
import { Asset } from '../../shared/domain/asset';
import { Money } from '../../shared/domain/money';
import { UserId } from '../../shared/domain/user-id';
import { QuoteId } from '../../pricing/domain/quote-id';
import { Conversion, ConversionStatus } from '../domain/conversion';
import { ConversionId } from '../domain/conversion-id';
import { ConversionRepository } from '../domain/ports/conversion-repository.port';

@Injectable()
export class PrismaConversionRepository implements ConversionRepository {
  private readonly db: PrismaDb;

  constructor(prisma: PrismaService) {
    this.db = prisma;
  }

  static forTransaction(tx: PrismaDb): PrismaConversionRepository {
    return new PrismaConversionRepository(tx as PrismaService);
  }

  async save(conversion: Conversion): Promise<void> {
    const data = {
      id: conversion.id.toString(),
      quoteId: conversion.quoteId.toString(),
      userId: conversion.userId.toString(),
      sourceAsset: conversion.sourceAmount.asset.code,
      targetAsset: conversion.targetAmount.asset.code,
      sourceAmount: conversion.sourceAmount.toString(),
      targetAmount: conversion.targetAmount.toString(),
      status: conversion.status,
      exchangeExecutionId: conversion.exchangeExecutionId,
      failureReason: conversion.failureReason,
      createdAt: conversion.createdAt,
      completedAt: conversion.completedAt,
    };

    await this.db.conversion.upsert({
      where: { id: data.id },
      create: data,
      update: {
        status: data.status,
        exchangeExecutionId: data.exchangeExecutionId,
        failureReason: data.failureReason,
        completedAt: data.completedAt,
      },
    });
  }

  async findById(id: ConversionId): Promise<Conversion | null> {
    const row = await this.db.conversion.findUnique({ where: { id: id.toString() } });
    if (!row) {
      return null;
    }
    return this.toDomain(row);
  }

  private toDomain(row: {
    id: string;
    quoteId: string;
    userId: string;
    sourceAsset: string;
    targetAsset: string;
    sourceAmount: unknown;
    targetAmount: unknown;
    status: string;
    exchangeExecutionId: string | null;
    failureReason: string | null;
    createdAt: Date;
    completedAt: Date | null;
  }): Conversion {
    const sourceAsset = Asset.of(row.sourceAsset);
    const targetAsset = Asset.of(row.targetAsset);
    return Conversion.reconstitute({
      id: ConversionId.of(row.id),
      quoteId: QuoteId.of(row.quoteId),
      userId: UserId.of(row.userId),
      sourceAmount: Money.of(String(row.sourceAmount), sourceAsset),
      targetAmount: Money.of(String(row.targetAmount), targetAsset),
      status: row.status as ConversionStatus,
      exchangeExecutionId: row.exchangeExecutionId,
      createdAt: row.createdAt,
      completedAt: row.completedAt,
      failureReason: row.failureReason,
    });
  }
}
