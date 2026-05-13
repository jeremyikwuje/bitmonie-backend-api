import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { LoanApplication } from '@prisma/client';
import { LoanApplicationCollateralType } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { LoanApplicationsController } from '@/modules/loan-applications/loan-applications.controller';
import { LoanApplicationsService } from '@/modules/loan-applications/loan-applications.service';
import { BotTrapGuard } from '@/modules/loan-applications/guards/bot-trap.guard';
import { LoanApplicationsThrottlerGuard } from '@/modules/loan-applications/guards/loan-applications-throttler.guard';
import { GlobalExceptionFilter } from '@/common/filters/global-exception.filter';

function make_application_row(overrides: Partial<LoanApplication> = {}): LoanApplication {
  const now = new Date('2026-05-13T10:00:00.000Z');
  return {
    id:                      'app-uuid-001',
    created_at:              now,
    updated_at:              now,
    first_name:              'Ada',
    last_name:               'Lovelace',
    email:                   'ada@example.com',
    phone:                   '+2348035551234',
    collateral_type:         LoanApplicationCollateralType.BITCOIN,
    collateral_description:  '0.05 BTC',
    loan_amount_ngn:         new Prisma.Decimal('5000000.00'),
    status:                  'NEW',
    assigned_to_ops_user_id: null,
    notes:                   null,
    client_ip:               '203.0.113.5',
    user_agent:              'jest',
    ...overrides,
  };
}

function valid_body(): Record<string, unknown> {
  return {
    first_name:             'Ada',
    last_name:              'Lovelace',
    email:                  'ada@example.com',
    phone:                  '+2348035551234',
    collateral_type:        'Bitcoin (BTC)',
    collateral_description: '0.05 BTC',
    loan_amount_ngn:        5_000_000,
  };
}

