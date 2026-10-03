// Vercel Serverless Function — polled by index.html every 5 seconds.
//   GET /api/status              -> checks the portfolio's own reference number
//   GET /api/status?ref=txn_...  -> checks any PayContract reference number
// Returns { unlocked, status, ref, payUrl }. The page unlocks for EVERYONE
// as soon as the payment behind that reference number is PAID.
//
// The lookup goes to PayContract's public endpoint:
//   https://timetosignandpay.vercel.app/api/public/status?ref=...
//
// MANUAL OVERRIDES (used if the lookup below fails):
//   Option A (no code): Vercel dashboard -> Settings -> Environment Variables
//                       -> add PORTFOLIO_UNLOCKED = true  -> redeploy.
//   Option B (git):     set the fallback constant below to true and push.

const DEFAULT_REF = 'txn_edec5404a48bec95';
const PAY_BASE    = process.env.PAY_BASE || 'https://timetosignandpay.vercel.app';
const PAYMENT_STATUS_URL = process.env.PAY_STATUS_URL
  || 'https://timetosignandpay.vercel.app/api/public/status';

function pickRef(req) {
  const q = req.query && req.query.ref;
  const raw = Array.isArray(q) ? q[0] : q;
  if (raw) return String(raw);
  try {
    const u = new URL(req.url, 'http://localhost');
    const p = u.searchParams.get('ref');
    if (p) return p;
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

async function lookup(ref) {
  const url = `${PAYMENT_STATUS_URL}?ref=${encodeURIComponent(ref)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctrl.signal });
    if (!r.ok) return null;
    const d = await r.json();
    if (typeof d !== 'object' || d === null) return null;
    return {
      unlocked: d.unlocked === true || d.paid === true || d.status === 'PAID' || d.status === 'SIGNED',
      status: typeof d.status === 'string' ? d.status : (d.unlocked ? 'PAID' : 'UNKNOWN'),
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

  const ref = normalizeRef(pickRef(req));
  const payUrl = `${PAY_BASE}/pay/${encodeURIComponent(ref)}`;

  const envUnlock = process.env.PORTFOLIO_UNLOCKED === 'true';
  const constUnlock = false; // <-- change to true to force-unlock, then push
  if (envUnlock || constUnlock) {
    return res.status(200).json({ unlocked: true, status: 'PAID', ref, payUrl });
  }

  const d = await lookup(ref);
  if (d === null) {
    // payment service unreachable -> stay locked (safe default)
    return res.status(200).json({ unlocked: false, status: 'ERROR', ref, payUrl });
  }

  res.status(200).json({ unlocked: d.unlocked, status: d.status, ref, payUrl });
}
