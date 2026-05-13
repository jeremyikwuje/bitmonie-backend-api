import { registerAs } from '@nestjs/config';

export interface AppConfig {
  node_env: 'development' | 'staging' | 'production' | 'test';
  port: number;
  api_base_url: string;
  allowed_origin: string;
  log_level: string;
  internal_alert_email: string;
  // Optional override for the loans-team intake address. Falls back to
  // internal_alert_email when unset — see OpsAlertsService.alertNewLoanApplication.
  loan_applications_email: string;
  session_secret: string;
}

export default registerAs('app', (): AppConfig => ({
  node_env: (process.env.NODE_ENV as AppConfig['node_env']) ?? 'development',
  port: Number(process.env.PORT ?? 3000),
  api_base_url: process.env.API_BASE_URL ?? 'http://localhost:3000',
  allowed_origin: process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000',
  log_level: process.env.LOG_LEVEL ?? 'info',
  internal_alert_email: process.env.INTERNAL_ALERT_EMAIL ?? '',
  loan_applications_email: process.env.LOAN_APPLICATIONS_EMAIL ?? '',
  session_secret: process.env.SESSION_SECRET ?? '',
}));
