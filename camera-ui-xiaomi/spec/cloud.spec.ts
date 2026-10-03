// The Mi Home cloud client: its encryption against values the stream engine's own Xiaomi client computes for the same
// input (the engine opens the cameras with what the plugin hands it), and the sign-in with the captcha, the code
// sent to the phone and the stored token against a stand-in of the account server.
// Run: npx tsx spec/cloud.spec.ts
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey } from 'node:crypto';

import { LoginChallengeError, XiaomiAuthError, XiaomiCloud, apiBaseUrl, decryptResponse, encryptRequest } from '../src/xiaomi/cloud.js';
import { generateKeyPair } from '../src/xiaomi/keys.js';
import { rc4 } from '../src/xiaomi/rc4.js';
import { errorText } from '../src/xiaomi/text.js';
import { CAPTCHA, CAPTCHA_IMAGE, PASSWORD, TICKET, fakeXiaomi } from './fake-xiaomi.js';

// computed by the Xiaomi client of the stream engine (Go) for these inputs
const GO = {
  ssecurity: 'c2VjcmV0LXNzZWN1cml0eS0xNg==',
  nonce: '010203040506070801a2b3c4',
  path: '/v2/device/miss_get_vendor',
  params: '{"app_pubkey":"aa","did":"123","support_vendors":"TUTK_CS2_MTP"}',
  signedNonce: '42fd341627a7cd1e872525d6d0b9953e0ed999a37dc3eeb3e81d377a5cc5cf8c',
  data: '3U9puE5jmxW63N0pw5EVSLzgPiO0deGYKSkqEj8YfCR68Yfr12XEvVWsghyiq9mpbPvaWzzEJEPM80mRg4CKEw==',
  rc4Hash: '1F1duAlZgRaP4uJnjucGZITydDaidcfwS3NWHQ==',
  signature: 'vjDw84YDyAMcg+gFe6oo/vQW7hs=',
  nonceB64: 'AQIDBAUGBwgBorPE',
  response: '3U9rp1pZyVrom5o9hNhESLqnMDvyc+6YPylpRX9PPHIrvoy5yGLSjkqqsxOooIixdLvsLEStCGn4rzTm9bPLTIm+m22R3yVUC3rWkW+/jCE0TbZlpDhRYfTub+tFrTz404VrRXiCANNp99Y=',
  privateKey: 'a8abababababababababababababababababababababababababababababab6b',
  publicKey: 'e3712d851a0e5d79b831c5e34ab22b41a198171de209b8b8faca23a11c624859',
};

const realFetch = globalThis.fetch;
const tests: [string, () => Promise<void> | void][] = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

test('a request is encrypted and signed exactly as the Mi Home app does it', () => {
  const { values, key } = encryptRequest(GO.path, GO.params, Buffer.from(GO.ssecurity, 'base64'), Buffer.from(GO.nonce, 'hex'));
  assert.equal(key.toString('hex'), GO.signedNonce);
  assert.deepEqual(values, { data: GO.data, rc4_hash__: GO.rc4Hash, signature: GO.signature, _nonce: GO.nonceB64 });
});

test('an answer is decrypted to its result, and an error answer becomes an error', () => {
  const key = Buffer.from(GO.signedNonce, 'hex');
  assert.deepEqual(decryptResponse(GO.response, key), { public_key: 'bb', sign: 'cc', vendor: { vendor: 4, vendor_params: {} } });

  // an error of a device is an error, the session is fine
  const offline = rc4(key, Buffer.from(JSON.stringify({ code: -2, message: 'device offline' }))).toString('base64');
  assert.throws(
    () => decryptResponse(offline, key),
    (error: Error) => !(error instanceof XiaomiAuthError) && /device offline/.test(error.message),
  );
});

test('an answer the session cannot read means the session is gone, so the plugin signs in again', () => {
  const key = Buffer.from(GO.signedNonce, 'hex');
  // the API answers an ended session in plain JSON
  assert.throws(() => decryptResponse('{"code":2,"message":"auth err"}', key), XiaomiAuthError);
  // or with something that does not decrypt
  assert.throws(() => decryptResponse(Buffer.from('not json').toString('base64'), key), XiaomiAuthError);
  // a plain error that is not about the session stays an ordinary error
  assert.throws(
    () => decryptResponse('{"code":-6,"message":"too many requests"}', key),
    (error: Error) => !(error instanceof XiaomiAuthError) && /too many requests/.test(error.message),
  );
});

test('the key pairs are Curve25519 keys as the cameras expect them', () => {
  // the public key of a private key, as the engine computes it
  const der = Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(GO.privateKey, 'hex')]);
  const pub = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!;
  assert.equal(Buffer.from(pub, 'base64url').toString('hex'), GO.publicKey);

  const a = generateKeyPair();
  const b = generateKeyPair();
  assert.match(a.publicKey, /^[0-9a-f]{64}$/);
  assert.match(a.privateKey, /^[0-9a-f]{64}$/);
  assert.notEqual(a.privateKey, b.privateKey);
  const derived = createPublicKey(
    createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), Buffer.from(a.privateKey, 'hex')]), format: 'der', type: 'pkcs8' }),
  ).export({ format: 'jwk' }).x!;
  assert.equal(Buffer.from(derived, 'base64url').toString('hex'), a.publicKey);
});

