import { Conversion } from '../conversion';
import { ConversionId } from '../conversion-id';

export interface ConversionRepository {
  save(conversion: Conversion): Promise<void>;
  findById(id: ConversionId): Promise<Conversion | null>;
}
