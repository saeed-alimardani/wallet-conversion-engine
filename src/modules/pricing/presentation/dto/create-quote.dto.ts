import { IsNotEmpty, IsString, Matches } from 'class-validator';

/**
 * Request body for POST /quotes. Amounts are decimal strings (never JSON numbers)
 * so IEEE float cannot creep in at the HTTP boundary.
 */
export class CreateQuoteDto {
  @IsString()
  @IsNotEmpty()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]+$/, { message: 'sourceAsset must be an alphanumeric asset code' })
  sourceAsset!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9]+$/, { message: 'targetAsset must be an alphanumeric asset code' })
  targetAsset!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d+)?$/, {
    message: 'sourceAmount must be a non-negative decimal string',
  })
  sourceAmount!: string;
}
