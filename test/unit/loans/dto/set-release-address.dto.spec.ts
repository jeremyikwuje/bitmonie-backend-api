import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SetReleaseAddressDto } from '@/modules/loans/dto/set-release-address.dto';

async function validateBody(body: unknown): Promise<{ dto: SetReleaseAddressDto; errors: string[] }> {
  const dto = plainToInstance(SetReleaseAddressDto, body);
  const errors = await validate(dto);
  // Flatten constraint messages so tests can assert on the wire-level signals.
  const messages = errors.flatMap((e) => Object.values(e.constraints ?? {}));
  return { dto, errors: messages };
}

describe('SetReleaseAddressDto', () => {
  it('accepts a normal Lightning address', async () => {
    const { dto, errors } = await validateBody({ collateral_release_address: 'ada@blink.sv' });
    expect(errors).toEqual([]);
    expect(dto.collateral_release_address).toBe('ada@blink.sv');
  });

  it('rejects an empty string', async () => {
    const { errors } = await validateBody({ collateral_release_address: '' });
    expect(errors.join(' ')).toContain('should not be empty');
  });

  it('rejects a whitespace-only string (trimmed to empty)', async () => {
    const { dto, errors } = await validateBody({ collateral_release_address: '   ' });
    expect(dto.collateral_release_address).toBe('');
    expect(errors.join(' ')).toContain('should not be empty');
  });

  it('rejects a missing field', async () => {
    const { errors } = await validateBody({});
    // Either the not-empty or the type message lands first depending on
    // class-validator version — both indicate a rejected request.
    expect(errors.join(' ')).toMatch(/should not be empty|must be a string/);
  });

  it('rejects values over 512 characters', async () => {
    const long_value = 'a'.repeat(513);
    const { errors } = await validateBody({ collateral_release_address: long_value });
    expect(errors.join(' ')).toMatch(/must be shorter than or equal to 512/);
  });

  it('trims surrounding whitespace before validation', async () => {
    const { dto, errors } = await validateBody({ collateral_release_address: '  ada@blink.sv  ' });
    expect(errors).toEqual([]);
    expect(dto.collateral_release_address).toBe('ada@blink.sv');
  });
});
