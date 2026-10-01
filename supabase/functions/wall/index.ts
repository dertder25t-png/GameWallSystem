// GameWall cloud relay.
//
// The wall laptop never accepts incoming connections. It registers once, keeps one
// outgoing Supabase Realtime connection open, and listens on a secret "command topic".
// Phones pair with a short-lived 6-digit code shown on the laptop, get a controller
// token, and send commands here. This function checks the token, validates the
// command, signs it with the laptop's key (HMAC-SHA256) and broadcasts it on the
// laptop's command topic. The laptop drops anything unsigned, stale or replayed.
//
// All wall_* tables are service-role only (RLS on, no policies, no grants).

import { createClient } from 'npm:@supabase/supabase-js@2';

const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db = createClient(SB_URL, SB_KEY, { auth: { persistSession: false } });

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, apikey, authorization, x-client-info',
};

const MAX_BODY = 256 * 1024;
const CODE_TTL_MIN = 10;

// Every action the Display Host understands. Anything else is rejected here.
const ALLOWED_ACTIONS = new Set([
  'navigate', 'mute', 'volume', 'close', 'clear', 'closeAll', 'layout', 'test',
  'displays', 'monitor', 'hello', 'wallState', 'restoreSnapshot', 'applyWallState',
  'syncSlot', 'endSession', 'identify',
]);

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });

const enc = new TextEncoder();
const randomBytes = (n: number) => crypto.getRandomValues(new Uint8Array(n));
const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function sha256Hex(text: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return [...digest].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacB64(keyB64: string, message: string) {
  const key = await crypto.subtle.importKey('raw', fromB64(keyB64), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message))));
}

function sixDigitCode() {
  // Rejection sampling keeps the distribution uniform.
  const buf = new Uint32Array(1);
  let n = 0;
  do { crypto.getRandomValues(buf); n = buf[0]; } while (n >= 4294000000);
  return String(n % 1000000).padStart(6, '0');
}

const cleanName = (value: unknown, fallback: string) =>
  String(value ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || fallback;

function clientIp(req: Request) {
  return (req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || 'unknown').split(',')[0].trim();
}

async function rateLimit(bucket: string, max: number, windowSeconds: number) {
  const since = new Date(Date.now() - windowSeconds * 1000).toISOString();
  const { count, error } = await db.from('wall_rate_events')
    .select('id', { count: 'exact', head: true })
    .eq('bucket', bucket).gte('created_at', since);
  if (error) throw error;
  if ((count ?? 0) >= max) throw new HttpError(429, 'Too many attempts. Wait a few minutes and try again.');
  await db.from('wall_rate_events').insert({ bucket });
}

async function broadcast(topic: string, event: string, payload: unknown) {
  const res = await fetch(`${SB_URL}/realtime/v1/api/broadcast`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ topic, event, payload }] }),
  });
  if (!res.ok) throw new HttpError(502, `Realtime broadcast failed (${res.status})`);
}

type Device = {
  id: string; name: string; secret_hash: string; sign_key: string;
  command_topic: string; state_topic: string;
};

async function sendSigned(device: Device, command: Record<string, unknown>) {
  const c = JSON.stringify(command);
  const ts = Date.now();
  const n = b64url(randomBytes(12));
  const s = await hmacB64(device.sign_key, `${ts}.${n}.${c}`);
  await broadcast(device.command_topic, 'cmd', { c, ts, n, s });
}

async function loadDevice(deviceId: unknown): Promise<Device> {
  if (typeof deviceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(deviceId)) throw new HttpError(400, 'Bad device id');
  const { data, error } = await db.from('wall_devices')
    .select('id,name,secret_hash,sign_key,command_topic,state_topic').eq('id', deviceId).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(404, 'This laptop is not registered. Restart GameWall on the laptop.');
  return data as Device;
}

async function authDevice(body: Record<string, unknown>) {
  const device = await loadDevice(body.deviceId);
  if (typeof body.deviceSecret !== 'string' || !safeEqual(await sha256Hex(body.deviceSecret), device.secret_hash))
    throw new HttpError(401, 'Device secret does not match');
  await db.from('wall_devices').update({
    last_seen: new Date().toISOString(),
    ...(typeof body.version === 'string' ? { agent_version: body.version.slice(0, 32) } : {}),
  }).eq('id', device.id);
  return device;
}

async function authController(body: Record<string, unknown>) {
  const device = await loadDevice(body.deviceId);
  if (typeof body.token !== 'string' || body.token.length < 20) throw new HttpError(401, 'Not paired');
  const { data, error } = await db.from('wall_controllers')
    .select('id,name').eq('device_id', device.id).eq('token_hash', await sha256Hex(body.token)).maybeSingle();
  if (error) throw error;
  if (!data) throw new HttpError(401, 'This phone is no longer paired with that laptop. Pair again.');
  return { device, controller: data as { id: string; name: string } };
}

function checkUrl(url: unknown, field: string) {
  if (url == null || url === '') return;
  if (typeof url !== 'string' || url.length > 4096) throw new HttpError(400, `${field} is not a valid URL`);
  if (url === 'about:blank') return;
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new HttpError(400, `${field} is not a valid URL`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
    throw new HttpError(400, `${field} must be a web address (http or https)`);
}

export function validateCommand(cmd: unknown): Record<string, unknown> {
  if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) throw new HttpError(400, 'Command must be an object');
  const c = cmd as Record<string, unknown>;
  if (typeof c.action !== 'string' || !ALLOWED_ACTIONS.has(c.action)) throw new HttpError(400, 'Unknown action');
  if (c.slot != null && (!Number.isInteger(c.slot) || (c.slot as number) < 0 || (c.slot as number) > 7))
    throw new HttpError(400, 'Slot must be 0-7');
  checkUrl(c.url, 'url');
  const snapshot = c.snapshot as { slots?: unknown } | undefined;
  if (snapshot && Array.isArray(snapshot.slots)) {
    for (const s of snapshot.slots as Record<string, unknown>[]) {
      checkUrl(s?.url, 'snapshot url');
      checkUrl(s?.lastUrl, 'snapshot lastUrl');
    }
  }
  return c;
}

