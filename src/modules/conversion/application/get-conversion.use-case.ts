import { Inject, Injectable } from '@nestjs/common';
import { Conversion } from '../domain/conversion';
import { ConversionId } from '../domain/conversion-id';
import { ConversionRepository } from '../domain/ports/conversion-repository.port';
import { CONVERSION_REPOSITORY } from '../tokens';

export interface ConversionStatusResponse {
  conversionId: string;
  status: string;
  sourceAsset: string;
  targetAsset: string;
  sourceAmount: string;
  targetAmount: string;
  createdAt: string;
  completedAt: string | null;
}

export type GetConversionResult =
  | { kind: 'found'; body: ConversionStatusResponse }
  | { kind: 'not_found' }
  | { kind: 'invalid_id'; message: string };

function trimTrailingZeros(decimal: string): string {
  if (!decimal.includes('.')) {
    return decimal;
  }
  return decimal.replace(/\.?0+$/, '');
}

function toIso(date: Date): string {
  return date.toISOString().replace(/\.000Z$/, 'Z');
}

export function toConversionStatusResponse(conversion: Conversion): ConversionStatusResponse {
  return {
    conversionId: conversion.id.toString(),
    status: conversion.status,
    sourceAsset: conversion.sourceAmount.asset.code,
    targetAsset: conversion.targetAmount.asset.code,
    sourceAmount: trimTrailingZeros(conversion.sourceAmount.toString()),
    targetAmount: trimTrailingZeros(conversion.targetAmount.toString()),
    createdAt: toIso(conversion.createdAt),
    completedAt: conversion.completedAt ? toIso(conversion.completedAt) : null,
  };
}

@Injectable()
export class GetConversionUseCase {
  constructor(@Inject(CONVERSION_REPOSITORY) private readonly conversions: ConversionRepository) {}

  async execute(conversionIdRaw: string): Promise<GetConversionResult> {
    const trimmed = conversionIdRaw?.trim();
    if (!trimmed) {
      return { kind: 'invalid_id', message: 'conversionId must not be empty' };
    }

    let conversionId: ConversionId;
    try {
      conversionId = ConversionId.of(trimmed);
    } catch (error: unknown) {
      return {
        kind: 'invalid_id',
        message: error instanceof Error ? error.message : 'Invalid conversionId',
      };
    }

    const conversion = await this.conversions.findById(conversionId);
    if (!conversion) {
      return { kind: 'not_found' };
    }
    return { kind: 'found', body: toConversionStatusResponse(conversion) };
  }
}
