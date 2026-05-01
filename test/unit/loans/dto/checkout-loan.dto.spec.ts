import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CheckoutLoanDto } from '@/modules/loans/dto/checkout-loan.dto';

const VALID_BASE = {
  principal_ngn:  300_000,
  duration_days:  7,
  terms_accepted: true,
};

async function validateBody(body: unknown): Promise<{ dto: CheckoutLoanDto; errors: string[] }> {
  const dto = plainToInstance(CheckoutLoanDto, body);
  const errors = await validate(dto);
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
  return { dto, errors: messages };
}

describe('CheckoutLoanDto.collateral_release_address (optional but, when present, must not be empty)', () => {
  it('passes when the field is omitted entirely (it is optional)', async () => {
    const { errors, dto } = await validateBody({ ...VALID_BASE });
    expect(errors).toEqual([]);
    expect(dto.collateral_release_address).toBeUndefined();
  });

  it('passes with a normal Lightning address', async () => {
    const { errors, dto } = await validateBody({
      ...VALID_BASE,
      collateral_release_address: 'ada@blink.sv',
    });
    expect(errors).toEqual([]);
    expect(dto.collateral_release_address).toBe('ada@blink.sv');
  });

  it('rejects an empty string', async () => {
    const { errors } = await validateBody({ ...VALID_BASE, collateral_release_address: '' });
    expect(errors.join(' ')).toContain('should not be empty');
  });

  it('rejects a whitespace-only string (trimmed to empty)', async () => {
    const { dto, errors } = await validateBody({ ...VALID_BASE, collateral_release_address: '   ' });
    expect(dto.collateral_release_address).toBe('');
    expect(errors.join(' ')).toContain('should not be empty');
  });

  it('trims surrounding whitespace before validation', async () => {
    const { dto, errors } = await validateBody({
      ...VALID_BASE,
      collateral_release_address: '  ada@blink.sv  ',
    });
    expect(errors).toEqual([]);
    expect(dto.collateral_release_address).toBe('ada@blink.sv');
  });

  it('rejects values over 512 characters', async () => {
    const { errors } = await validateBody({
      ...VALID_BASE,
      collateral_release_address: 'a'.repeat(513),
    });
    expect(errors.join(' ')).toMatch(/must be shorter than or equal to 512/);
  });
});
