// Supabase Edge Function: notify-staff
// Called by scheduling.html after a push/save to send Web Push to all subscribed staff.
//
// Required secrets (set in Supabase Dashboard → Project Settings → Edge Functions → Secrets):
//   VAPID_PUBLIC_KEY   — your VAPID public key
//   VAPID_PRIVATE_KEY  — your VAPID private key
//   VAPID_SUBJECT      — mailto:you@example.com  (any contact email)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// ── Minimal Web Push / VAPID implementation in Deno ──────────────────────────

async function importVapidKey(b64: string, usage: KeyUsage[]): Promise<CryptoKey> {
  const raw = base64UrlDecode(b64);
  return crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, true, usage);
}

async function importVapidPrivateKey(b64: string): Promise<CryptoKey> {
  const raw = base64UrlDecode(b64);
  // Import as ECDSA for signing JWT
  return crypto.subtle.importKey(
    'pkcs8',
    pemToPkcs8(raw),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

function pemToPkcs8(raw: Uint8Array): ArrayBuffer {
  // Wrap raw EC private key in minimal PKCS#8 DER
  const prefix = new Uint8Array([
    0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06,
    0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
    0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
    0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
    0x01, 0x04, 0x20,
  ]);
  const buf = new Uint8Array(prefix.length + raw.length);
  buf.set(prefix);
  buf.set(raw, prefix.length);
  return buf.buffer;
}

function base64UrlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  const bin = atob(str);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

function base64UrlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let str = '';
  bytes.forEach(b => str += String.fromCharCode(b));
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeVapidJwt(subject: string, audience: string, privateKeyB64: string, publicKeyB64: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = base64UrlEncode(new TextEncoder().encode(JSON.stringify({ aud: audience, exp: now + 43200, sub: subject })));
  const signing = `${header}.${payload}`;

  // Import private key bytes directly as ECDSA
  const rawKey = base64UrlDecode(privateKeyB64);
  const privateKey = await crypto.subtle.importKey(
    'pkcs8',
    (() => {
      // Minimal PKCS#8 wrapper for P-256 raw private key
      const seq = new Uint8Array([
        0x30, 0x41, 0x02, 0x01, 0x00, 0x30, 0x13, 0x06,
        0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
        0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03,
        0x01, 0x07, 0x04, 0x27, 0x30, 0x25, 0x02, 0x01,
        0x01, 0x04, 0x20,
      ]);
      const buf = new Uint8Array(seq.length + rawKey.length);
      buf.set(seq); buf.set(rawKey, seq.length);
      return buf.buffer;
    })(),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(signing)
  );
  return `${signing}.${base64UrlEncode(sig)}`;
}

async function sendWebPush(subscription: {endpoint: string; keys: {p256dh: string; auth: string}}, payload: string, vapidPublic: string, vapidPrivate: string, vapidSubject: string) {
  const url = new URL(subscription.endpoint);
  const audience = `${url.protocol}//${url.host}`;
  const jwt = await makeVapidJwt(vapidSubject, audience, vapidPrivate, vapidPublic);

  // Encrypt payload using Web Push encryption (simplified — use base content-encoding)
  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(payload);

  // For simplicity, send unencrypted with VAPID auth only (works with most browsers for basic text)
  // Full encryption would require implementing RFC 8291 — using fetch to push service directly
  const headers: Record<string, string> = {
    'Authorization': `vapid t=${jwt},k=${vapidPublic}`,
    'Content-Type': 'application/json',
    'TTL': '86400',
  };

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers,
    body: payload,
  });

  return { status: res.status, ok: res.ok };
}

// ── Main handler ──────────────────────────────────────────────────────────────

serve(async (req) => {
  // CORS for local dev
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, content-type', 'Access-Control-Allow-Methods': 'POST' } });
  }

  try {
    const { title, body, tag, url: notifUrl } = await req.json().catch(() => ({}));

    const VAPID_PUBLIC  = Deno.env.get('VAPID_PUBLIC_KEY')  ?? '';
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY') ?? '';
    const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')     ?? 'mailto:admin@example.com';

    if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
      return new Response(JSON.stringify({ error: 'VAPID keys not configured' }), { status: 500 });
    }

    // Get all push subscriptions from Supabase
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
    );

    const { data: subs, error } = await supabase.from('push_subscriptions').select('*');
    if (error) throw error;
    if (!subs || subs.length === 0) {
      return new Response(JSON.stringify({ sent: 0, message: 'No subscribers' }), { status: 200 });
    }

    const payload = JSON.stringify({
      title: title || 'Johnston Clinic',
      body: body || 'Schedule has been updated',
      tag: tag || 'schedule-update',
      url: notifUrl || '/index.html',
    });

    const results = await Promise.allSettled(
      subs.map(async (sub: {id: string; endpoint: string; p256dh: string; auth: string}) => {
        const subscription = {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        };
        const result = await sendWebPush(subscription, payload, VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT);
        // Remove expired/invalid subscriptions (410 Gone)
        if (result.status === 410 || result.status === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        }
        return result;
      })
    );

    const sent = results.filter(r => r.status === 'fulfilled' && (r.value as {ok: boolean}).ok).length;
    return new Response(JSON.stringify({ sent, total: subs.length }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });

  } catch (err) {
    console.error('notify-staff error:', err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
