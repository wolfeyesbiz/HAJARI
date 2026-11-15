/**
 * AttendEase server configuration.
 * All secrets come from environment variables — never hard-coded, never sent to the client.
 */
export type SmsDriver = 'msg91' | 'log';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  nodeEnv: env.NODE_ENV ?? 'development',
  /** PGlite (embedded real PostgreSQL compiled to WASM) data directory. */
  dataDir: env.PGDATA_DIR ?? './data/pg',
  dbDriver: (env.DB_DRIVER ?? 'pglite') as 'pglite' | 'postgres',
  databaseUrl: env.DATABASE_URL ?? '',
  sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 12),
  cookieSecure: env.COOKIE_SECURE === '1',
  trustProxy: env.TRUST_PROXY === '1',
  college: {
    name: env.COLLEGE_NAME ?? 'Sunrise Institute of Technology',
    address: env.COLLEGE_ADDRESS ?? 'Ring Road, Pune, Maharashtra 411045',
    shortName: env.COLLEGE_SHORT ?? 'SIT',
  },
  sms: {
    driver: (env.SMS_DRIVER ?? 'log') as SmsDriver,
    maxAttempts: Number(env.SMS_MAX_ATTEMPTS ?? 5),
    retryBaseSeconds: Number(env.SMS_RETRY_BASE_SECONDS ?? 30),
    workerEnabled: env.SMS_WORKER !== '0',
    workerIntervalMs: Number(env.SMS_WORKER_INTERVAL_MS ?? 15000),
    msg91: {
      authKey: env.MSG91_AUTH_KEY ?? '',
      senderId: env.MSG91_SENDER_ID ?? '',
      route: env.MSG91_ROUTE ?? '4',
      country: env.MSG91_COUNTRY ?? '91',
      flowId: env.MSG91_FLOW_ID ?? '',
      endpoint: env.MSG91_ENDPOINT ?? 'https://api.msg91.com/api/v5/flow',
      dltTemplateId: env.MSG91_DLT_TEMPLATE_ID ?? '',
    },
  },
};

export function smsConfigured(): boolean {
  if (config.sms.driver === 'msg91') {
    return Boolean(config.sms.msg91.authKey && config.sms.msg91.senderId && config.sms.msg91.flowId);
  }
  return false;
}

export function smsDriverLabel(): string {
  if (config.sms.driver === 'msg91') return 'MSG91 (live gateway)';
  return 'Log-only driver (no gateway credentials configured)';
}
