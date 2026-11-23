// npm run secrets — prints fresh secret values for .env (Ed25519 signing key, encryption and HMAC keys).
import { generateKeyPairSync, randomBytes } from 'node:crypto';
const { privateKey, publicKey } = generateKeyPairSync('ed25519'); const kid = `k${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`;
const keys = [{ kid, privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicPem: publicKey.export({ type: 'spki', format: 'pem' }) }];
console.log(`JWT_KEYS_JSON='${JSON.stringify(keys)}'\nJWT_ACTIVE_KID=${kid}\nFIELD_ENC_KEY=${randomBytes(32).toString('base64')}\nJOB_HMAC_KEY=${randomBytes(32).toString('hex')}\nFILE_URL_KEY=${randomBytes(32).toString('hex')}\nMETRICS_TOKEN=${randomBytes(24).toString('base64url')}`);
console.error('\nKey rotation: add a new key to JWT_KEYS_JSON, switch JWT_ACTIVE_KID, and remove the old key after the access-token lifetime (15 min).');