async function handle(req: Request, body: Record<string, unknown>) {
  const ip = clientIp(req);
  switch (body.op) {
    // ---- laptop ----
    case 'register': {
      await rateLimit(`register:${ip}`, 20, 3600);
      const secret = b64url(randomBytes(32));
      const row = {
        name: cleanName(body.name, 'GameWall laptop'),
        secret_hash: await sha256Hex(secret),
        sign_key: b64(randomBytes(32)),
        command_topic: `gw-cmd-${b64url(randomBytes(18))}`,
        state_topic: `gw-state-${b64url(randomBytes(18))}`,
        agent_version: typeof body.version === 'string' ? body.version.slice(0, 32) : null,
        last_seen: new Date().toISOString(),
      };
      const { data, error } = await db.from('wall_devices').insert(row).select('id').single();
      if (error) throw error;
      return {
        deviceId: data.id, deviceSecret: secret, signKey: row.sign_key,
        commandTopic: row.command_topic, stateTopic: row.state_topic, name: row.name,
      };
    }
    case 'code': {
      const device = await authDevice(body);
      await rateLimit(`code:${device.id}`, 30, 3600);
      await db.from('wall_pair_codes').delete().eq('device_id', device.id);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = sixDigitCode();
        const expiresAt = new Date(Date.now() + CODE_TTL_MIN * 60000).toISOString();
        const { error } = await db.from('wall_pair_codes').insert({ code, device_id: device.id, expires_at: expiresAt });
        if (!error) return { code, expiresAt };
        if (error.code !== '23505') throw error; // retry only on a code collision
      }
      throw new HttpError(503, 'Could not create a pairing code, try again');
    }
    case 'device_info': {
      const device = await authDevice(body);
      const { data } = await db.from('wall_controllers').select('name,created_at,last_used').eq('device_id', device.id).order('created_at');
      return { name: device.name, phones: data ?? [] };
    }
    case 'rename_device': {
      const device = await authDevice(body);
      const name = cleanName(body.name, device.name);
      await db.from('wall_devices').update({ name }).eq('id', device.id);
      return { name };
    }
    case 'forget_phones': {
      const device = await authDevice(body);
      await db.from('wall_controllers').delete().eq('device_id', device.id);
      await db.from('wall_pair_codes').delete().eq('device_id', device.id);
      return { ok: true };
    }

    // ---- phone ----
    case 'claim': {
      await rateLimit(`claim:${ip}`, 10, 600);
      const code = String(body.code ?? '').replace(/\D/g, '');
      if (code.length !== 6) throw new HttpError(400, 'Enter the 6-digit code shown on the laptop');
      const { data: pc, error } = await db.from('wall_pair_codes')
        .select('code,device_id,expires_at').eq('code', code).maybeSingle();
      if (error) throw error;
      if (!pc || new Date(pc.expires_at).getTime() < Date.now())
        throw new HttpError(404, 'That code is wrong or has expired. Check the laptop for a new one.');
      await db.from('wall_pair_codes').delete().eq('code', code);
      const device = await loadDevice(pc.device_id);
      const token = b64url(randomBytes(32));
      const name = cleanName(body.name, 'Phone');
      const { data: ctrl, error: insErr } = await db.from('wall_controllers')
        .insert({ device_id: device.id, token_hash: await sha256Hex(token), name }).select('id').single();
      if (insErr) throw insErr;
      await sendSigned(device, { action: 'paired', name }).catch(() => {});
      return { deviceId: device.id, deviceName: device.name, token, stateTopic: device.state_topic, controllerId: ctrl.id };
    }
    case 'command': {
      const cmd = validateCommand(body.command);
      const { device, controller } = await authController(body);
      await sendSigned(device, { ...cmd, from: controller.name });
      await db.from('wall_controllers').update({ last_used: new Date().toISOString() }).eq('id', controller.id);
      if (cmd.action !== 'hello' && cmd.action !== 'wallState' && cmd.action !== 'displays')
        await db.from('wall_command_log').insert({ device_id: device.id, controller_id: controller.id, action: cmd.action });
      return { ok: true };
    }
    case 'status': {
      const { device } = await authController(body);
      const { data } = await db.from('wall_devices').select('name,last_seen,agent_version').eq('id', device.id).single();
      return { deviceName: data?.name, lastSeen: data?.last_seen, agentVersion: data?.agent_version, stateTopic: device.state_topic };
    }
    case 'unpair': {
      const { controller } = await authController(body);
      await db.from('wall_controllers').delete().eq('id', controller.id);
      return { ok: true };
    }
    default:
      throw new HttpError(400, 'Unknown op');
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, 'Request too large');
    let body: Record<string, unknown>;
    try { body = JSON.parse(text); } catch { throw new HttpError(400, 'Body must be JSON'); }
    return json(await handle(req, body));
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.log('wall error', String((e as Error)?.message ?? e));
    return json({ error: 'Server error' }, 500);
  }
});
