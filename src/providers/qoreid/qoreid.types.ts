import { z } from 'zod';

export const QoreidTokenResponseSchema = z.object({
  accessToken: z.string(),
  expiresIn: z.number(),
});

const InsightSchema = z.array(
  z.object({
    serviceCategory: z.string(),
    insightCount: z.number(),
    timeframeInMonths: z.number(),
  }),
).optional();

// POST /v1/ng/identities/bvn-premium/{bvnNumber}
export const QoreidBvnResponseSchema = z.object({
  bvn: z.object({
    bvn: z.string(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    middlename: z.string().optional(),
    birthdate: z.string().optional(),       // DD-MM-YYYY
    gender: z.string().optional(),
    marital_status: z.string().optional(),
    nationality: z.string().optional(),
    state_of_origin: z.string().optional(),
    state_of_residence: z.string().optional(),
    enrollment_bank: z.string().optional(),
    watch_listed: z.string().optional(),    // "YES" / "NO" — fraud signal
    name_on_card: z.string().optional(),
    level_of_account: z.string().optional(),
    // photo intentionally excluded
  }),
  insight: InsightSchema,
});

// POST /v1/ng/identities/nin/{ninNumber} — flat response
export const QoreidNinResponseSchema = z.object({
  nin: z.string(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
  middlename: z.string().optional(),
  birthdate: z.string().optional(),         // DD-MM-YYYY
  gender: z.string().optional(),
  maritalStatus: z.string().optional(),
  employmentStatus: z.string().optional(),
  birthState: z.string().optional(),
  birthCountry: z.string().optional(),
  nationality: z.string().optional(),
  lgaOfOrigin: z.string().optional(),
  stateOfOrigin: z.string().optional(),
  // photo, nin (raw), nextOfKin intentionally excluded
  insight: InsightSchema,
});

// POST /v1/ng/identities/passport/{passportNumber}
export const QoreidPassportResponseSchema = z.object({
  passport: z.object({
    passport_number: z.string(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    middlename: z.string().optional(),
    birthdate: z.string().optional(),       // DD-MM-YYYY
    gender: z.string().optional(),
    expiry_date: z.string().optional(),
    issued_date: z.string().optional(),
    // photo intentionally excluded
  }),
  insight: InsightSchema,
});

// POST /v1/ng/identities/drivers-license/{licenseNumber}
export const QoreidDriversLicenseResponseSchema = z.object({
  drivers_license: z.object({
    driversLicense: z.string(),
    firstname: z.string().optional(),
    lastname: z.string().optional(),
    birthdate: z.string().optional(),       // DD-MM-YYYY
    gender: z.string().optional(),
    state_of_issue: z.string().optional(),
    issued_date: z.string().optional(),
    expiry_date: z.string().optional(),
    // photo intentionally excluded
  }),
  insight: InsightSchema,
});

export type QoreidBvnResponse = z.infer<typeof QoreidBvnResponseSchema>;
export type QoreidNinResponse = z.infer<typeof QoreidNinResponseSchema>;
export type QoreidPassportResponse = z.infer<typeof QoreidPassportResponseSchema>;
export type QoreidDriversLicenseResponse = z.infer<typeof QoreidDriversLicenseResponseSchema>;
