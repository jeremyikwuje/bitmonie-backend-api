import { z } from 'zod';

export const EASEID_RESP_CODE_SUCCESS = '00000000';

// ── BVN Enquiry ──────────────────────────────────────────────────────────────

export const EaseidBvnDataSchema = z.object({
  bvn: z.string(),
  firstName: z.string().optional(),
  middleName: z.string().optional(),
  lastName: z.string().optional(),
  gender: z.string().optional(),                 // Male | Female
  birthday: z.string().optional(),               // yyyy-MM-dd
  nameOnCard: z.string().optional(),
  // photo intentionally excluded — large base64 string
  phoneNumber: z.string().optional(),
  phoneNumber2: z.string().optional(),
  stateOfOrigin: z.string().optional(),
  lgaOfOrigin: z.string().optional(),
  maritalStatus: z.string().optional(),
  email: z.string().optional(),
  registrationDate: z.string().optional(),
  enrollmentBank: z.string().optional(),
  enrollmentBranch: z.string().optional(),
  watchListed: z.string().optional(),
  levelOfAccount: z.string().optional(),
  stateOfResidence: z.string().optional(),
  lgaOfResidence: z.string().optional(),
  residentialAddress: z.string().optional(),
  nationality: z.string().optional(),
});

export const EaseidBvnResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: EaseidBvnDataSchema.optional(),
  requestId: z.string().optional(),
  needCost: z.boolean().optional(),
});

export type EaseidBvnResponse = z.infer<typeof EaseidBvnResponseSchema>;

// ── NIN Enquiry ──────────────────────────────────────────────────────────────
// NB: NIN response uses `surname` (not lastName) and `birthDate` (not birthday)

export const EaseidNinDataSchema = z.object({
  nin: z.string(),
  firstName: z.string().optional(),
  middleName: z.string().optional(),
  surname: z.string().optional(),
  gender: z.string().optional(),                 // Male | Female
  birthDate: z.string().optional(),              // yyyy-MM-dd
  // photo intentionally excluded — large base64 string
  telephoneNo: z.string().optional(),
});

export const EaseidNinResponseSchema = z.object({
  respCode: z.string(),
  respMsg: z.string(),
  data: EaseidNinDataSchema.optional(),
  requestId: z.string().optional(),
  needCost: z.boolean().optional(),
});

export type EaseidNinResponse = z.infer<typeof EaseidNinResponseSchema>;
