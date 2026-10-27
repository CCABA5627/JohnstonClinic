import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST',
};

function b64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// VAPID_PRIVATE_KEY secret must be stored as JSON: {"kty":"EC","crv":"P-256","d":"...","x":"...","y":"..."}
async function makeVapidJwt(subject: string, audience: string, privateKeyJwkStr: string, publicKeyB64: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })));
  const signing = `${header}.${payload}`;

  const jwk = JSON.parse(privateKeyJwkStr);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signing)
  );
  return `${signing}.${b64urlEncode(sig)}`;
}

async function encryptPayload(payload: string, clientPublicKeyB64: string, authB64: string): Promise<{ ciphertext: Uint8Array; salt: Uint8Array; serverPublicKey: Uint8Array }> {
  const encoder = new TextEncoder();
  const plaintext = encoder.encode(payload);
  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey);
  const serverPublicKey = new Uint8Array(serverPublicKeyRaw);
  const clientPublicKeyRaw = b64urlDecode(clientPublicKeyB64);
  const clientPublicKey = await crypto.subtle.importKey('raw', clientPublicKeyRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const sharedSecretBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey, 256);
  const auth = b64urlDecode(authB64);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const sharedSecretKey = await crypto.subtle.importKey('raw', sharedSecretBits, { name: 'HKDF' }, false, ['deriveBits']);
  const prkAuthInfo = encoder.encode('WebPush: info\x00');
  const prkAuthData = new Uint8Array(prkAuthInfo.length + clientPublicKeyRaw.length + serverPublicKey.length);
  prkAuthData.set(prkAuthInfo);
  prkAuthData.set(clientPublicKeyRaw, prkAuthInfo.length);
  prkAuthData.set(serverPublicKey, prkAuthInfo.length + clientPublicKeyRaw.length);
  const ikm = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: auth, info: prkAuthData }, sharedSecretKey, 256);
  const ikmKey = await crypto.subtle.importKey('raw', ikm, { name: 'HKDF' }, false, ['deriveBits']);
  const keyInfoData = encoder.encode('Content-Encoding: aes128gcm\x00');
  const cekBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: keyInfoData }, ikmKey, 128);
  const nonceInfoData = encoder.encode('Content-Encoding: nonce\x00');
  const nonceBits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfoData }, ikmKey, 96);
  const cek = await crypto.subtle.importKey('raw', cekBits, { name: 'AES-GCM' }, false, ['encrypt']);
  const nonce = new Uint8Array(nonceBits);
  const padded = new Uint8Array(plaintext.length + 1);
  padded.set(plaintext);
  padded[plaintext.length] = 0x02;
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, cek, padded);
  return { ciphertext: new Uint8Array(encrypted), salt, serverPublicKey };
}

function buildPushBody(salt: Uint8Array, serverPublicKey: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPublicKey.length);
  header.set(salt, 0);
  header[16] = (rs >> 24) & 0xff; header[17] = (rs >> 16) & 0xff;
  header[18] = (rs >> 8) & 0xff; header[19] = rs & 0xff;
  header[20] = serverPublicKey.length;
  header.set(serverPublicKey, 21);
  const body = new Uint8Array(header.length + ciphertext.length);
  body.set(header); body.set(ciphertext, header.length);
  return body;
}

async function sendWebPush(sub: { endpoint: string; p256dh: string; auth: string }, payloadStr: string, vapidPublic: string, vapidPrivateJwk: string, vapidSubject: string): Promise<{ status: number; ok: boolean; body: string }> {
  const url = new URL(sub.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  console.log(`Building JWT for audience: ${audience}`);
  const jwt = await makeVapidJwt(vapidSubject, audience, vapidPrivateJwk, vapidPublic);
  console.log('JWT built, encrypting...');
  const { ciphertext, salt, serverPublicKey } = await encryptPayload(payloadStr, sub.p256dh, sub.auth);
  console.log('Encrypted, sending to Apple...');
  const body = buildPushBody(salt, serverPublicKey, ciphertext);
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt},k=${vapidPublic}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': '86400',
    },
    body,
  });
  const resBody = await res.text().catch(() => '');
  console.log(`Apple response: ${res.status} ${resBody}`);
  return { status: res.status, ok: res.ok, body: resBody };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  try {
    const { title, body, tag, url: notifUrl } = await req.json().catch(() => ({}));
    const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')     ?? 'mailto:admin@example.com';
    console.log(`VAPID_PUBLIC set: ${!!VAPID_PUBLIC}, VAPID_PRIVATE set: ${!!VAPID_PRIVATE}`);
    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
    const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '');
    const { data: subs, error } = await supabase.from('push_subscriptions').select('*');
    if (error) throw error;
    if (!subs || subs.length === 0) return new Response(JSON.stringify({ sent: 0, message: 'No subscribers' }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    console.log(`Sending to ${subs.length} subscriber(s)`);
    const payload = JSON.stringify({ title: title || 'Johnston Clinic', body: body || 'Schedule has been updated', tag: tag || 'schedule-update', url: notifUrl || '/index.html' });
    const results = await Promise.allSettled(subs.map(async (sub: any) => {
      try {
        console.log(`Processing subscriber: ${sub.id}`);
        const result = await sendWebPush(sub, payload, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT);
        console.log(`Done - status: ${result.status}`);
        if (result.status === 410 || result.status === 404) await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        return result;
      } catch (e: any) {
        console.error(`FAILED for subscriber ${sub.id}: ${e.message}`);
        throw e;
      }
    }));
    const sent = results.filter(r => r.status === 'fulfilled' && (r.value as any).ok).length;
    console.log(`Sent ${sent}/${subs.length}`);
    return new Response(JSON.stringify({ sent, total: subs.length }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('notify-staff error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }
});