describe('LoanApplicationsController (integration)', () => {
  let app: INestApplication;
  let service: { create: jest.Mock };

  beforeEach(async () => {
    service = { create: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      imports: [
        // Per-IP cap is 5/hour in prod; keep it tight here so test 8.10 stays fast.
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 5 }]),
      ],
      controllers: [LoanApplicationsController],
      providers: [
        { provide: LoanApplicationsService, useValue: service },
        BotTrapGuard,
        LoanApplicationsThrottlerGuard,
      ],
    }).compile();

    app = module.createNestApplication();
    app.useGlobalFilters(new GlobalExceptionFilter());
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── 8.1 happy path ──────────────────────────────────────────────────────────

  it('returns 201 + application_id for a valid submission', async () => {
    service.create.mockResolvedValue(make_application_row());

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(valid_body())
      .expect(201);

    expect(res.body).toEqual({ application_id: 'app-uuid-001' });
    expect(service.create).toHaveBeenCalledTimes(1);
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({
        first_name: 'Ada',
        email:      'ada@example.com',
        collateral_type_display: 'Bitcoin (BTC)',
      }),
    );
  });

  // ── 8.2 validation — missing first_name ─────────────────────────────────────

  it('returns 400 with VALIDATION_FAILED and a per-field detail when first_name is empty', async () => {
    const body = valid_body();
    body.first_name = '';

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([{ field: 'first_name', issue: 'First name is required' }]),
    );
    expect(service.create).not.toHaveBeenCalled();
  });

  // ── 8.3 validation — aggregate errors ───────────────────────────────────────

  it('returns 400 with details for every offending field', async () => {
    const body = valid_body();
    body.email           = 'not-an-email';
    body.loan_amount_ngn = 0;
    body.phone           = '123';

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(400);

    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const fields = res.body.error.details.map((d: { field: string }) => d.field);
    expect(fields).toEqual(expect.arrayContaining(['email', 'loan_amount_ngn', 'phone']));
  });

  // ── 8.3b collateral_description is optional ────────────────────────────────

  it('accepts a submission with collateral_description omitted', async () => {
    service.create.mockResolvedValue(make_application_row({ collateral_description: null }));

    const body = valid_body();
    delete body.collateral_description;

    await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ collateral_description: null }),
    );
  });

  // ── 8.4 validation — loan cap ───────────────────────────────────────────────

  it('returns 400 when loan_amount_ngn exceeds 100,000,000', async () => {
    const body = valid_body();
    body.loan_amount_ngn = 100_000_001;

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(400);

    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        { field: 'loan_amount_ngn', issue: 'Loan amount cannot exceed N100,000,000' },
      ]),
    );
  });

  // ── 8.5 validation — unknown collateral ─────────────────────────────────────

  it('returns 400 when collateral_type is not in the allowed enum', async () => {
    const body = valid_body();
    body.collateral_type = 'Gold bars';

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(400);

    expect(res.body.error.details).toEqual(
      expect.arrayContaining([{ field: 'collateral_type', issue: 'Select a collateral type' }]),
    );
  });

  // ── 8.6 validation — phone too short ────────────────────────────────────────

  it('returns 400 when phone has fewer than 7 digits', async () => {
    const body = valid_body();
    body.phone = '123';

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(400);

    expect(res.body.error.details).toEqual(
      expect.arrayContaining([{ field: 'phone', issue: 'Valid phone is required' }]),
    );
  });

  // ── 8.7 email normalisation ─────────────────────────────────────────────────

  it('lowercases + trims the email before passing to the service', async () => {
    service.create.mockResolvedValue(make_application_row());

    const body = valid_body();
    body.email = '  Ada.Lovelace@EXAMPLE.com  ';

    await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada.lovelace@example.com' }),
    );
  });

  // ── 8.8 string trimming ─────────────────────────────────────────────────────

  it('trims first_name before persisting', async () => {
    service.create.mockResolvedValue(make_application_row());

    const body = valid_body();
    body.first_name = '  Ada  ';

    await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ first_name: 'Ada' }),
    );
  });

  // ── 8.13 field-length limits ────────────────────────────────────────────────

  it('returns 400 when first_name is longer than 80 chars', async () => {
    const body = valid_body();
    body.first_name = 'A'.repeat(81);

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(400);

    expect(res.body.error.details).toEqual(
      expect.arrayContaining([{ field: 'first_name', issue: 'First name is too long' }]),
    );
  });

  // ── 8.11 honeypot ───────────────────────────────────────────────────────────

  it('silently drops a submission with a non-empty `website` honeypot', async () => {
    const body = valid_body();
    body.website = 'https://spammer.example';

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(res.body).toEqual({});           // empty body
    expect(service.create).not.toHaveBeenCalled();
  });

  // ── 8.11b fill-time gate trip ───────────────────────────────────────────────

  it('silently drops a submission submitted in under 1.5s of mount', async () => {
    const body = valid_body();
    body.rendered_at = Date.now();          // 0ms elapsed → tripped

    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(res.body).toEqual({});
    expect(service.create).not.toHaveBeenCalled();
  });

  // ── 8.11c missing rendered_at is permitted ──────────────────────────────────

  it('accepts a submission with rendered_at omitted entirely', async () => {
    service.create.mockResolvedValue(make_application_row());

    await request(app.getHttpServer())
      .post('/loan-applications')
      .send(valid_body())   // no rendered_at
      .expect(201);

    expect(service.create).toHaveBeenCalledTimes(1);
  });

  // ── 8.11d future rendered_at is ignored ─────────────────────────────────────

  it('ignores a future rendered_at timestamp (client clock skew)', async () => {
    service.create.mockResolvedValue(make_application_row());

    const body = valid_body();
    body.rendered_at = Date.now() + 60_000; // 60s in the future

    await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(service.create).toHaveBeenCalledTimes(1);
  });

  // ── 8.11e stale rendered_at is ignored ──────────────────────────────────────

  it('ignores a stale rendered_at older than 24h', async () => {
    service.create.mockResolvedValue(make_application_row());

    const body = valid_body();
    body.rendered_at = Date.now() - 86_500_000; // ~24h+1m ago

    await request(app.getHttpServer())
      .post('/loan-applications')
      .send(body)
      .expect(201);

    expect(service.create).toHaveBeenCalledTimes(1);
  });

  // ── 8.10 per-IP rate limit (5/window) ──────────────────────────────────────

  it('returns 429 after exceeding the per-IP throttle limit', async () => {
    service.create.mockResolvedValue(make_application_row());

    // First 5 submissions from the same IP succeed.
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/loan-applications')
        .set('X-Forwarded-For', '1.2.3.4')
        .send(valid_body())
        .expect(201);
    }

    // 6th from the same IP is throttled.
    const res = await request(app.getHttpServer())
      .post('/loan-applications')
      .set('X-Forwarded-For', '1.2.3.4')
      .send(valid_body())
      .expect(429);

    expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
    expect(service.create).toHaveBeenCalledTimes(5);
  });

  // ── §6.3 bot drops do not consume throttle budget ───────────────────────────

  it('honeypot drops do not consume the per-IP throttle budget', async () => {
    service.create.mockResolvedValue(make_application_row());

    // Fire 5 honeypot-tripped submissions from one IP.
    for (let i = 0; i < 5; i += 1) {
      await request(app.getHttpServer())
        .post('/loan-applications')
        .set('X-Forwarded-For', '5.6.7.8')
        .send({ ...valid_body(), website: 'spam' })
        .expect(201);
    }

    // A legitimate 6th submission from the same IP still succeeds.
    await request(app.getHttpServer())
      .post('/loan-applications')
      .set('X-Forwarded-For', '5.6.7.8')
      .send(valid_body())
      .expect(201);

    expect(service.create).toHaveBeenCalledTimes(1);
  });
});
