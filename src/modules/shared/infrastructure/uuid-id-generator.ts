import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { IdGenerator } from '../domain/ports/id-generator.port';

@Injectable()
export class UuidIdGenerator implements IdGenerator {
  generate(): string {
    return randomUUID();
  }
}
