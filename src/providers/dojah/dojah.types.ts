import { z } from 'zod';

export const DojahBvnResponseSchema = z.object({
  entity: z.object({
    bvn: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    middle_name: z.string().optional(),
    full_name: z.string().optional(),
    date_of_birth: z.string().optional(),
    gender: z.string().optional(),
    phone_number1: z.string().optional(),
    phone_number2: z.string().optional(),
    // image intentionally excluded
  }),
});

export const DojahNinResponseSchema = z.object({
  entity: z.object({
    nin: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    middle_name: z.string().optional(),
    full_name: z.string().optional(),
    date_of_birth: z.string().optional(),
    gender: z.string().optional(),
    phone_number: z.string().optional(),
    employment_status: z.string().optional(),
    marital_status: z.string().optional(),
    // photo intentionally excluded
  }),
});

export const DojahPassportResponseSchema = z.object({
  entity: z.object({
    passport_number: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    middle_name: z.string().optional(),
    full_name: z.string().optional(),
    date_of_birth: z.string().optional(),
    gender: z.string().optional(),
    expiry_date: z.string().optional(),
    issued_date: z.string().optional(),
  }),
});

export const DojahDriversLicenseResponseSchema = z.object({
  entity: z.object({
    license_number: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    middle_name: z.string().optional(),
    full_name: z.string().optional(),
    date_of_birth: z.string().optional(),
    gender: z.string().optional(),
    expiry_date: z.string().optional(),
    state_of_issue: z.string().optional(),
  }),
});

export type DojahBvnResponse = z.infer<typeof DojahBvnResponseSchema>;
export type DojahNinResponse = z.infer<typeof DojahNinResponseSchema>;
export type DojahPassportResponse = z.infer<typeof DojahPassportResponseSchema>;
export type DojahDriversLicenseResponse = z.infer<typeof DojahDriversLicenseResponseSchema>;
