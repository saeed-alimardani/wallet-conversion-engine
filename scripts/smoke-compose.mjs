import { randomUUID } from 'node:crypto';

const baseUrl = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const timeoutMs = positiveInteger(process.env.SMOKE_TIMEOUT_MS ?? '60000', 'SMOKE_TIMEOUT_MS');
const deadline = Date.now() + timeoutMs;

const health = await request('/health');
assert(health.status === 'ok' && health.database === 'up', 'Health response was not ready');

const quote = await request('/quotes', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    userId: 'user-123',
    sourceAsset: 'USDT',
    targetAsset: 'BTC',
    sourceAmount: '10',
  }),
});
assert(typeof quote.quoteId === 'string', 'Quote response did not contain quoteId');

const accepted = await request(`/quotes/${quote.quoteId}/accept`, {
  method: 'POST',
  headers: { 'idempotency-key': randomUUID() },
});
assert(
  typeof accepted.conversionId === 'string',
  'Acceptance response did not contain conversionId',
);

let conversion;
do {
  conversion = await request(`/conversions/${accepted.conversionId}`);
  if (conversion.status === 'COMPLETED') {
    break;
  }
  if (['FAILED', 'REQUIRES_RECONCILIATION'].includes(conversion.status)) {
    throw new Error(`Conversion reached unexpected terminal status ${conversion.status}`);
  }
  await delay(250);
} while (Date.now() < deadline);

assert(conversion.status === 'COMPLETED', `Conversion did not complete within ${timeoutMs}ms`);
console.log(
  JSON.stringify({
    status: 'ok',
    quoteId: quote.quoteId,
    conversionId: accepted.conversionId,
    conversionStatus: conversion.status,
  }),
);

async function request(path, init) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${init?.method ?? 'GET'} ${path} returned non-JSON status ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      `${init?.method ?? 'GET'} ${path} failed with ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function positiveInteger(value, key) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