test('an error is told with what caused it, and an address in it without its query', () => {
  // the shapes Node's fetch gives a name that does not resolve and a connection refused on every address
  const dns = new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND account.xiaomi.com'), { code: 'ENOTFOUND' }) });
  assert.equal(errorText(dns), 'fetch failed: getaddrinfo ENOTFOUND account.xiaomi.com');
  const refused = new TypeError('fetch failed', {
    cause: Object.assign(new AggregateError([new Error('connect ECONNREFUSED 10.0.0.1:443'), new Error('connect ECONNREFUSED ::1:443')], ''), { code: 'ECONNREFUSED' }),
  });
  assert.equal(errorText(refused), 'fetch failed: ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443');
  assert.equal(
    errorText(new Error('Invalid URL: https://sts.api.io.mi.com/sts?clientSign=SECRET&d=1 at hop 2')),
    'Invalid URL: https://sts.api.io.mi.com/sts?... at hop 2',
  );
  assert.equal(errorText('plain text'), 'plain text');
});

test('every region has its server, China the main one', () => {
  assert.equal(apiBaseUrl('cn'), 'https://api.io.mi.com/app');
  assert.equal(apiBaseUrl('ru'), 'https://ru.api.io.mi.com/app');
  assert.equal(apiBaseUrl('de'), 'https://de.api.io.mi.com/app');
  assert.equal(apiBaseUrl('evil.example'), 'https://api.io.mi.com/app');
});

test('a sign-in without questions gives the session and a token for the next start', async () => {
  const fake = fakeXiaomi({ devices: {}, tokens: new Set() });
  globalThis.fetch = fake.fetch;
  const cloud = new XiaomiCloud();
  await cloud.login('user@example.com', PASSWORD);
  assert.equal(cloud.signedIn, true);
  assert.deepEqual(cloud.credentials(), { userId: '42', passToken: 'PT1' });
});

test('a wrong password is said so', async () => {
  globalThis.fetch = fakeXiaomi({ devices: {}, tokens: new Set() }).fetch;
  await assert.rejects(
    new XiaomiCloud().login('user@example.com', 'wrong'),
    (error: Error) => error instanceof XiaomiAuthError && /Wrong account or password/.test(error.message),
  );
});

test('a captcha is shown as a picture, a wrong answer brings a new one, the right one signs in', async () => {
  globalThis.fetch = fakeXiaomi({ captcha: true, devices: {}, tokens: new Set() }).fetch;
  const cloud = new XiaomiCloud();
  const challenge = await cloud.login('user@example.com', PASSWORD).then(
    () => assert.fail('no captcha'),
    (error: unknown) => (error as LoginChallengeError).challenge,
  );
  assert.deepEqual(challenge, { kind: 'captcha', image: `data:image/jpeg;base64,${CAPTCHA_IMAGE.toString('base64')}` });

  await assert.rejects(cloud.loginWithCaptcha('WRONG'), (error: unknown) => error instanceof LoginChallengeError && error.challenge.kind === 'captcha');
  await cloud.loginWithCaptcha(CAPTCHA);
  assert.equal(cloud.signedIn, true);
});

test('a confirmation code: Xiaomi sends it, names where, and the right code signs in', async () => {
  globalThis.fetch = fakeXiaomi({ verify: true, devices: {}, tokens: new Set() }).fetch;
  const cloud = new XiaomiCloud();
  await assert.rejects(cloud.login('user@example.com', PASSWORD), (error: unknown) => {
    assert.ok(error instanceof LoginChallengeError);
    assert.deepEqual(error.challenge, { kind: 'verify', phone: '+7*****12', email: undefined });
    return true;
  });
  // a typo keeps the sign-in waiting for the same code, where it went is named again
  await assert.rejects(cloud.loginWithVerify('000000'), (error: unknown) => {
    assert.ok(error instanceof LoginChallengeError, String(error));
    assert.match(error.message, /The code was not accepted: wrong code/);
    assert.deepEqual(error.challenge, { kind: 'verify', phone: '+7*****12', email: undefined, rejected: 'wrong code' });
    return true;
  });
  await cloud.loginWithVerify(TICKET);
  assert.equal(cloud.signedIn, true);
  // the token and the secret come along the redirects after a code
  assert.deepEqual(cloud.credentials(), { userId: '42', passToken: 'PT-VERIFIED' });
});

test('the captcha first, then the code', async () => {
  globalThis.fetch = fakeXiaomi({ captcha: true, verify: true, devices: {}, tokens: new Set() }).fetch;
  const cloud = new XiaomiCloud();
  await assert.rejects(cloud.login('user@example.com', PASSWORD), (error: unknown) => (error as LoginChallengeError).challenge.kind === 'captcha');
  await assert.rejects(cloud.loginWithCaptcha(CAPTCHA), (error: unknown) => (error as LoginChallengeError).challenge.kind === 'verify');
  await cloud.loginWithVerify(TICKET);
  assert.equal(cloud.signedIn, true);
});

