import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Either the root PrismaClient / PrismaService or a transaction client from
 * `$transaction`. Repositories accept this so the same SQL runs inside or outside
 * a Unit of Work without the domain layer knowing about Prisma.
 */
export type PrismaDb = PrismaClient | Prisma.TransactionClient;
