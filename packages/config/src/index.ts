// Environment validation (TS §27): the service refuses to start when required settings are missing or unsafe.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';

export interface JwtKeyConfig { kid: string; privatePem?: string; publicPem: string }
export interface AppConfig {
  env: 'development' | 'test' | 'production';
  port: number; host: string; publicUrl: string;
  store: 'memory' | 'file' | 'mongo'; dataDir: string; mongoUrl: string; mongoDb: string;
  jwtKeys: JwtKeyConfig[]; activeKid: string;
  fieldEncKey: string; jobHmacKey: string; fileUrlKey: string;
  corsOrigins: string[]; cookieSecure: boolean;
  demoMode: boolean; metricsToken: string;
  passwordAlgo: 'scrypt' | 'argon2id'; hash: { N: number; r: number; p: number };
  rateLimits: boolean; logLevel: 'info' | 'warn' | 'error' | 'silent';
  smtp: { host: string; port: number; from: string } | null;
  bootstrap: { email: string; password: string } | null;
  runWorkerInProcess: boolean; webDir: string;
  /** Local development only: skip the second factor at sign-in (see mfaBypassActive). Always false outside development. */
  mfaDevBypass: boolean;
}
export class ConfigError extends Error {}

function genKey(): JwtKeyConfig {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return { kid: `k-${randomBytes(4).toString('hex')}`, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}
/** Development only: generated secrets are persisted under DATA_DIR so restarts keep sessions. Never used in production. */
function devSecrets(dir: string) {
  const file = join(dir, 'dev-secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  mkdirSync(dir, { recursive: true });
  const s = { jwt: genKey(), fieldEncKey: randomBytes(32).toString('base64'), jobHmacKey: randomBytes(32).toString('hex'), fileUrlKey: randomBytes(32).toString('hex') };
  writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  return s;
}

/**
 * Temporary "simple local mode" (owner's request, 2026-11-13): on a local development server, sign-in is email/username +
 * password only (no 2FA) and a Platform account can be created without a setup/invitation code.
 * ON by default for development (NODE_ENV=development or unset, as with `npm start` locally); turn it off with
 * AUTH_MFA_REQUIRED=true (`npm run dev:mfa`). NEVER active in production (where AUTH_MFA_REQUIRED=false is refused at
 * startup) or in test. Re-enable 2FA everywhere before deployment by removing this default.
 */
export function mfaDevBypassFromEnv(env: Record<string, string | undefined>): boolean {
  return (env.NODE_ENV === undefined || env.NODE_ENV === 'development') && env.AUTH_MFA_REQUIRED !== 'true';
}
/** Runtime guard used by every sign-in route: re-checks the environment so a config override cannot enable it elsewhere. */
export const mfaBypassActive = (config: Pick<AppConfig, 'env' | 'mfaDevBypass'>): boolean => config.env === 'development' && config.mfaDevBypass === true;

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const mode = (env.NODE_ENV ?? 'development') as AppConfig['env'];
  if (!['development', 'test', 'production'].includes(mode)) throw new ConfigError('NODE_ENV must be development, test or production');
  const prod = mode === 'production';
  const errors: string[] = [];
  const dataDir = env.DATA_DIR ?? './data';
  const store = (env.STORE ?? (prod ? 'mongo' : 'file')) as AppConfig['store'];
  if (!['memory', 'file', 'mongo'].includes(store)) errors.push('STORE must be memory, file or mongo');
  if (prod && store !== 'mongo' && env.ALLOW_NON_MONGO_STORE !== 'true') errors.push('production requires STORE=mongo (set ALLOW_NON_MONGO_STORE=true only for a documented single-node pilot)');
  if (store === 'mongo' && !env.MONGO_URL) errors.push('MONGO_URL is required when STORE=mongo');
  const demoMode = env.DEMO_MODE === 'true';
  if (prod && demoMode) errors.push('DEMO_MODE is refused in production (TR-026)');
  if (prod && env.AUTH_MFA_REQUIRED === 'false') errors.push('AUTH_MFA_REQUIRED=false is refused in production: MFA is always enforced');

  let jwtKeys: JwtKeyConfig[] = [], activeKid = '', fieldEncKey = env.FIELD_ENC_KEY ?? '', jobHmacKey = env.JOB_HMAC_KEY ?? '', fileUrlKey = env.FILE_URL_KEY ?? '';
  if (env.JWT_KEYS_JSON) {
    // Accepts raw JSON or the same JSON base64-encoded (safer to paste into hosting dashboards such as Railway Variables).
    const raw = env.JWT_KEYS_JSON.trim(); const json = /^[[{]/.test(raw) ? raw : Buffer.from(raw, 'base64').toString('utf8');
    try { jwtKeys = JSON.parse(json); activeKid = env.JWT_ACTIVE_KID ?? jwtKeys[0]?.kid ?? ''; } catch { errors.push('JWT_KEYS_JSON is not valid JSON (raw JSON or base64-encoded JSON)'); }
    if (!jwtKeys.find((k) => k.kid === activeKid && k.privatePem)) errors.push('JWT_ACTIVE_KID must name a key that has a privatePem');
  } else if (prod) errors.push('JWT_KEYS_JSON is required in production');
  if (prod) {
    if (Buffer.from(fieldEncKey, 'base64').length !== 32) errors.push('FIELD_ENC_KEY must be 32 random bytes, base64-encoded');
    if (jobHmacKey.length < 32) errors.push('JOB_HMAC_KEY must be at least 32 characters');
    if (fileUrlKey.length < 32) errors.push('FILE_URL_KEY must be at least 32 characters');
    if (!env.CORS_ORIGINS) errors.push('CORS_ORIGINS must list the allowed web origins');
    if (!env.PUBLIC_URL?.startsWith('https://')) errors.push('PUBLIC_URL must be an https:// URL in production');
  } else if (!jwtKeys.length || !fieldEncKey || !jobHmacKey || !fileUrlKey) {
    const s = mode === 'test' ? { jwt: genKey(), fieldEncKey: randomBytes(32).toString('base64'), jobHmacKey: randomBytes(32).toString('hex'), fileUrlKey: randomBytes(32).toString('hex') } : devSecrets(dataDir);
    if (!jwtKeys.length) { jwtKeys = [s.jwt]; activeKid = s.jwt.kid; }
    fieldEncKey ||= s.fieldEncKey; jobHmacKey ||= s.jobHmacKey; fileUrlKey ||= s.fileUrlKey;
  }
  const bootstrap = env.PLATFORM_ADMIN_EMAIL && env.PLATFORM_ADMIN_PASSWORD ? { email: env.PLATFORM_ADMIN_EMAIL, password: env.PLATFORM_ADMIN_PASSWORD } : null;
  if (bootstrap && bootstrap.password.length < 12) errors.push('PLATFORM_ADMIN_PASSWORD must be at least 12 characters');
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port < 0 || port > 65535) errors.push('PORT must be a valid port number');
  if (errors.length) throw new ConfigError(`Configuration is invalid:\n - ${errors.join('\n - ')}`);
  return {
    env: mode, port, host: env.HOST ?? '0.0.0.0', publicUrl: env.PUBLIC_URL ?? `http://localhost:${port}`,
    store, dataDir, mongoUrl: env.MONGO_URL ?? '', mongoDb: env.MONGO_DB ?? 'smartforce360',
    jwtKeys, activeKid, fieldEncKey, jobHmacKey, fileUrlKey,
    corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((x) => x.trim()).filter(Boolean), cookieSecure: prod || env.COOKIE_SECURE === 'true',
    demoMode, metricsToken: env.METRICS_TOKEN ?? '',
    passwordAlgo: env.PASSWORD_ALGO === 'argon2id' ? 'argon2id' : 'scrypt',
    hash: { N: Number(env.SCRYPT_N ?? (mode === 'test' ? 1024 : 32768)), r: 8, p: Number(env.SCRYPT_P ?? (mode === 'test' ? 1 : 3)) },
    rateLimits: env.RATE_LIMITS !== 'off', logLevel: (env.LOG_LEVEL as AppConfig['logLevel']) ?? (mode === 'test' ? 'silent' : 'info'),
    smtp: env.SMTP_HOST ? { host: env.SMTP_HOST, port: Number(env.SMTP_PORT ?? 1025), from: env.SMTP_FROM ?? 'no-reply@smartforce360.invalid' } : null,
    bootstrap, runWorkerInProcess: env.WORKER_IN_PROCESS !== 'false', webDir: env.WEB_DIR ?? './apps/web/dist',
    mfaDevBypass: mode === 'development' && mfaDevBypassFromEnv(env),
  };
}
export const testConfig = (over: Partial<AppConfig> = {}): AppConfig => ({ ...loadConfig({ NODE_ENV: 'test', STORE: 'memory', RATE_LIMITS: 'off' }), ...over });

/** Small local list of very common passwords (FR-AUTH-002). Replace with a larger list for production: docs/SECURITY_MODEL.md. */
export const BREACHED_PASSWORDS = new Set(`password password1 password12 password123 password1234 password12345 passw0rd p@ssw0rd p@ssword1 123456 1234567 12345678 123456789 1234567890 12345678910 123456789012 qwerty qwerty123 qwertyuiop qwerty12345 1q2w3e4r 1q2w3e4r5t 1qaz2wsx 1qaz2wsx3edc zaq12wsx letmein letmein123 welcome welcome1 welcome123 welcome1234 admin admin123 admin1234 administrator iloveyou iloveyou123 monkey dragon sunshine princess football baseball superman batman trustno1 master shadow michael jennifer abc123 abc12345 abcd1234 abcdefgh abcdefghij 111111 11111111 1111111111 000000 00000000 0000000000 121212 123123 123123123 654321 987654321 666666 696969 555555 777777 888888 999999 changeme changeme123 default secret secret123 test test123 test1234 testing123 guest login starwars whatever freedom hello hello123 hello12345 computer internet samsung google facebook security security123 smartforce smartforce360 smartforce123 fieldforce company123 summer2026 winter2026 spring2026 autumn2026 january2026 pakistan123 karachi123 lahore123 dubai123 riyadh123 qazwsxedc asdfghjkl asdfghjkl123 zxcvbnm zxcvbnm123 aaaaaaaaaa aaaaaaaaaaaa passwordpassword`.split(/\s+/));
