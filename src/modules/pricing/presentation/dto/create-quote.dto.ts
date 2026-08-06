import { IsNotEmpty, IsString, Matches, MaxLength } from 'class-validator';

/**
 * Request body for POST /quotes. Amounts are decimal strings (never JSON numbers)
 * so IEEE float cannot creep in at the HTTP boundary.
 */
export class CreateQuoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  userId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/, { message: 'sourceAsset must be an alphanumeric asset code' })
  sourceAsset!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(16)
  @Matches(/^[A-Za-z0-9]+$/, { message: 'targetAsset must be an alphanumeric asset code' })
  targetAsset!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(39)
  @Matches(/^(?:0|[1-9]\d{0,19})(?:\.\d{1,18})?$/, {
    message:
      'sourceAmount must be a positive decimal string with at most 20 integer and 18 fractional digits',
  })
  sourceAmount!: string;
}