test('the captcha is found however its field is spelled, at an address relative to the account server or whole', async () => {
  // the engine (Go) reads `captchaURL` regardless of case, so which spelling Xiaomi sends is not known
  for (const variant of [{ captchaField: 'captchaUrl' }, { captchaField: 'captchaURL' }, { captchaField: 'captchaUrl', captchaAbsolute: true }]) {
    const name = JSON.stringify(variant);
    const fake = fakeXiaomi({ captcha: true, ...variant, devices: {}, tokens: new Set() });
    globalThis.fetch = fake.fetch;
    const cloud = new XiaomiCloud();
    const challenge = await cloud.login('user@example.com', PASSWORD).then(
      () => assert.fail(`no captcha: ${name}`),
      (error: unknown) => {
        assert.ok(error instanceof LoginChallengeError, `${name}: ${String(error)}`);
        return error.challenge;
      },
    );
    assert.deepEqual(challenge, { kind: 'captcha', image: `data:image/jpeg;base64,${CAPTCHA_IMAGE.toString('base64')}` }, name);
    assert.deepEqual(
      fake.calls.filter((c) => c.url.includes('/pass/getCode')).map((c) => c.url),
      ['https://account.xiaomi.com/pass/getCode?icodeType=login'],
      name,
    );
    await cloud.loginWithCaptcha(CAPTCHA);
    assert.equal(cloud.signedIn, true, name);
  }
});

test('a captcha Xiaomi asks before it sends the code is shown, and its answer gets the code sent', async () => {
  for (const variant of [{ captchaField: 'captchaUrl' }, { captchaField: 'captchaURL', captchaAbsolute: true }]) {
    const name = JSON.stringify(variant);
    globalThis.fetch = fakeXiaomi({ verify: true, ticketCaptcha: true, ...variant, devices: {}, tokens: new Set() }).fetch;
    const cloud = new XiaomiCloud();
    await assert.rejects(cloud.login('user@example.com', PASSWORD), (error: unknown) => error instanceof LoginChallengeError && error.challenge.kind === 'captcha', name);
    await assert.rejects(cloud.loginWithCaptcha(CAPTCHA), (error: unknown) => error instanceof LoginChallengeError && error.challenge.kind === 'verify', name);
    await cloud.loginWithVerify(TICKET);
    assert.equal(cloud.signedIn, true, name);
  }
});

test('the stored token signs in without the password, a token Xiaomi forgot is said so', async () => {
  globalThis.fetch = fakeXiaomi({ devices: {}, tokens: new Set(['PT1']) }).fetch;
  const cloud = new XiaomiCloud();
  await cloud.loginWithToken('42', 'PT1');
  assert.equal(cloud.signedIn, true);
  await assert.rejects(new XiaomiCloud().loginWithToken('42', 'OLD'), XiaomiAuthError);
});

test('API requests go encrypted with the session, and a refused session is an authentication error', async () => {
  const fake = fakeXiaomi({ devices: { ru: [] }, tokens: new Set(['PT1']) });
  globalThis.fetch = fake.fetch;
  const cloud = new XiaomiCloud();
  await cloud.loginWithToken('42', 'PT1');
  assert.deepEqual(await cloud.request('ru', '/v2/home/device_list_page', '{}'), { list: [], has_more: false });
  assert.equal(fake.calls.at(-1)?.url, 'https://ru.api.io.mi.com/app/v2/home/device_list_page');
  await assert.rejects(new XiaomiCloud().request('ru', '/v2/home/device_list_page', '{}'), XiaomiAuthError);
});

test('a Mi server that does not answer ends the request after 15 s, it does not hold the sign-in forever', async () => {
  // a server that takes the connection and never answers: only the signal of the request ends the wait
  globalThis.fetch = ((_input: unknown, init?: RequestInit) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof fetch;
  let deadline: NodeJS.Timeout | undefined;
  const started = Date.now();
  const outcome = await Promise.race([
    new XiaomiCloud().login('user@example.com', PASSWORD).then(
      () => 'signed in',
      (error: unknown) => error,
    ),
    new Promise((resolve) => (deadline = setTimeout(() => resolve('still waiting after 20 s'), 20_000))),
  ]);
  clearTimeout(deadline);
  const took = Date.now() - started;
  assert.ok(outcome instanceof Error, String(outcome));
  assert.equal(outcome.name, 'TimeoutError');
  assert.ok(took >= 14_500 && took < 17_000, `the request ended after ${took} ms`);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.error(`not ok - ${name}\n`, error);
  } finally {
    globalThis.fetch = realFetch;
  }
}
console.log(`${tests.length - failed}/${tests.length} passed`);
if (failed) process.exit(1);
