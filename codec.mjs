const keyBytes = Uint8Array.from([
  0x68, 0x9c, 0x8b, 0x2f, 0x16, 0xe3, 0xaf, 0x7d,
  0x44, 0xb9, 0x31, 0x25, 0x91, 0x6a, 0xd3, 0xc0,
  0x85, 0x37, 0xfa, 0x12, 0x9a, 0x75, 0x64, 0xbc,
  0xde, 0x03, 0x51, 0x48, 0x2e, 0xf8, 0xa6, 0x79,
]);
const invalid = () => new Error('This link is not valid');
const unsafe = /[\p{Cc}\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/;
const drivePattern = /^[A-Za-z0-9_-]{20,64}(?![\s\S])/;

function validate(value, creating) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['id', 't', 'd', 'title'].includes(k)) ||
      typeof value.id !== 'string' || !idPattern.test(value.id) ||
      typeof value.t !== 'number' || !Number.isFinite(value.t) || value.t < 0 || value.t > 86400 ||
      ('d' in value && (typeof value.d !== 'string' || !drivePattern.test(value.d))) ||
      ('title' in value && (typeof value.title !== 'string' || !value.title.isWellFormed()))) throw invalid();
  const result = {};
  if ('d' in value) result.d = value.d;
  result.id = value.id;
  result.t = value.t;
  if ('title' in value) {
    const title = value.title.replace(unsafe, '');
    if ((!creating && title !== value.title) || Array.from(title).length > 120) throw invalid();
    result.title = title;
  }
  return result;
}

function encodeBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeBytes(payload) {
  if (typeof payload !== 'string' || payload.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(payload) || payload.length % 4 === 1) throw invalid();
  const bytes = Uint8Array.from(atob(payload.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - payload.length % 4) % 4)), c => c.charCodeAt(0));
  if (bytes.length < 29 || encodeBytes(bytes) !== payload) throw invalid();
  return bytes;
}

async function key() {
  return crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function encode(value) {
  try {
    const data = new TextEncoder().encode(JSON.stringify(validate(value, true)));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, await key(), data));
    const bytes = new Uint8Array(1 + nonce.length + encrypted.length);
    bytes[0] = 1;
    bytes.set(nonce, 1);
    bytes.set(encrypted, 13);
    const payload = encodeBytes(bytes);
    if (payload.length > 2048) throw invalid();
    return payload;
  } catch { throw invalid(); }
}

export async function decode(payload) {
  try {
    const bytes = decodeBytes(payload);
    if (bytes[0] !== 1) throw invalid();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(1, 13) }, await key(), bytes.slice(13));
    const json = new TextDecoder('utf-8', { fatal: true }).decode(plain);
    return validate(JSON.parse(json), false);
  } catch { throw invalid(); }
}
