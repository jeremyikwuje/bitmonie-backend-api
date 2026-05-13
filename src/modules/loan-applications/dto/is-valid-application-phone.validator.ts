import { registerDecorator, type ValidationOptions } from 'class-validator';

// Phone rule per docs/loan-applications.md §3 V06:
//   - ≤ 40 chars raw (formatting tolerated: +, spaces, dashes, parens)
//   - ≥ 7 digits after stripping non-digits (real numbers have at least 7)
//
// We accept formatted strings because the landing-page input doesn't enforce
// a canonical format; the loans team handles normalisation downstream.
export function IsValidApplicationPhone(validation_options?: ValidationOptions) {
  return function (object: object, property_name: string): void {
    registerDecorator({
      name:         'isValidApplicationPhone',
      target:       object.constructor,
      propertyName: property_name,
      options:      validation_options,
      validator:    {
        validate(value: unknown): boolean {
          if (typeof value !== 'string') return false;
          if (value.length === 0) return false;
          if (value.length > 40) return false;
          const digits = value.replace(/\D/g, '');
          return digits.length >= 7;
        },
      },
    });
  };
}
