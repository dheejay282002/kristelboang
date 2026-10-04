// Vercel Serverless Function — polled by index.html every 5 seconds.
//   GET /api/status              -> auto-check (defaults to the portfolio's own reference)
//   GET /api/status?ref=txn_...  -> checks any PayContract reference number
//   GET /api/status?email=a@b.c  -> checks every payment registered to that email
// Returns { unlocked, status, ref, payUrl }. The page unlocks for EVERYONE
// as soon as the payment behind the default reference is PAID, or for one
// visitor when the email they type matches a paid transaction.
//
// The lookup goes to PayContract's public endpoint:
//   https://timetosignandpay.vercel.app/api/public/status
//
// MANUAL OVERRIDES (used if the lookup below fails):
//   Option A (no code): Vercel dashboard -> Settings -> Environment Variables
//                       -> add PORTFOLIO_UNLOCKED = true  -> redeploy.
//   Option B (git):     set the fallback constant below to true and push.

const DEFAULT_REF = 'txn_edec5404a48bec95';
const PAY_BASE    = process.env.PAY_BASE || 'https://timetosignandpay.vercel.app';
const PAYMENT_STATUS_URL = process.env.PAY_STATUS_URL
  || 'https://timetosignandpay.vercel.app/api/public/status';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function pickParam(req, key) {
  const q = req.query && req.query[key];
  const raw = Array.isArray(q) ? q[0] : q;
  if (raw) return String(raw);
  try {
    const u = new URL(req.url, 'http://localhost');
    return u.searchParams.get(key) || '';
  } catch (e) { /* ignore */ }
  return '';
}

// accepts "txn_...", a bare hash, or a pasted payment link
function normalizeRef(value) {
  let v = String(value || '').trim().replace(/^.*\/pay\//, '');
  if (!v) return DEFAULT_REF;
  if (!/^txn_/i.test(v) && /^[0-9a-fA-F]{8,40}$/.test(v)) v = 'txn_' + v;
  return v;
}

async function lookup(query) {
  const url = `${PAYMENT_STATUS_URL}?${query}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    if (typeof d !== 'object' || d === null) return null;
    return {
      unlocked: d.unlocked === true,
      status: typeof d.status === 'string' ? d.status : 'UNKNOWN',
      paid: d.paid === true,
      expired: d.expired === true,
      expiresAt: typeof d.expiresAt === 'string' ? d.expiresAt : null,
      access: typeof d.access === 'string' ? d.access : 'auto',
      portfolio: d.portfolio === true,
      ref: typeof d.ref === 'string' ? d.ref : null,
    };
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const emailRaw = pickParam(req, 'email').trim();
  const email = EMAIL_RE.test(emailRaw) ? emailRaw : '';
  const ref = normalizeRef(pickParam(req, 'ref'));
  const query = email
    ? 'email=' + encodeURIComponent(email)
    : 'ref=' + encodeURIComponent(ref);

  const envUnlock = process.env.PORTFOLIO_UNLOCKED === 'true';
  const constUnlock = false; // <-- change to true to force-unlock, then push
  if (envUnlock || constUnlock) {
    return res.status(200).json({
      unlocked: true, status: 'PAID', paid: true, expired: false,
      expiresAt: null, access: 'unlocked', ref,
      payUrl: `${PAY_BASE}/pay/${encodeURIComponent(ref)}`,
    });
  }

  const d = await lookup(query);
  if (d === null) {
    // payment service unreachable -> stay locked (safe default)
    return res.status(200).json({
      unlocked: false, status: 'ERROR', paid: false, expired: false,
      expiresAt: null, access: 'auto', ref,
      payUrl: `${PAY_BASE}/pay/${encodeURIComponent(ref)}`,
    });
  }

  const finalRef = d.ref || ref;
  const { ref: _ignored, ...rest } = d;
  res.status(200).json({
    ...rest,
    ref: finalRef,
    payUrl: `${PAY_BASE}/pay/${encodeURIComponent(finalRef)}`,
  });
}
