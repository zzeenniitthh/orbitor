/* @license Enterprise */

// Orbitor fork — self-generated enterprise license minter.
//
// Standalone Node script (NOT wired into Nest). Given our RSA private key, it
// prints an ENTERPRISE_KEY and an ENTERPRISE_VALIDITY_TOKEN that the server
// trusts once ORBITOR_LICENSE_PUBLIC_KEY (the matching public key) is set on
// the instance. This lets a self-hosted Orbitor unlock enterprise features
// without phoning home to twenty.com.
//
// The signing/verification scheme must match
// EnterprisePlanService.verifyJwt():
//   - header  {"alg":"RS256","typ":"JWT"}
//   - signing input  base64url(header) + "." + base64url(payload)
//   - signature  RS256 (RSA PKCS#1 v1.5 over SHA-256), base64url-encoded
//
// Usage (run with tsx from packages/twenty-server):
//   npx tsx scripts/generate-orbitor-license.ts \
//     --private-key ./orbitor-license-private.pem \
//     --licensee "Orbitor" \
//     --sub "orbitor-self-hosted" \
//     --expires-in-years 100
//
// Generate the keypair first (keep the private key secret, never commit it):
//   openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 \
//     -out orbitor-license-private.pem
//   openssl rsa -in orbitor-license-private.pem -pubout \
//     -out orbitor-license-public.pem
//
// The public key (orbitor-license-public.pem) goes into the
// ORBITOR_LICENSE_PUBLIC_KEY env var; the two printed tokens go into
// ENTERPRISE_KEY and ENTERPRISE_VALIDITY_TOKEN.

import * as crypto from 'crypto';
import { readFileSync } from 'fs';

type EnterpriseKeyPayload = {
  sub: string;
  licensee: string;
  iat: number;
};

type EnterpriseValidityPayload = {
  sub: string;
  status: 'valid';
  iat: number;
  exp: number;
};

const base64url = (input: Buffer | string): string =>
  (Buffer.isBuffer(input) ? input : Buffer.from(input))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');

const signRs256Jwt = (
  payload: Record<string, unknown>,
  privateKey: string,
): string => {
  const header = { alg: 'RS256', typ: 'JWT' };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(
    JSON.stringify(payload),
  )}`;

  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });

  return `${signingInput}.${base64url(signature)}`;
};

// Mirrors EnterprisePlanService.verifyJwt() so we fail loudly here if a minted
// token would not verify on the server.
const verifyRs256Jwt = (token: string, publicKey: string): boolean => {
  const parts = token.split('.');

  if (parts.length !== 3) {
    return false;
  }

  const [encodedHeader, encodedPayload, signature] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signatureBuffer = Buffer.from(
    signature.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (signature.length % 4)) % 4),
    'base64',
  );

  return crypto.verify(
    'sha256',
    Buffer.from(signingInput),
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
    signatureBuffer,
  );
};

const parseArgs = (argv: string[]): Record<string, string> => {
  const args: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];

      if (next === undefined || next.startsWith('--')) {
        args[key] = 'true';
      } else {
        args[key] = next;
        i++;
      }
    }
  }

  return args;
};

const main = (): void => {
  const args = parseArgs(process.argv.slice(2));

  const privateKeyPath = args['private-key'];

  if (!privateKeyPath) {
    // eslint-disable-next-line no-console
    console.error(
      'Missing --private-key <path-to-pem>.\n\n' +
        'Example:\n' +
        '  npx tsx scripts/generate-orbitor-license.ts \\\n' +
        '    --private-key ./orbitor-license-private.pem \\\n' +
        '    --licensee "Orbitor" --sub "orbitor-self-hosted" \\\n' +
        '    --expires-in-years 100',
    );
    process.exit(1);
  }

  const privateKey = readFileSync(privateKeyPath, 'utf-8');
  // Optional public key to self-verify the minted tokens before printing.
  const publicKey = args['public-key']
    ? readFileSync(args['public-key'], 'utf-8')
    : null;

  const licensee = args['licensee'] ?? 'Orbitor';
  const sub = args['sub'] ?? 'orbitor-self-hosted';
  const expiresInYears = Number(args['expires-in-years'] ?? '100');

  if (!Number.isFinite(expiresInYears) || expiresInYears <= 0) {
    // eslint-disable-next-line no-console
    console.error('--expires-in-years must be a positive number');
    process.exit(1);
  }

  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + Math.round(expiresInYears * 365 * 24 * 60 * 60);

  const keyPayload: EnterpriseKeyPayload = { sub, licensee, iat };
  const validityPayload: EnterpriseValidityPayload = {
    sub,
    status: 'valid',
    iat,
    exp,
  };

  const enterpriseKey = signRs256Jwt(keyPayload, privateKey);
  const enterpriseValidityToken = signRs256Jwt(validityPayload, privateKey);

  if (publicKey) {
    const keyOk = verifyRs256Jwt(enterpriseKey, publicKey);
    const validityOk = verifyRs256Jwt(enterpriseValidityToken, publicKey);

    if (!keyOk || !validityOk) {
      // eslint-disable-next-line no-console
      console.error(
        `Self-verification FAILED (key=${keyOk}, validity=${validityOk}). ` +
          'Does --public-key match --private-key?',
      );
      process.exit(1);
    }
  }

  const expiresAtIso = new Date(exp * 1000).toISOString();

  /* eslint-disable no-console */
  console.log('# Orbitor self-generated enterprise license');
  console.log(`# licensee: ${licensee}`);
  console.log(`# sub:      ${sub}`);
  console.log(`# expires:  ${expiresAtIso}`);
  console.log(
    publicKey
      ? '# self-verification: PASSED (tokens verify against --public-key)'
      : '# self-verification: SKIPPED (pass --public-key to verify)',
  );
  console.log('');
  console.log(
    '# Set these on BOTH the Railway "orbitor" and "worker" services',
  );
  console.log('# (alongside ORBITOR_LICENSE_PUBLIC_KEY = the public key PEM):');
  console.log('');
  console.log(`ENTERPRISE_KEY=${enterpriseKey}`);
  console.log('');
  console.log(`ENTERPRISE_VALIDITY_TOKEN=${enterpriseValidityToken}`);
  /* eslint-enable no-console */
};

main();
