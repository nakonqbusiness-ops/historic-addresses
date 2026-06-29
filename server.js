require('dotenv').config();
const express  = require('express');
const sqlite3  = require('sqlite3').verbose();
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const os       = require('os');
const multer   = require('multer');
const sharp    = require('sharp');
const crypto   = require('crypto');
const bcrypt       = require('bcrypt');
const jwt          = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const compression  = require('compression');
const opentype     = require('opentype.js');
const { Resend }   = require('resend');
const { google }   = require('googleapis');
const { authenticator } = require('otplib');
const QRCode       = require('qrcode');
const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT      = process.env.PORT || 10000;
const DOMAIN    = 'https://historyaddress.bg';
const RAM_MB    = Math.round(os.totalmem() / 1024 / 1024);
const LOW_SPEC  = RAM_MB < 1024;            // tune for 512 MB Railway instances

// Database path resolution
const DB_FILE = (() => {
    const candidates = [
        process.env.DATABASE_URL,
        '/data/database.db',
        path.join(__dirname, 'database.db'),
    ].filter(Boolean);
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return path.join(__dirname, 'database.db'); // fallback (will be created)
})();

console.log(`\n🚀 HistoryAddress starting…`);
console.log(`📦 DB: ${DB_FILE}  |  RAM: ${RAM_MB} MB  |  Mode: ${LOW_SPEC ? 'LEAN' : 'PERFORMANCE'}`);

// ─── In-memory API cache ──────────────────────────────────────────────────────

const cache = {
    _store: new Map(),
    _max:   LOW_SPEC ? 50 : 200,

    get(key) {
        const item = this._store.get(key);
        if (!item) return null;
        if (Date.now() > item.exp) { this._store.delete(key); return null; }
        return item.val;
    },

    set(key, val, ttlSecs = 60) {
        // Evict oldest 25 % when full
        if (this._store.size >= this._max) {
            let cut = Math.ceil(this._max * 0.25);
            for (const k of this._store.keys()) {
                if (--cut < 0) break;  // eslint-disable-line no-plusplus
                this._store.delete(k);
            }
        }
        this._store.set(key, { val, exp: Date.now() + ttlSecs * 1000 });
    },

    clear() { this._store.clear(); },
    stats() { return { size: this._store.size, max: this._max }; },
};

// ─── R2 / upload setup ───────────────────────────────────────────────────────

const r2 = new S3Client({
    region:   'auto',
    endpoint: 'https://ae436e2433a501e9b779b8993e95d5b1.r2.cloudflarestorage.com',
    credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_KEY,
    },
});
const R2_BUCKET     = 'history-address-images';
const R2_PUBLIC_URL = 'https://pub-b40e453eddaf4bc5b299af8f6d7b7de2.r2.dev';

const upload = multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 20 * 1024 * 1024 },
    fileFilter: (_req, file, cb) =>
        file.mimetype.startsWith('image/')
            ? cb(null, true)
            : cb(new Error('Only images are allowed'), false),
});

// Hardened uploader for crowdsourced photos: max 10 MB each, up to MAX_PHOTOS,
// images only. Returns clean Bulgarian JSON on any upload error so a malformed
// request can never crash or hang the route.
const MAX_PHOTOS = 6;
const suggestUpload = multer({
    storage:    multer.memoryStorage(),
    limits:     { fileSize: 10 * 1024 * 1024, files: MAX_PHOTOS },
    fileFilter: (_req, file, cb) =>
        file.mimetype.startsWith('image/')
            ? cb(null, true)
            : cb(new Error('NOT_IMAGE'), false),
});
function acceptPhotos(field) {
    const mw = suggestUpload.array(field, MAX_PHOTOS);
    return (req, res, next) => mw(req, res, (err) => {
        if (!err) return next();
        if (err.code === 'LIMIT_FILE_SIZE')  return res.status(400).json({ error: 'Снимката е твърде голяма (макс. 10 MB).' });
        if (err.code === 'LIMIT_FILE_COUNT')  return res.status(400).json({ error: 'Твърде много снимки (макс. ' + MAX_PHOTOS + ').' });
        if (err.code === 'LIMIT_UNEXPECTED_FILE') return res.status(400).json({ error: 'Твърде много снимки (макс. ' + MAX_PHOTOS + ').' });
        return res.status(400).json({ error: 'Невалиден файл - качете изображение (JPG/PNG).' });
    });
}

// Validate the actual file bytes (magic numbers) - never trust the client's
// Content-Type. Rejects .html/.js/.svg/PDF/etc. dressed up as image/jpeg.
function looksLikeImage(buf) {
    if (!buf || buf.length < 12) return false;
    const h = buf.subarray(0, 12);
    const hex = h.toString('hex').toLowerCase();
    if (hex.startsWith('ffd8ff')) return true;                          // JPEG
    if (hex.startsWith('89504e470d0a1a0a')) return true;                // PNG
    if (hex.startsWith('474946383')) return true;                       // GIF87a/89a
    if (h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WEBP') return true; // WebP
    return false;
}
// sharp options that cap pixel count → blocks decompression "bombs".
const SHARP_OPTS = { limitInputPixels: 50_000_000, failOn: 'truncated' };

// Process one image buffer → {full, thumb} JPEG buffers. Throws on a non-image.
async function processPhoto(buf) {
    if (!looksLikeImage(buf)) throw new Error('NOT_IMAGE');
    const full  = await sharp(buf, SHARP_OPTS).rotate().resize({ width: 2000, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    const thumb = await sharp(full).resize({ width: 600, withoutEnlargement: true }).jpeg({ quality: 70 }).toBuffer();
    return { full, thumb };
}
// Upload a processed photo to R2 under a key prefix; returns its public URL.
async function uploadPhotoToR2(buf, keyBase) {
    const fullKey  = keyBase + '.jpg';
    const thumbKey = keyBase + '_thumb.jpg';
    const { full, thumb } = await processPhoto(buf);
    await Promise.all([
        r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: fullKey,  Body: full,  ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000' })),
        r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: thumbKey, Body: thumb, ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000' })),
    ]);
    return `${R2_PUBLIC_URL}/${fullKey}`;
}

// ─── Google Drive service (read-only, service-account auth) ──────────────────────
// Auth uses a service account whose JSON key is supplied via the GOOGLE_SERVICE_
// ACCOUNT_JSON env var. The target folder must be shared with the service account's
// email (no public link sharing required). Created lazily on first use.
let _driveClient = null;
function getDriveClient() {
    if (_driveClient) return _driveClient;
    const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (!raw) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_NOT_SET');
    let creds;
    try { creds = JSON.parse(raw); } catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON_INVALID'); }
    const auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    _driveClient = google.drive({ version: 'v3', auth });
    return _driveClient;
}
// Extract the folder ID from any common Drive URL shape (or a pasted bare ID).
function parseDriveFolderId(url) {
    const s = String(url || '').trim();
    let m = s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);     // …/folders/<id>
    if (m) return m[1];
    m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/);             // …?id=<id>
    if (m) return m[1];
    if (/^[a-zA-Z0-9_-]{15,}$/.test(s)) return s;           // bare id pasted
    return null;
}
// List every image in a folder (paginated; works with Shared Drives too).
async function listDriveImages(folderId) {
    const drive = getDriveClient();
    const files = [];
    let pageToken;
    do {
        const resp = await drive.files.list({
            q: `'${folderId}' in parents and mimeType contains 'image/' and trashed = false`,
            fields: 'nextPageToken, files(id, name, mimeType)',
            pageSize: 200,
            pageToken,
            orderBy: 'name_natural',
            supportsAllDrives: true,
            includeItemsFromAllDrives: true,
        });
        files.push(...(resp.data.files || []));
        pageToken = resp.data.nextPageToken;
    } while (pageToken && files.length < 1000);
    return files;
}
// Stream one file's bytes into memory as a Buffer.
async function downloadDriveFile(fileId) {
    const drive = getDriveClient();
    const resp = await drive.files.get(
        { fileId, alt: 'media', supportsAllDrives: true },
        { responseType: 'arraybuffer' }
    );
    return Buffer.from(resp.data);
}

// Smart, dynamic watermark. Font size scales with image width (~2.7%), white text
// with a crisp dark outline AND a soft blurred drop-shadow so it stays legible on
// ANY background (sky, white walls, dark scenes). Placed bottom-left with a 2% inset,
// orientation-aware, and auto-shrunk so it never runs off the edge.
//   creator present → "© <name> via Адресът на историята"
//   creator absent  → "© Адресът на историята"
// Watermark font, loaded ONCE and converted to vector paths at render time. We render
// the text as SVG <path> outlines (not <text>) so it never depends on a system font -
// otherwise Cyrillic shows as "tofu" boxes on minimal Linux containers (Railway).
const WM_FONT = (() => {
    try {
        const fb = fs.readFileSync(path.join(__dirname, 'assets', 'fonts', 'NotoSans-Bold.ttf'));
        return opentype.parse(fb.buffer.slice(fb.byteOffset, fb.byteOffset + fb.byteLength));
    } catch (e) {
        console.error('⚠️  watermark font failed to load - watermarks disabled:', e.message);
        return null;
    }
})();

// ── Watermark configurator ────────────────────────────────────────────────────
// Admin-editable text / size / opacity / position. Defaults reproduce the previous
// hardcoded look exactly (so existing watermarks are unchanged until edited).
const WM_DEFAULTS = { text: '© {name} via Адресът на историята', font_pct: 2.85, opacity: 1, gravity: 'bottom-left' };
const WM_GRAVITIES = ['bottom-left', 'bottom-center', 'bottom-right', 'top-left', 'top-center', 'top-right', 'center'];
let wmSettingsCache = null;   // in-memory; refreshed on save so Drive sync stays fast

function normalizeWmSettings(s) {
    s = s || {};
    const text = (typeof s.text === 'string' && s.text.trim()) ? s.text.trim().slice(0, 120) : WM_DEFAULTS.text;
    let font_pct = parseFloat(s.font_pct); if (!isFinite(font_pct)) font_pct = WM_DEFAULTS.font_pct;
    font_pct = Math.min(10, Math.max(1, font_pct));
    let opacity = parseFloat(s.opacity); if (!isFinite(opacity)) opacity = WM_DEFAULTS.opacity;
    opacity = Math.min(1, Math.max(0.1, opacity));
    const gravity = WM_GRAVITIES.includes(s.gravity) ? s.gravity : WM_DEFAULTS.gravity;
    return { text, font_pct, opacity, gravity };
}
async function getWatermarkSettings() {
    if (wmSettingsCache) return wmSettingsCache;
    let raw = {};
    try { const row = await dbGet("SELECT value FROM settings WHERE key='watermark'"); if (row && row.value) raw = JSON.parse(row.value); } catch {}
    wmSettingsCache = normalizeWmSettings(raw);
    return wmSettingsCache;
}
// Build the watermark string. {name} → the photographer/creator; with no creator we
// drop the "{name} via" credit and keep just the brand. Text is rendered to vector
// glyph paths (never injected as raw SVG markup), so it can't break the SVG.
function renderWmText(template, creator) {
    const c = (creator && String(creator).trim().slice(0, 80)) || '';
    if (c) return template.replace(/\{name\}/g, c);
    return template.replace(/\{name\}\s*(via\s+)?/gi, '').replace(/\s{2,}/g, ' ').trim() || '© Адресът на историята';
}

async function buildWatermark(buf, creator, cfgOverride) {
    if (!looksLikeImage(buf)) throw new Error('NOT_IMAGE');

    // Honour EXIF orientation up front so width/height are the *displayed* dims.
    const baseBuf = await sharp(buf, SHARP_OPTS).rotate().toBuffer();
    const img  = sharp(baseBuf);
    const meta = await img.metadata();
    const w = meta.width || 1200;
    const h = meta.height || 900;

    // If the font couldn't load, return the (resized) image un-watermarked rather than
    // crash or draw tofu boxes.
    if (!WM_FONT) return img.jpeg({ quality: 88 }).toBuffer();

    const cfg  = cfgOverride ? normalizeWmSettings(cfgOverride) : await getWatermarkSettings();
    const text = renderWmText(cfg.text, creator);
    const op   = cfg.opacity;

    // Font size scales with width (% from settings). A minimal ~1.2% edge inset.
    const marginX = Math.max(2, Math.round(w * 0.012));
    const marginY = Math.max(2, Math.round(h * 0.012));
    let fontSize  = Math.max(16, Math.round(w * cfg.font_pct / 100));
    const maxTextW = w - marginX * 2;
    // Exact width from real font metrics → shrink to fit if the text is long.
    let textW = WM_FONT.getAdvanceWidth(text, fontSize);
    if (textW > maxTextW) { fontSize = Math.max(11, Math.floor(fontSize * maxTextW / textW)); textW = WM_FONT.getAdvanceWidth(text, fontSize); }

    const stroke  = Math.max(1.4, fontSize * 0.07);        // crisp dark outline
    const blurPx  = Math.max(1, fontSize * 0.10);          // soft shadow blur radius
    const inset   = Math.ceil(stroke + blurPx + 2);        // canvas padding for stroke/shadow
    const canvasW = Math.ceil(textW + inset * 2);
    const canvasH = Math.ceil(fontSize * 1.5 + inset * 2);
    const baseY   = Math.round(inset + fontSize);          // text baseline
    const pathData = WM_FONT.getPath(text, inset, baseY, fontSize).toPathData(2);

    // Soft drop-shadow: the same outline in black, blurred with sharp, behind the text.
    const shadowSvg =
        `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
        `<path d="${pathData}" fill="rgba(0,0,0,${op})"/></svg>`;
    const shadowBuf = await sharp(Buffer.from(shadowSvg)).blur(blurPx).png().toBuffer();

    // Foreground: grey fill + thin dark stroke painted behind the fill (paint-order).
    // Opacity multiplies every layer's alpha so the whole mark fades as one.
    const textSvg =
        `<svg width="${canvasW}" height="${canvasH}" xmlns="http://www.w3.org/2000/svg">` +
        `<path d="${pathData}" paint-order="stroke" stroke="rgba(0,0,0,${(0.85 * op).toFixed(3)})" ` +
        `stroke-width="${stroke.toFixed(2)}" stroke-linejoin="round" fill="rgba(215,213,213,${op})"/></svg>`;

    // Position the text per the configured gravity. The path is drawn at x=inset inside
    // the canvas; composite-left/top place that canvas on the image.
    const vert  = cfg.gravity.indexOf('top') >= 0 ? 'top' : cfg.gravity.indexOf('bottom') >= 0 ? 'bottom' : 'center';
    const horiz = cfg.gravity.indexOf('left') >= 0 ? 'left' : cfg.gravity.indexOf('right') >= 0 ? 'right' : 'center';
    let left = horiz === 'left'  ? (marginX - inset)
             : horiz === 'right' ? (w - marginX - textW - inset)
             : Math.round((w - textW) / 2) - inset;
    let top  = vert === 'bottom' ? Math.round(h - marginY - inset - fontSize * 1.18)
             : vert === 'top'    ? Math.round(marginY - inset + fontSize * 0.12)
             : Math.round(h / 2 - inset - fontSize * 0.68);
    left = Math.round(Math.max(0, Math.min(left, Math.max(0, w - canvasW))));   // sharp needs integers
    top  = Math.round(Math.max(0, Math.min(top,  Math.max(0, h - canvasH))));
    const shOff = Math.max(1, Math.round(fontSize * 0.04));

    return img
        .composite([
            { input: shadowBuf,            left: left + shOff, top: top + shOff },
            { input: Buffer.from(textSvg), left: left,         top: top },
        ])
        .jpeg({ quality: 88 })
        .toBuffer();
}

function randomSuffix(n = 6) { return Math.random().toString(36).substring(2, 2 + n); }

// ─── Hashing helper ────────────────────────────────────────────────────────────
// NB: the legacy hardcoded-password admin auth (ADMIN_ACCOUNTS + X-Admin-Token HMAC)
// was removed 2026-06-25. All content management now runs on the user-account RBAC
// (requireRole) — see the OWNER/ADMIN dashboard. sha256hex stays: it is used by the
// email-verification, password-reset and 2FA-backup-code flows.
const sha256hex = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ─── User accounts (public profiles + RBAC) ─────────────────────────────────────
// Separate from the admin token above: these are end-user logins using a JWT
// delivered in an HttpOnly cookie (never exposed to JavaScript / localStorage).
const JWT_SECRET    = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) {
    console.warn('⚠️  JWT_SECRET not set - using a random per-boot secret. Set it in env so user logins survive restarts.');
}
const JWT_EXPIRES   = '7d';
const AUTH_COOKIE   = 'auth_token';
const BCRYPT_ROUNDS = 12;
// Secure cookies require HTTPS. Railway injects RAILWAY_* env vars in production;
// locally (http://localhost) we must NOT set Secure or the cookie is dropped.
const COOKIE_SECURE = !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_PROJECT_ID || process.env.NODE_ENV === 'production');
const COOKIE_OPTS   = {
    httpOnly: true,          // not readable by JS → mitigates XSS token theft
    sameSite: 'strict',      // not sent on cross-site requests → mitigates CSRF
    secure:   COOKIE_SECURE, // HTTPS-only in production
    path:     '/',
    maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days, matches JWT_EXPIRES
};
// Constant-time dummy compare target, so a missing email takes ~the same time as
// a wrong password (mitigates user-enumeration via timing).
const DUMMY_HASH = bcrypt.hashSync('unused-placeholder-password', BCRYPT_ROUNDS);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function validEmail(e) { return typeof e === 'string' && e.length <= 254 && EMAIL_RE.test(e); }

// Known throwaway / 10-minute-mail providers. Registration with one of these is
// rejected so accounts map to a reachable inbox. Exact host (or parent-domain)
// match only, so we never false-positive a legitimate address.
const DISPOSABLE_EMAIL_DOMAINS = new Set([
    'mailinator.com','guerrillamail.com','guerrillamail.info','guerrillamail.net','guerrillamail.org',
    'guerrillamail.biz','sharklasers.com','grr.la','spam4.me','pokemail.net','10minutemail.com',
    '10minutemail.net','temp-mail.org','tempmail.com','tempmailo.com','tempmail.net','tempmail.dev',
    'tempr.email','tmpmail.org','tmpmail.net','throwawaymail.com','getnada.com','nada.email','trashmail.com',
    'trashmail.de','trash-mail.com','yopmail.com','yopmail.net','yopmail.fr','maildrop.cc','mailnesia.com',
    'dispostable.com','fakeinbox.com','mintemail.com','mohmal.com','emailondeck.com','mailcatch.com',
    'spamgourmet.com','mvrht.net','33mail.com','anonbox.net','discard.email','discardmail.com','mailtemp.info',
    'fakemail.net','tempinbox.com','easytrashmail.com','jetable.org','mytemp.email','luxusmail.org',
    'getairmail.com','inboxkitten.com','burnermail.io','emailfake.com','mailpoof.com','moakt.com','linshiyou.com',
    'cs.email','mail-temp.com','tempemail.co','minuteinbox.com','mailto.plus','dropmail.me','1secmail.com',
    '1secmail.org','1secmail.net','vjuum.com','laafd.com','txcct.com','rteml.com','dpptd.com','xojxe.com',
]);
function isDisposableEmail(email) {
    const at = String(email || '').lastIndexOf('@');
    if (at < 0) return false;
    const host = email.slice(at + 1).toLowerCase();
    if (DISPOSABLE_EMAIL_DOMAINS.has(host)) return true;
    // also catch sub-addressed hosts like foo.mailinator.com
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
        if (DISPOSABLE_EMAIL_DOMAINS.has(parts.slice(i).join('.'))) return true;
    }
    return false;
}
function passwordIssue(p) {
    if (typeof p !== 'string' || p.length < 8) return 'Password must be at least 8 characters';
    if (p.length > 200) return 'Password is too long';
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain both letters and numbers';
    return null;
}

// ─── Email (Resend) ──────────────────────────────────────────────────────────
// Configured only if RESEND_API_KEY is present; otherwise email is skipped so the
// app still runs locally / before the key is set. EMAIL_FROM must use a domain you
// have verified in Resend (the sandbox 'onboarding@resend.dev' only delivers to the
// Resend account owner's address).
const resend    = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'Адресът на историята <onboarding@resend.dev>';

async function sendEmail({ to, subject, html }) {
    if (!resend) { console.warn('✉️  RESEND_API_KEY not set - skipping email to', to); return false; }
    try {
        const { error } = await resend.emails.send({ from: EMAIL_FROM, to, subject, html });
        if (error) { console.error('Resend error:', error.message || JSON.stringify(error)); return false; }
        return true;
    } catch (e) {
        console.error('Email send failed:', e.message);
        return false;
    }
}

// Shared, email-client-safe HTML shell (inline styles, table layout, light theme).
function emailLayout(bodyHtml, preheader = '') {
    return `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ece5d8;font-family:'Mulish',Segoe UI,Arial,sans-serif;color:#3a2f1f;-webkit-font-smoothing:antialiased;">
<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;overflow:hidden;mso-hide:all;">${preheader}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ece5d8;padding:28px 12px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fffaf0;border-radius:16px;overflow:hidden;border:1px solid #e6d9c2;">
      <tr><td style="background:#cd853f;background:linear-gradient(135deg,#cd853f,#daa520);padding:28px 32px;text-align:center;">
        <div style="font-family:Georgia,'Times New Roman',serif;font-size:23px;font-weight:700;color:#fffaf0;">Адресът на историята</div>
        <div style="font-size:11px;color:rgba(255,250,240,0.9);letter-spacing:2px;text-transform:uppercase;margin-top:5px;">Историята на всеки адрес</div>
      </td></tr>
      <tr><td style="padding:34px 32px 8px;">${bodyHtml}</td></tr>
      <tr><td style="padding:18px 32px 30px;border-top:1px solid #efe5d2;">
        <p style="margin:0;font-size:12px;color:#8b7355;line-height:1.6;text-align:center;">
          © ${new Date().getFullYear()} Адресът на историята · <a href="${DOMAIN}" style="color:#cd853f;text-decoration:none;">historyaddress.bg</a>
        </p>
      </td></tr>
    </table>
  </td></tr>
</table></body></html>`;
}
function emailButton(href, label) {
    return `<table role="presentation" cellpadding="0" cellspacing="0" align="center" style="margin:26px auto;">
      <tr><td align="center" style="border-radius:30px;background:#cd853f;background:linear-gradient(135deg,#cd853f,#daa520);">
        <a href="${href}" style="display:inline-block;padding:14px 36px;font-family:'Mulish',Arial,sans-serif;font-size:16px;font-weight:700;color:#fffaf0;text-decoration:none;border-radius:30px;">${label}</a>
      </td></tr></table>`;
}
function welcomeEmailHtml() {
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:26px;font-weight:700;color:#3a2f1f;">Добре дошли! 🏛️</h1>
       <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Радваме се, че се присъединихте към <strong style="color:#cd853f;">Адресът на историята</strong> - мястото, където оживява историята на сгради, личности и събития от България.</p>
       <p style="margin:0 0 8px;font-size:15px;line-height:1.7;color:#5a4a33;">Ето какво можете да правите вече:</p>
       <ul style="margin:0 0 6px;padding-left:20px;font-size:15px;line-height:1.85;color:#5a4a33;">
         <li>❤️ Запазвайте любими места</li>
         <li>📍 Отбелязвайте посетени адреси</li>
         <li>📸 Предлагайте нови исторически локации</li>
       </ul>
       ${emailButton(DOMAIN + '/addresses.html', 'Разгледай адресите')}
       <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Благодарим Ви, че пазите историята жива.</p>`;
    return emailLayout(body, 'Добре дошли в Адресът на историята!');
}
function verifyEmailHtml(link) {
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:25px;font-weight:700;color:#3a2f1f;">Потвърдете имейла си 📨</h1>
       <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Благодарим Ви, че се регистрирахте в <strong style="color:#cd853f;">Адресът на историята</strong>! Остава само да потвърдите имейл адреса си, за да активирате напълно профила си (включително да предлагате нови локации).</p>
       ${emailButton(link, 'Потвърди имейла')}
       <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Ако бутонът не работи, копирайте този адрес в браузъра си:<br><a href="${link}" style="color:#cd853f;word-break:break-all;">${link}</a></p>
       <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Връзката е валидна <strong>24 часа</strong>. Ако не сте се регистрирали, просто игнорирайте този имейл.</p>`;
    return emailLayout(body, 'Потвърдете имейла си, за да активирате профила');
}
function resetEmailHtml(link) {
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:24px;font-weight:700;color:#3a2f1f;">Нулиране на паролата</h1>
       <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Получихме заявка за нулиране на паролата за Вашия профил. Натиснете бутона по-долу, за да зададете нова парола. Връзката е валидна <strong>1 час</strong>.</p>
       ${emailButton(link, 'Нулирай паролата')}
       <p style="margin:8px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Ако бутонът не работи, копирайте този адрес в браузъра си:<br><a href="${link}" style="color:#cd853f;word-break:break-all;">${link}</a></p>
       <p style="margin:16px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Ако не сте поискали това, просто игнорирайте имейла - паролата Ви няма да бъде променена.</p>`;
    return emailLayout(body, 'Връзка за нулиране на паролата (валидна 1 час)');
}
function approvalEmailHtml(placeTitle, link) {
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:25px;font-weight:700;color:#3a2f1f;">Одобрено! 🎉</h1>
       <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Поздравления! Вашият адрес <strong style="color:#cd853f;">„${escHtml(placeTitle)}"</strong> е одобрен и вече е на картата! Благодарим Ви, че помагате да опазим българската история!</p>
       ${emailButton(link, 'Вижте го на сайта')}
       <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Можете да предложите още локации по всяко време.</p>`;
    return emailLayout(body, 'Вашият адрес е одобрен и вече е на картата!');
}
// TRIGGER 1: sent the moment a place is submitted (registered users and guests).
function submissionReceivedEmailHtml(placeTitle) {
    const titleLine = placeTitle
        ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Получихме предложението Ви <strong style="color:#cd853f;">„${escHtml(placeTitle)}"</strong>.</p>` : '';
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:25px;font-weight:700;color:#3a2f1f;">Благодарим Ви! 📨</h1>
       <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Благодарим ви, вашето предложение за адрес бе изпратено за модерация!</p>
       ${titleLine}
       <p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">Нашият екип ще го прегледа и ще Ви уведомим по имейл за решението. 🏛️</p>
       <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Ако нямате профил, можете да си създадете - предложенията, направени с този имейл, ще се появят автоматично в него.</p>`;
    return emailLayout(body, 'Получихме Вашето предложение за адрес');
}
// TRIGGER 3: sent when a moderator returns a submission for correction, with their note.
function correctionEmailHtml(placeTitle, note) {
    const noteBox = note
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="background:#fbf3e3;border-left:4px solid #cd853f;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;color:#5a4a33;"><strong style="color:#3a2f1f;">Бележка от администратора:</strong><br>${escHtml(note)}</td></tr></table>` : '';
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:24px;font-weight:700;color:#3a2f1f;">Нужна е корекция ✍️</h1>
       <p style="margin:0 0 6px;font-size:15px;line-height:1.7;color:#5a4a33;">Вашето предложение${placeTitle ? ` <strong style="color:#cd853f;">„${escHtml(placeTitle)}"</strong>` : ''} се нуждае от корекция. Бележка от администратора: ${note ? escHtml(note) : '(няма допълнителна бележка)'}</p>
       ${noteBox}
       ${emailButton(DOMAIN + '/profile.html#activity', 'Редактирай предложението')}
       <p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:#8b7355;">Коригирайте предложението от профила си и го изпратете отново за преглед. Ако сте гост, създайте профил със същия имейл, за да го редактирате.</p>`;
    return emailLayout(body, 'Вашето предложение се нуждае от корекция');
}
// TRIGGER 4: sent when a moderator rejects a submission outright, with their reason.
function rejectionEmailHtml(placeTitle, reason) {
    const reasonBox = reason
        ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="background:#f7eaea;border-left:4px solid #c95050;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;color:#5a4a33;"><strong style="color:#3a2f1f;">Причина:</strong><br>${escHtml(reason)}</td></tr></table>` : '';
    const body =
      `<h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:24px;font-weight:700;color:#3a2f1f;">Относно Вашето предложение</h1>
       <p style="margin:0 0 6px;font-size:15px;line-height:1.7;color:#5a4a33;">За съжаление предложението ви${placeTitle ? ` <strong style="color:#cd853f;">„${escHtml(placeTitle)}"</strong>` : ''} бе отхвърлено. Причина: ${reason ? escHtml(reason) : '(няма посочена причина)'}</p>
       ${reasonBox}
       <p style="margin:14px 0 0;font-size:14px;line-height:1.7;color:#5a4a33;">Благодарим Ви, че се включихте. Винаги сте добре дошли да предложите друга локация.</p>
       ${emailButton(DOMAIN + '/suggest.html', 'Предложи друга локация')}`;
    return emailLayout(body, 'Относно Вашето предложение за адрес');
}

// Module-level HTML escaper for values dropped into email templates.
function escHtml(s) {
    return String(s == null ? '' : s).replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c]));
}

// One-click unsubscribe token (no login needed, but can't unsubscribe someone else).
function unsubToken(userId) {
    return crypto.createHmac('sha256', JWT_SECRET).update('unsub:' + userId).digest('hex').slice(0, 32);
}
function unsubLink(userId) {
    return `${DOMAIN}/api/newsletter/unsubscribe?u=${encodeURIComponent(userId)}&t=${unsubToken(userId)}`;
}
function newsletterEmailHtml(article, unsub) {
    const href = article.link || `${DOMAIN}/news-article.html?slug=${encodeURIComponent(article.slug)}`;
    const cover = isHttpUrl(article.cover_image)
        ? `<img src="${article.cover_image}" alt="" width="100%" style="display:block;border-radius:12px;margin:0 0 18px;max-width:100%;height:auto;">` : '';
    const body =
      `<p style="margin:0 0 6px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#cd853f;">Нова новина</p>
       <h1 style="margin:0 0 14px;font-family:Georgia,serif;font-size:24px;font-weight:700;color:#3a2f1f;">${escHtml(article.title)}</h1>
       ${cover}
       ${article.excerpt ? `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#5a4a33;">${escHtml(article.excerpt)}</p>` : ''}
       ${emailButton(href, 'Прочети повече')}`;
    const footer =
      `<p style="margin:18px 0 0;font-size:12px;line-height:1.6;color:#8b7355;text-align:center;">
         Получавате този имейл, защото се абонирахте за новини. <a href="${unsub}" style="color:#cd853f;">Отписване</a>.
       </p>`;
    return emailLayout(body + footer, article.excerpt || ('Нова новина: ' + article.title));
}
// Email all opt-in subscribers about a freshly published article. Sequential with a
// tiny gap to stay friendly to Resend's rate limits; each gets a personal unsub link.
async function sendNewsletter(article) {
    if (!resend) { console.warn('✉️  newsletter skipped - RESEND_API_KEY not set'); return; }
    let subs = [];
    try { subs = await dbAll('SELECT id,email FROM users WHERE newsletter=1'); } catch (e) { return; }
    if (!subs.length) return;
    console.log(`✉️  sending newsletter "${article.title}" to ${subs.length} subscriber(s)`);
    for (const u of subs) {
        await sendEmail({
            to: u.email,
            subject: 'Нова новина - ' + article.title,
            html: newsletterEmailHtml(article, unsubLink(u.id)),
        });
        await new Promise(r => setTimeout(r, 120));   // ~8/sec, well under limits
    }
}

function issueAuthCookie(res, user) {
    const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
    res.cookie(AUTH_COOKIE, token, COOKIE_OPTS);
}

// Verify the JWT cookie on protected routes; attaches req.user = { sub, role }.
function requireUser(req, res, next) {
    const token = req.cookies && req.cookies[AUTH_COOKIE];
    if (!token) return res.status(401).json({ error: 'Not authenticated' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired session' });
    }
}
// Email-verification gate for write actions. Chain AFTER requireUser. Reads the live
// flag from the DB (the JWT predates verification, so we can't trust a claim).
function requireVerified(req, res, next) {
    dbGet('SELECT email_verified FROM users WHERE id=?', [req.user.sub])
        .then(u => {
            if (!u) return res.status(401).json({ error: 'Not authenticated' });
            if (u.email_verified !== 1) {
                return res.status(403).json({ error: 'EMAIL_NOT_VERIFIED', message: 'Моля, потвърдете имейл адреса си, за да използвате тази функция.' });
            }
            next();
        })
        .catch(() => res.status(500).json({ error: 'Server error' }));
}
// Block banned / timed-out users from write actions. Chain AFTER requireUser.
function requireNotBanned(req, res, next) {
    dbGet('SELECT banned_until FROM users WHERE id=?', [req.user.sub])
        .then(u => {
            if (u && isBanned(u.banned_until)) {
                const perm = Number(u.banned_until) > Date.now() + 50 * 365 * 24 * 3600 * 1000;
                return res.status(403).json({ error: 'ACCOUNT_BANNED', message: perm
                    ? 'Профилът Ви е блокиран и не може да добавя съдържание.'
                    : 'Профилът Ви е временно ограничен. Моля, опитайте по-късно.' });
            }
            next();
        })
        .catch(() => res.status(500).json({ error: 'Server error' }));
}
// Mint a fresh verification token, store its hash (24h), and email the link.
async function issueVerification(userId, email) {
    const token   = crypto.randomBytes(32).toString('hex');
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    await dbRun('UPDATE users SET verify_token_hash=?, verify_token_expires=? WHERE id=?',
        [sha256hex(token), expires, userId]);
    const link = `${DOMAIN}/api/auth/verify-email?token=${token}`;
    return sendEmail({ to: email, subject: 'Потвърдете имейла си - Адресът на историята', html: verifyEmailHtml(link) });
}

// Account claiming: attach any anonymous (guest) submissions made with this exact email
// to the given user, transferring ownership (and the stats/badges that derive from the
// owned rows). Called whenever we have a CONFIRMED email→account link: at registration,
// AND at every login — so a submission a visitor made while logged out, using the email
// of an account they already own, also lands in their profile the next time they sign in.
// Matches all statuses (pending/approved/returned) so a "returned for correction" guest
// post becomes editable from the profile. Idempotent and best-effort: never throws.
async function claimGuestSubmissions(userId, email) {
    const e = String(email || '').trim().toLowerCase();
    if (!userId || !e) return 0;
    try {
        const r = await dbRun(
            'UPDATE pending_addresses SET user_id=?, guest_email=NULL WHERE guest_email=? AND user_id IS NULL',
            [userId, e]
        );
        const n = (r && r.changes) || 0;
        if (n) console.log(`🔗 Linked ${n} guest submission(s) to user ${e}`);
        return n;
    } catch (err) {
        console.warn('guest-claim failed:', err.message);
        return 0;
    }
}

// Role gate, e.g. requireUserRole('owner','admin')
function requireUserRole(...roles) {
    return (req, res, next) => requireUser(req, res, () => {
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Forbidden' });
        next();
    });
}
// Fine-grained permission gate (owners bypass). Reads live perms from the DB.
function requireUserPermission(perm) {
    return (req, res, next) => requireUser(req, res, async () => {
        try {
            const row = await dbGet('SELECT role, permissions FROM users WHERE id=?', [req.user.sub]);
            if (!row) return res.status(401).json({ error: 'Not authenticated' });
            if (row.role === 'owner') return next();
            let perms = []; try { perms = JSON.parse(row.permissions || '[]'); } catch {}
            if (!perms.includes(perm)) return res.status(403).json({ error: 'Forbidden' });
            next();
        } catch (e) { res.status(500).json({ error: 'Server error' }); }
    });
}

// Moderator gate: role owner/moderator, OR the 'approve:photos' permission.
// Re-reads from the DB so a freshly changed role/permission takes effect.
function requireModerator(req, res, next) {
    requireUser(req, res, async () => {
        try {
            const row = await dbGet('SELECT role, permissions, totp_enabled FROM users WHERE id=?', [req.user.sub]);
            if (!row) return res.status(401).json({ error: 'Not authenticated' });
            let perms = []; try { perms = JSON.parse(row.permissions || '[]'); } catch {}
            if (row.role === 'owner' || row.role === 'admin' || row.role === 'moderator' || perms.includes('approve:photos')) {
                req.user.role = row.role;
                if (roleRequires2fa(row.role) && !row.totp_enabled) {
                    return res.status(403).json({ error: 'TWOFA_REQUIRED', message: 'Двуфакторната автентикация е задължителна за екипа. Активирайте я в настройките на профила си.' });
                }
                return next();
            }
            return res.status(403).json({ error: 'Forbidden - moderators only' });
        } catch (e) { res.status(500).json({ error: 'Server error' }); }
    });
}

// Owner-only gate, re-read from the DB (so role management is always current).
function requireOwnerUser(req, res, next) {
    requireUser(req, res, async () => {
        try {
            const row = await dbGet('SELECT role FROM users WHERE id=?', [req.user.sub]);
            if (!row) return res.status(401).json({ error: 'Not authenticated' });
            if (row.role !== 'owner') return res.status(403).json({ error: 'Forbidden - owner only' });
            req.user.role = row.role;
            next();
        } catch (e) { res.status(500).json({ error: 'Server error' }); }
    });
}

// ── Role hierarchy: user < moderator < admin < owner ──────────────────────────
const ROLE_RANK = { user: 0, moderator: 1, admin: 2, owner: 3 };
function roleRank(r) { return ROLE_RANK[r] || 0; }
// Gate by minimum role. Re-reads the live role from the DB (the JWT only carries the
// role at issue time) and attaches it as req.user.role.
function requireRole(minRole) {
    const min = ROLE_RANK[minRole] || 0;
    return (req, res, next) => requireUser(req, res, async () => {
        try {
            const row = await dbGet('SELECT role, totp_enabled FROM users WHERE id=?', [req.user.sub]);
            if (!row) return res.status(401).json({ error: 'Not authenticated' });
            req.user.role = row.role;
            if (roleRank(row.role) < min) return res.status(403).json({ error: 'Forbidden' });
            if (roleRequires2fa(row.role) && !row.totp_enabled) {
                return res.status(403).json({ error: 'TWOFA_REQUIRED', message: 'Двуфакторната автентикация е задължителна за екипа. Активирайте я в настройките на профила си.' });
            }
            next();
        } catch (e) { res.status(500).json({ error: 'Server error' }); }
    });
}
// True if `banned_until` is in the future.
function isBanned(bannedUntil) { return !!bannedUntil && Number(bannedUntil) > Date.now(); }
// Sentinel epoch for a permanent ban (year 9999) — well past the 50-year "permanent" cutoff.
const PERMANENT_BAN = 253370764800000;

// ── TOTP 2FA helpers ──────────────────────────────────────────────────────────
authenticator.options = { window: 2 };   // tolerate ±2 steps (±60 s) of clock drift → fewer false "invalid code"

// Encrypt the TOTP secret at rest with a DEDICATED, STABLE key (TOTP_ENC_KEY env).
// Crucially this is NOT derived from JWT_SECRET: rotating the session secret — or
// running without one in dev — must never make stored 2FA secrets undecryptable and
// lock everyone out. If TOTP_ENC_KEY is not configured we store the secret as plain
// text (still gated by DB access) so 2FA keeps working across restarts. Set
// TOTP_ENC_KEY in production to get encryption at rest.
const TOTP_ENC_KEY = process.env.TOTP_ENC_KEY
    ? crypto.createHash('sha256').update(String(process.env.TOTP_ENC_KEY)).digest()
    : null;
const TOTP_ENC_PREFIX = 'enc:';   // marks an encrypted value; base32 secrets never start with this
function encryptSecret(plain) {
    if (!TOTP_ENC_KEY) return String(plain);            // no stable key → store plaintext
    const iv  = crypto.randomBytes(12);
    const c   = crypto.createCipheriv('aes-256-gcm', TOTP_ENC_KEY, iv);
    const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
    return TOTP_ENC_PREFIX + [iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}
function decryptSecret(blob) {
    if (blob == null) return null;
    const s = String(blob);
    if (s.indexOf(TOTP_ENC_PREFIX) !== 0) return s;     // stored plaintext
    if (!TOTP_ENC_KEY) return null;                     // encrypted but key missing
    try {
        const [iv, tag, enc] = s.slice(TOTP_ENC_PREFIX.length).split('.');
        const d = crypto.createDecipheriv('aes-256-gcm', TOTP_ENC_KEY, Buffer.from(iv, 'base64'));
        d.setAuthTag(Buffer.from(tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
    } catch { return null; }
}
// Staff (moderator and up) MUST have 2FA; regular users opt in.
function roleRequires2fa(role) { return roleRank(role) >= ROLE_RANK.moderator; }
// Normalise a backup code for hashing/compare (strip formatting, upper-case).
function normBackup(c) { return String(c).toUpperCase().replace(/[^A-Z0-9]/g, ''); }
// Make N one-time recovery codes: human-readable for display, sha256-hashed for storage.
function makeBackupCodes(n) {
    const plain = [], hashes = [];
    for (let i = 0; i < n; i++) {
        const raw = crypto.randomBytes(5).toString('hex').toUpperCase();   // 10 hex chars
        plain.push(raw.slice(0, 5) + '-' + raw.slice(5));
        hashes.push(sha256hex(raw));
    }
    return { plain, hashes };
}
// Verify a backup code against the stored hash list; on success returns the list
// with that single code consumed (removed).
function verifyConsumeBackup(hashesJson, code) {
    let arr = []; try { arr = JSON.parse(hashesJson || '[]'); } catch {}
    const idx = arr.indexOf(sha256hex(normBackup(code)));
    if (idx === -1) return { ok: false, remaining: hashesJson };
    arr.splice(idx, 1);
    return { ok: true, remaining: JSON.stringify(arr) };
}
// Check a submitted 2FA code against a user's TOTP secret OR their backup codes.
// Returns { ok, backupRemaining|null } — backupRemaining set only when a backup code was used.
function check2faCode(user, code) {
    const trimmed = String(code || '').trim();
    if (!trimmed) return { ok: false, backupRemaining: null };
    const secret = decryptSecret(user.totp_secret);
    if (secret && /^\d{6}$/.test(trimmed) && authenticator.verify({ token: trimmed, secret })) {
        return { ok: true, backupRemaining: null };
    }
    const b = verifyConsumeBackup(user.totp_backup_codes, trimmed);
    if (b.ok) return { ok: true, backupRemaining: b.remaining };
    return { ok: false, backupRemaining: null };
}
// Short-lived token proving the password step passed, pending the 2FA code.
function sign2faPending(userId) { return jwt.sign({ p2fa: userId }, JWT_SECRET, { expiresIn: '5m' }); }
function verify2faPending(token) { try { return jwt.verify(token, JWT_SECRET).p2fa || null; } catch { return null; } }

// ─── Cyrillic → Latin slug helpers (for crowdsourced titles) ─────────────────────
const TRANSLIT = {
    а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',
    н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',
    ъ:'a',ь:'y',ю:'yu',я:'ya',
};
function slugifyTitle(title) {
    const s = String(title || '').toLowerCase()
        .replace(/[а-яё]/g, ch => TRANSLIT[ch] ?? '')   // transliterate Cyrillic
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
    return s || ('obekt-' + randomSuffix());
}
async function uniqueHomeSlug(base) {
    let slug = base, n = 2;
    // Append -2, -3… until the slug (and id) is free in homes.
    /* eslint-disable no-await-in-loop */
    while (await dbGet('SELECT 1 FROM homes WHERE slug=? OR id=?', [slug, slug])) {
        slug = base + '-' + n++;
    }
    return slug;
}

// Strip HTML/scripts from free-text fields before they are stored. These fields
// are always plain text, so removing tags (and control chars) neutralises stored
// XSS at the source - defence in depth alongside frontend escaping.
function sanitizeText(s, max = 5000) {
    if (s == null) return '';
    return String(s)
        .replace(/<[^>]*>/g, '')
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
        .trim()
        .slice(0, max);
}

function clientIp(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}
// Normalise an IP for storage/compare: trim + drop the IPv4-mapped-IPv6 prefix so a
// banned "1.2.3.4" also matches "::ffff:1.2.3.4".
function normIp(ip) { return String(ip || '').trim().toLowerCase().replace(/^::ffff:/, ''); }
// Accept a plain IPv4 or IPv6 literal (loose but enough to reject junk input).
function isValidIp(ip) {
    const s = normIp(ip);
    if (!s || s.length > 45) return false;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
    if (v4.test(s)) return s.split('.').every(o => Number(o) <= 255);
    return /^[0-9a-f:]+$/.test(s) && s.indexOf(':') !== -1;   // basic IPv6 shape
}
// IP blacklist: owner-managed permanent bans, held in memory for a zero-DB-hit check
// on every request and mirrored to the `ip_blacklist` table for persistence.
const ipBlacklist = new Set();

// Reusable in-memory rate limiter (per key, sliding fixed-window).
function makeRateLimiter({ windowMs, max, key, message }) {
    const hits = new Map();
    return (req, res, next) => {
        const id  = key ? key(req) : clientIp(req);
        const now = Date.now();
        const rec = hits.get(id) || { count: 0, reset: now + windowMs };
        if (now > rec.reset) { rec.count = 0; rec.reset = now + windowMs; }
        rec.count++;
        hits.set(id, rec);
        if (hits.size > 10000) for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
        if (rec.count > max) {
            res.setHeader('Retry-After', Math.ceil((rec.reset - now) / 1000));
            return res.status(429).json({ error: message || 'Твърде много заявки. Опитайте по-късно.' });
        }
        next();
    };
}
// Brute-force throttle for auth endpoints (per IP).
const rateLimitAuth = makeRateLimiter({ windowMs: 15 * 60 * 1000, max: 20, message: 'Too many attempts. Please try again later.' });
// Throttle crowdsourced submissions (per user, falls back to IP) so a bot can't
// spam our R2 bucket and run up storage costs.
const rateLimitSuggest = makeRateLimiter({
    windowMs: 60 * 60 * 1000, max: 25,
    key: req => (req.user && req.user.sub) || clientIp(req),
    message: 'Изпратихте твърде много предложения за кратко време. Опитайте по-късно.',
});
// Light throttle for favorite/visited toggles (per user) to curb write spam.
const rateLimitActivity = makeRateLimiter({
    windowMs: 60 * 1000, max: 60,
    key: req => (req.user && req.user.sub) || clientIp(req),
    message: 'Твърде много заявки. Опитайте отново след малко.',
});

// ─── Express app ─────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');
// Behind Railway's HTTPS proxy - needed for Secure cookies + req.secure to work.
app.set('trust proxy', 1);
app.use(compression());                       // gzip HTML/CSS/JS/JSON responses
// CORS: the site and its API share one origin, so cross-origin access is not
// needed. We disable it by default (no Access-Control-Allow-Origin header) and
// only allow explicit origins listed in ALLOWED_ORIGINS (comma-separated). This
// stops other sites from scripting our API in a browser. Same-origin is unaffected.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({ origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false, credentials: false }));
app.use(express.json({ limit: '1mb' }));      // JSON bodies are tiny; cap tightly
app.use(cookieParser());

// ── Security headers (applied to every response) ──────────────────────────────
app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');        // no MIME sniffing
    res.setHeader('X-Frame-Options', 'DENY');                  // anti-clickjacking
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    // HSTS: force HTTPS for 180 days. Honoured by browsers only over HTTPS, so it's a
    // no-op on localhost/http and safe to send unconditionally. No `preload` (that's a
    // hard-to-reverse commitment); includeSubDomains since the whole site is HTTPS.
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    next();
});

// ── IP blacklist gate ──────────────────────────────────────────────────────────
// Owner-banned IPs are refused everything (pages and API) with a 403. In-memory Set
// lookup, so it adds no latency for normal traffic.
app.use((req, res, next) => {
    if (ipBlacklist.size && ipBlacklist.has(normIp(clientIp(req)))) {
        return res.status(403).type('text/plain').send('403 Forbidden');
    }
    next();
});

// ── Maintenance mode ──────────────────────────────────────────────────────────
// When MAINTENANCE_MODE=true the public gets a branded 503 page. We still allow:
// the page's own assets, the favicon, the login page + auth API (so an owner can
// sign in), and /api/health (so the host's health check doesn't restart us). A
// logged-in owner bypasses everything and keeps using the live site.
// Cookie role check (owner, or admin+) used by the maintenance bypass. Reads the
// signed user-JWT cookie; never trusts a client claim.
function cookieRoleAtLeast(req, minRole) {
    try {
        const t = req.cookies && req.cookies[AUTH_COOKIE];
        if (!t) return false;
        const role = jwt.verify(t, JWT_SECRET).role;
        return (ROLE_RANK[role] || 0) >= (ROLE_RANK[minRole] || 0);
    } catch { return false; }
}

// Files / endpoints the maintenance gate always lets through: the maintenance page,
// the login page + auth APIs, the health check, AND the OWNER/ADMIN dashboard (its
// page + script) so staff can manage content while the public sees the 503 page.
const MAINT_ALLOW = new Set([
    '/maintenance.html', '/login.html', '/favicon.ico', '/api/health',
    '/admin/dashboard.html', '/admin/dashboard.js',
]);
app.use((req, res, next) => {
    if (process.env.MAINTENANCE_MODE !== 'true') return next();
    if (req.path.startsWith('/assets/') || MAINT_ALLOW.has(req.path)) return next();
    if (cookieRoleAtLeast(req, 'admin')) return next();           // staff keep full access
    if (req.path.startsWith('/api/auth/')) return next();         // allow the user login flow
    if (req.path.startsWith('/api/')) {
        return res.status(503).json({ error: 'Сайтът е в техническа поддръжка. Опитайте по-късно.' });
    }
    res.status(503).set('Retry-After', '3600').sendFile(path.join(__dirname, 'maintenance.html'));
});

// ── Request logger (deduplicated per IP / 10 s) ───────────────────────────────
const recentVisits = new Map();
app.use((req, _res, next) => {
    if (/\.(css|js|png|jpg|jpeg|ico|svg|webp|woff2?|ttf)$/.test(req.originalUrl)) return next();
    const ip  = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    if (!recentVisits.has(ip) || now - recentVisits.get(ip) > 10_000) {
        const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
        console.log(`[${ts}] ${ip} → ${req.method} ${req.originalUrl.slice(0, 80)}`);
        recentVisits.set(ip, now);
    }
    // Prune old entries periodically
    if (recentVisits.size > 300) {
        const cutoff = now - 60_000;
        for (const [k, v] of recentVisits) if (v < cutoff) recentVisits.delete(k);
    }
    next();
});

// ── Dynamic SEO for address/event detail pages ───────────────────────────────
// address.html is client-rendered, so a crawler would otherwise see a generic
// <title>/description and a canonical that points at the bare address.html. We
// server-render the per-place <title>, meta description, canonical, OG/Twitter tags
// and a Schema.org JSON-LD block into the <head> BEFORE sending, so the page can
// rank for the personality's/event's name on its own. Registered ahead of
// express.static so it can intercept /address.html?slug=…; with no slug (or an
// unknown one) it falls through to the static file unchanged.
let _addressTpl = null;
function addressTemplate() {
    if (_addressTpl == null) {
        try { _addressTpl = fs.readFileSync(path.join(__dirname, 'address.html'), 'utf8'); }
        catch { _addressTpl = ''; }
    }
    return _addressTpl;
}
// First photo as an absolute URL (R2 paths are already absolute; legacy relative
// paths get the site domain). Falls back to the logo so OG cards always have an image.
function seoImage(p) {
    const path0 = p && p.images && p.images[0] && p.images[0].path;
    if (!path0) return DOMAIN + '/assets/img/HistAdrLogoOrig.png';
    return /^https?:\/\//i.test(path0) ? path0 : DOMAIN + '/' + String(path0).replace(/^\/+/, '');
}
// Category-aware, name-first <title> + meta description (keyword-rich, unique per page).
function seoTitleDesc(name, category) {
    if (category === 'monument') return {
        title: `${name} - история, снимки и локация | Адресът на историята`,
        desc:  `Научете повече за ${name}. История, интересни факти, снимки и точни координати на локацията на картата.`,
    };
    if (category === 'events') return {
        title: `${name} - история, дата и място | Адресът на историята`,
        desc:  `Научете повече за ${name}. Историята на събитието, дата, снимки и точни координати на мястото на картата.`,
    };
    return {
        title: `${name} - история, къща и биография | Адресът на историята`,
        desc:  `Научете повече за живота на ${name}. Открийте къде е живял, исторически факти, снимки и точни координати на локацията на картата.`,
    };
}
// Schema.org JSON-LD: a @graph that tells Google exactly who/what the page is about.
// People (category 'home') get a Person node + the HistoricalLandmark of their house;
// monuments get a HistoricalLandmark; events get a Place.
function placeJsonLd(p, url) {
    const name = (p.name || '').trim() || 'Историческа локация';
    const cat  = p.category || 'home';
    const img  = seoImage(p);
    const desc = (p.biography && p.biography.trim()) || seoTitleDesc(name, cat).desc;
    const geo  = p.coordinates && p.coordinates.lat
        ? { '@type': 'GeoCoordinates', latitude: p.coordinates.lat, longitude: p.coordinates.lng } : null;
    const postal = { '@type': 'PostalAddress', addressCountry: 'BG' };
    if (p.address) postal.streetAddress = p.address;

    const landmark = {
        '@type': cat === 'events' ? 'Place' : 'HistoricalLandmark',
        name: cat === 'home' ? `Къщата на ${name}` : name,
        description: desc, url, image: img, address: postal,
    };
    if (geo) landmark.geo = geo;

    const graph = [];
    if (cat === 'home') {
        const person = { '@type': 'Person', name, description: desc, image: img, url };
        if (p.birth_date) person.birthDate = p.birth_date;
        if (p.death_date) person.deathDate = p.death_date;
        person.homeLocation = Object.assign({ '@type': 'Place', name: landmark.name }, geo ? { geo } : {});
        graph.push(person, landmark);
    } else {
        graph.push(landmark);
    }
    return { '@context': 'https://schema.org', '@graph': graph };
}
// Inject the computed SEO into the address.html template (string replacement on the
// known head tags + JSON-LD before </head>). All dynamic values are escaped.
function renderAddressSeo(html, p, slug) {
    const name = (p.name || '').trim() || 'Историческа локация';
    const url  = `${DOMAIN}/address.html?slug=${encodeURIComponent(slug)}`;
    const { title, desc } = seoTitleDesc(name, p.category || 'home');
    const t = escHtml(title), d = escHtml(desc), u = escHtml(url), img = escHtml(seoImage(p));
    const set = [
        [/<title>[\s\S]*?<\/title>/i,                          `<title>${t}</title>`],
        [/<meta\s+name=["']description["'][^>]*>/i,            `<meta name="description" content="${d}">`],
        [/<link\s+rel=["']canonical["'][^>]*>/i,               `<link rel="canonical" href="${u}">`],
        [/<meta\s+property=["']og:url["'][^>]*>/i,             `<meta property="og:url" content="${u}">`],
        [/<meta\s+property=["']og:title["'][^>]*>/i,           `<meta property="og:title" content="${t}">`],
        [/<meta\s+property=["']og:description["'][^>]*>/i,     `<meta property="og:description" content="${d}">`],
        [/<meta\s+property=["']og:image["'][^>]*>/i,           `<meta property="og:image" content="${img}">`],
        [/<meta\s+property=["']twitter:url["'][^>]*>/i,        `<meta property="twitter:url" content="${u}">`],
        [/<meta\s+property=["']twitter:title["'][^>]*>/i,      `<meta property="twitter:title" content="${t}">`],
        [/<meta\s+property=["']twitter:description["'][^>]*>/i,`<meta property="twitter:description" content="${d}">`],
        [/<meta\s+property=["']twitter:image["'][^>]*>/i,      `<meta property="twitter:image" content="${img}">`],
    ];
    let out = html;
    for (const [re, rep] of set) out = out.replace(re, rep);
    const ld = JSON.stringify(placeJsonLd(p, url)).replace(/</g, '\\u003c');
    out = out.replace(/<\/head>/i, `<script type="application/ld+json" id="ld-place">${ld}</script>\n</head>`);
    // Flag so the client SEO skips re-injecting the JSON-LD (avoids a duplicate node).
    out = out.replace(/<html(\s|>)/i, '<html data-ssr-seo="1"$1');
    return out;
}
app.get('/address.html', async (req, res, next) => {
    const slug = String(req.query.slug || '').trim();
    if (!slug) return next();                          // listing/no slug → static file
    try {
        let data = cache.get(`home:${slug}`);          // reuse the /api/homes/:slug cache if warm
        if (!data) {
            const row = await dbGet('SELECT * FROM homes WHERE slug=? OR id=?', [slug, slug]);
            if (!row) return next();                   // unknown slug → static (client handles it)
            data = rowToHome(row);
        }
        const tpl = addressTemplate();
        if (!tpl) return next();
        res.set('Cache-Control', 'no-cache');
        res.type('html').send(renderAddressSeo(tpl, data, slug));
    } catch (e) {
        console.error('address SEO error:', e.message);
        next();
    }
});

// ── Static files ──────────────────────────────────────────────────────────────
// HTML must always revalidate (otherwise edited pages stay stale for up to a day);
// hashed/versioned assets can cache long.
app.use(express.static(__dirname, {
    etag: true,
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', /\.html?$/i.test(filePath) ? 'no-cache' : 'public, max-age=86400');
    },
}));

// Favicon aliases
const faviconFile = path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png');
const sendFavicon = (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(faviconFile);
};
['/favicon.ico', '/apple-touch-icon.png', '/android-chrome-192x192.png',
 '/android-chrome-512x512.png', '/assets/img/HistAdrLogoOrig.ico'].forEach(p => app.get(p, sendFavicon));

// ─── SQLite DB ────────────────────────────────────────────────────────────────

// Ensure DB directory exists and is writable
const dbDir = path.dirname(DB_FILE);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
try { fs.accessSync(dbDir, fs.constants.W_OK); }
catch { console.error('❌ DB directory not writable:', dbDir); process.exit(1); }

const db = new sqlite3.Database(DB_FILE, err => {
    if (err) { console.error('❌ DB open failed:', err); process.exit(1); }
    console.log('✅ SQLite connected:', DB_FILE);
});

// PRAGMA tuning
db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous  = NORMAL');
    db.run('PRAGMA temp_store   = MEMORY');
    db.run('PRAGMA busy_timeout = 5000');
    db.run(`PRAGMA cache_size   = ${LOW_SPEC ? -2000 : -64000}`);
    db.run('PRAGMA mmap_size    = 0');
    // Enforce referential integrity for the user system (user_activity → users).
    // No existing table declares a foreign key, so this does not affect homes/
    // partners/news/team behaviour in any way.
    db.run('PRAGMA foreign_keys  = ON');
});

// ─── Schema init ─────────────────────────────────────────────────────────────

function initDB() {
    db.serialize(() => {
        // Homes
        db.run(`CREATE TABLE IF NOT EXISTS homes (
            id          TEXT PRIMARY KEY,
            slug        TEXT UNIQUE,
            name        TEXT NOT NULL,
            biography   TEXT,
            address     TEXT,
            lat         REAL,
            lng         REAL,
            images      TEXT,
            photo_date  TEXT,
            sources     TEXT,
            tags        TEXT,
            published   INTEGER DEFAULT 1,
            created_at  TEXT,
            updated_at  TEXT,
            portrait_url TEXT,
            birth_date  TEXT,
            death_date  TEXT,
            date_label  TEXT,
            category    TEXT DEFAULT 'home',
            name_lower  TEXT,
            credited_to TEXT
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_published ON homes(published)');
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_slug      ON homes(slug)');
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_name      ON homes(name)');
        // NOTE: idx_homes_category is created in migrateHomes() - only after the
        // `category` column is guaranteed to exist (older DBs add it via ALTER).

        // ── Related places: a self-referencing many-to-many on homes ──────────────
        // A row (home_id → related_id) is one directional link the admin set on
        // `home_id`. The detail page shows the UNION of a home's outgoing and incoming
        // links, so a single stored link surfaces on BOTH places' pages. ON DELETE
        // CASCADE keeps it clean when a home is removed.
        db.run(`CREATE TABLE IF NOT EXISTS related_places (
            home_id    TEXT NOT NULL,
            related_id TEXT NOT NULL,
            created_at TEXT,
            PRIMARY KEY (home_id, related_id),
            FOREIGN KEY (home_id)    REFERENCES homes(id) ON DELETE CASCADE,
            FOREIGN KEY (related_id) REFERENCES homes(id) ON DELETE CASCADE
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_related_home    ON related_places(home_id)');
        db.run('CREATE INDEX IF NOT EXISTS idx_related_related ON related_places(related_id)');

        // Partners
        db.run(`CREATE TABLE IF NOT EXISTS partners (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            description   TEXT,
            logo_url      TEXT,
            website       TEXT,
            instagram     TEXT,
            email         TEXT,
            published     INTEGER DEFAULT 1,
            display_order INTEGER DEFAULT 0,
            created_at    TEXT,
            updated_at    TEXT
        )`);

        // News
        db.run(`CREATE TABLE IF NOT EXISTS news (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            title          TEXT NOT NULL,
            slug           TEXT UNIQUE NOT NULL,
            content        TEXT NOT NULL,
            excerpt        TEXT,
            cover_image    TEXT,
            published_date TEXT NOT NULL,
            author         TEXT DEFAULT 'Екипът на Адресът на историята',
            is_published   INTEGER DEFAULT 1,
            created_at     TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at     TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_news_slug      ON news(slug)');
        db.run('CREATE INDEX IF NOT EXISTS idx_news_published ON news(is_published, published_date DESC)');
        db.run('ALTER TABLE news ADD COLUMN link TEXT', () => {});   // optional external link

        // Team
        db.run(`CREATE TABLE IF NOT EXISTS team (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            name          TEXT NOT NULL,
            role          TEXT,
            bio           TEXT,
            photo         TEXT,
            display_order INTEGER DEFAULT 0,
            is_published  INTEGER DEFAULT 1,
            created_at    TEXT DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_team_order ON team(display_order, is_published)');

        // ── IP blacklist (owner-managed permanent bans) ──
        db.run(`CREATE TABLE IF NOT EXISTS ip_blacklist (
            ip          TEXT PRIMARY KEY,
            reason      TEXT,
            created_by  TEXT,
            created_at  TEXT NOT NULL
        )`, () => {
            db.all('SELECT ip FROM ip_blacklist', (err, rows) => {
                if (!err && rows) rows.forEach(r => ipBlacklist.add(normIp(r.ip)));
            });
        });

        // ── Generic key→value settings (currently: watermark configurator) ──────────
        db.run(`CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT
        )`);

        // ── User accounts (RBAC) ──────────────────────────────────────────────
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id                  TEXT PRIMARY KEY,
            email               TEXT UNIQUE NOT NULL,
            password_hash       TEXT NOT NULL,
            role                TEXT NOT NULL DEFAULT 'user',
            permissions         TEXT NOT NULL DEFAULT '[]',
            display_name        TEXT,
            reset_token_hash    TEXT,
            reset_token_expires INTEGER,
            created_at          TEXT NOT NULL
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)');
        // Migrations: older DBs predate these columns. The no-op callbacks swallow
        // the "duplicate column" error when a column already exists.
        db.run('ALTER TABLE users ADD COLUMN display_name TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN reset_token_hash TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN reset_token_expires INTEGER', () => {});
        db.run('ALTER TABLE users ADD COLUMN newsletter INTEGER DEFAULT 0', () => {});  // email opt-in
        db.run('CREATE INDEX IF NOT EXISTS idx_users_reset ON users(reset_token_hash)', () => {});
        // ── Email verification ──
        // The ALTER only succeeds the FIRST time the column is added; in that single
        // callback we grandfather every PRE-EXISTING account as verified so the new
        // gate never locks out users who registered before this feature shipped.
        db.run('ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0', (err) => {
            if (!err) db.run('UPDATE users SET email_verified=1', () => {});
        });
        db.run('ALTER TABLE users ADD COLUMN verify_token_hash TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN verify_token_expires INTEGER', () => {});
        db.run('CREATE INDEX IF NOT EXISTS idx_users_verify ON users(verify_token_hash)', () => {});
        // ── RBAC: account ban / timeout (ms epoch; 0 = active, >now = blocked until) ──
        db.run('ALTER TABLE users ADD COLUMN banned_until INTEGER DEFAULT 0', () => {});
        // ── TOTP 2FA ──
        // totp_secret holds the AES-GCM-encrypted base32 secret (pending or active).
        // totp_enabled flips to 1 only after the user verifies a first code.
        // totp_backup_codes is a JSON array of sha256 hashes of one-time recovery codes.
        db.run('ALTER TABLE users ADD COLUMN totp_secret TEXT', () => {});
        db.run('ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0', () => {});
        db.run('ALTER TABLE users ADD COLUMN totp_backup_codes TEXT', () => {});

        // ── Per-user activity (favorites / visited) ───────────────────────────
        // address_id references a home id; user_id cascades on user deletion.
        db.run(`CREATE TABLE IF NOT EXISTS user_activity (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id     TEXT NOT NULL,
            address_id  TEXT NOT NULL,
            status      TEXT NOT NULL CHECK(status IN ('favorite','visited')),
            created_at  TEXT NOT NULL,
            UNIQUE(user_id, address_id, status),
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_activity_user ON user_activity(user_id, status)');
        db.run('CREATE INDEX IF NOT EXISTS idx_activity_addr ON user_activity(address_id)');

        // ── Crowdsourced submissions (moderation queue) ───────────────────────
        // Never touches the live `homes` table until a moderator approves.
        db.run(`CREATE TABLE IF NOT EXISTS pending_addresses (
            id           TEXT PRIMARY KEY,
            user_id      TEXT NOT NULL,
            title        TEXT NOT NULL,
            description  TEXT,
            city         TEXT,
            address      TEXT,
            lat          REAL,
            lng          REAL,
            category     TEXT NOT NULL DEFAULT 'home',
            image_path   TEXT,
            status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
            created_at   TEXT NOT NULL,
            reviewed_at  TEXT,
            reviewed_by  TEXT,
            result_slug  TEXT,
            FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_addresses(status, created_at)');
        db.run('CREATE INDEX IF NOT EXISTS idx_pending_user   ON pending_addresses(user_id, created_at)');
        // Watermark attribution: did the suggester claim the photos as their own, and
        // under what name should the "© … via Адресът на историята" watermark read.
        db.run('ALTER TABLE pending_addresses ADD COLUMN owns_image INTEGER DEFAULT 0', () => {});
        db.run('ALTER TABLE pending_addresses ADD COLUMN author_name TEXT', () => {});
        // "Send back for correction": a moderator note shown to the submitter. A
        // 'rejected' row that carries a note is treated as "needs correction" in the UI –
        // the user can fix it and resubmit (which flips it back to 'pending').
        db.run('ALTER TABLE pending_addresses ADD COLUMN moderation_note TEXT', () => {});
        // denied=1 marks a *final* rejection (photos deleted, user cannot resubmit).
        // We overload the existing 'rejected' status with this flag to avoid changing the
        // status CHECK constraint: rejected+denied=0 → "for correction", denied=1 → "denied".
        db.run('ALTER TABLE pending_addresses ADD COLUMN denied INTEGER DEFAULT 0', () => {});
        // Admins can hide a *processed* submission from the moderation history (without
        // deleting it) to declutter the approved/rejected lists.
        db.run('ALTER TABLE pending_addresses ADD COLUMN hidden_from_history INTEGER DEFAULT 0', () => {});
        // Anonymous guest submissions: the email a non-registered visitor gave us. When
        // they later register with that exact email we transfer the rows to them (see
        // claimGuestSubmissions in /api/auth/register). For guest rows user_id is NULL.
        db.run('ALTER TABLE pending_addresses ADD COLUMN guest_email TEXT', () => {});
        // The original table declared user_id NOT NULL; relax it so guest rows (NULL
        // user_id + guest_email) can be stored. SQLite can't ALTER a NOT NULL away, so
        // we rebuild the table once. Idempotent: only runs while user_id is still NOT NULL.
        migratePendingGuestNullable();

        // ── Internal moderator feedback (moderators → admins/owners) ──────────────
        // Threaded notes on a pending submission. NOT shown to the submitter.
        db.run(`CREATE TABLE IF NOT EXISTS submission_feedback (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            submission_id TEXT NOT NULL,
            author_id     TEXT,
            author_name   TEXT,
            comment       TEXT NOT NULL,
            created_at    TEXT NOT NULL
        )`);
        db.run('CREATE INDEX IF NOT EXISTS idx_feedback_sub ON submission_feedback(submission_id, created_at)');

        // Migrations: add columns that older DBs may be missing
        migrateHomes();
    });
}

function migrateHomes() {
    db.all('PRAGMA table_info(homes)', (err, cols) => {
        if (err) { importSeedData(); return; }
        const have = new Set(cols.map(c => c.name));
        const needed = [
            { name: 'portrait_url', type: 'TEXT' },
            { name: 'birth_date',   type: 'TEXT' },   // stores date_start
            { name: 'death_date',   type: 'TEXT' },   // stores date_end
            // Custom date descriptor (e.g. "Построена през", "Години на живот"). When
            // present the UI shows it instead of the default person "Роден/Починал".
            { name: 'date_label',   type: 'TEXT' },
            // New: location category. Existing rows are backfilled to 'home'
            // automatically by SQLite via the column DEFAULT.
            { name: 'category',     type: "TEXT DEFAULT 'home'" },
            // Unicode-lowercased copy of `name` for case-insensitive search
            // (SQLite's LOWER() only folds ASCII, so Cyrillic needs this).
            { name: 'name_lower',   type: 'TEXT' },
            // Optional credit shown on the address page ("Предложено от …").
            { name: 'credited_to',  type: 'TEXT' },
        ].filter(c => !have.has(c.name));

        // Create indexes only once their columns are guaranteed to exist,
        // backfill name_lower for any rows missing it, then continue seeding.
        const finish = () =>
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_category   ON homes(category)', () =>
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_name_lower ON homes(name_lower)', () =>
                populateNameLower(() => importSeedData())));

        if (!needed.length) { finish(); return; }

        let pending = needed.length;
        for (const col of needed) {
            db.run(`ALTER TABLE homes ADD COLUMN ${col.name} ${col.type}`, () => {
                if (--pending === 0) finish();
            });
        }
    });
}

// Rebuild pending_addresses so user_id is nullable (needed for anonymous guest
// submissions). Runs at most once: if the column is already nullable we do nothing.
function migratePendingGuestNullable() {
    db.all('PRAGMA table_info(pending_addresses)', (err, cols) => {
        if (err || !cols || !cols.length) return;
        const userIdCol = cols.find(c => c.name === 'user_id');
        if (!userIdCol || userIdCol.notnull === 0) return;   // already nullable → done
        console.log('🛠  Migrating pending_addresses → nullable user_id (guest submissions)…');
        db.serialize(() => {
            db.run('PRAGMA foreign_keys = OFF');
            db.run('BEGIN');
            db.run(`CREATE TABLE pending_addresses__new (
                id           TEXT PRIMARY KEY,
                user_id      TEXT,
                guest_email  TEXT,
                title        TEXT NOT NULL,
                description  TEXT,
                city         TEXT,
                address      TEXT,
                lat          REAL,
                lng          REAL,
                category     TEXT NOT NULL DEFAULT 'home',
                image_path   TEXT,
                status       TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
                created_at   TEXT NOT NULL,
                reviewed_at  TEXT,
                reviewed_by  TEXT,
                result_slug  TEXT,
                owns_image   INTEGER DEFAULT 0,
                author_name  TEXT,
                moderation_note TEXT,
                denied       INTEGER DEFAULT 0,
                hidden_from_history INTEGER DEFAULT 0,
                FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
            )`);
            db.run(`INSERT INTO pending_addresses__new
                (id,user_id,guest_email,title,description,city,address,lat,lng,category,image_path,
                 status,created_at,reviewed_at,reviewed_by,result_slug,owns_image,author_name,
                 moderation_note,denied,hidden_from_history)
                SELECT id,user_id,guest_email,title,description,city,address,lat,lng,category,image_path,
                 status,created_at,reviewed_at,reviewed_by,result_slug,owns_image,author_name,
                 moderation_note,denied,hidden_from_history
                FROM pending_addresses`);
            db.run('DROP TABLE pending_addresses');
            db.run('ALTER TABLE pending_addresses__new RENAME TO pending_addresses');
            db.run('CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_addresses(status, created_at)');
            db.run('CREATE INDEX IF NOT EXISTS idx_pending_user   ON pending_addresses(user_id, created_at)');
            db.run('CREATE INDEX IF NOT EXISTS idx_pending_guest  ON pending_addresses(guest_email)');
            db.run('COMMIT', (e) => {
                if (e) console.error('❌ pending_addresses migration failed:', e.message);
                else   console.log('✅ pending_addresses now supports guest submissions.');
            });
            db.run('PRAGMA foreign_keys = ON');
        });
    });
}

// Fill name_lower (JS toLowerCase is Unicode-aware, unlike SQLite's LOWER)
function populateNameLower(cb) {
    db.all('SELECT id, name FROM homes WHERE name_lower IS NULL', (err, rows) => {
        if (err || !rows || !rows.length) return cb();
        db.serialize(() => {
            db.run('BEGIN');
            for (const r of rows) {
                db.run('UPDATE homes SET name_lower=? WHERE id=?', [(r.name || '').toLowerCase(), r.id]);
            }
            db.run('COMMIT', () => { console.log(`🔤 Backfilled name_lower for ${rows.length} rows.`); cb(); });
        });
    });
}

function importSeedData() {
    db.get('SELECT COUNT(*) AS n FROM homes', (err, row) => {
        if (err || (row && row.n > 0)) {
            if (!err) console.log(`📊 DB has ${row.n} homes - ready.`);
            return;
        }
        const dataPath = path.join(__dirname, 'data', 'people.js');
        if (!fs.existsSync(dataPath)) {
            console.warn('⚠️  people.js not found - skipping seed.');
            return;
        }
        try {
            const src   = fs.readFileSync(dataPath, 'utf8');
            const match = src.match(/var\s+PEOPLE\s*=\s*(\[[\s\S]*?\]);/);
            if (!match) { console.warn('⚠️  Could not parse people.js'); return; }
            const people = JSON.parse(match[1]);
            db.serialize(() => {
                db.run('BEGIN');
                people.forEach(insertHome);
                db.run('COMMIT', () => {
                    console.log(`✅ Seeded ${people.length} homes.`);
                    cache.clear();
                });
            });
        } catch (e) {
            console.error('❌ Seed error:', e.message);
        }
    });
}

// Ensure default team member exists after team table is ready
function seedDefaultTeamMember() {
    db.get('SELECT COUNT(*) AS n FROM team', (err, row) => {
        if (err || !row || row.n > 0) return;
        db.run(`INSERT INTO team (name, role, bio, display_order) VALUES (?, ?, ?, ?)`, [
            'Георги Георгиев Петков',
            'Основател и Администратор',
            'Основател и администратор на проекта „Адресът на историята".',
            1,
        ]);
    });
}

initDB();
// Give the CREATE TABLE statements a moment to settle, then seed team
setTimeout(seedDefaultTeamMember, 500);

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Allowed location categories. Anything unknown falls back to 'home' so we never
// store invalid values and existing behaviour stays unchanged.
const CATEGORIES = ['home', 'monument', 'events'];
function normCategory(c) {
    return CATEGORIES.includes(c) ? c : 'home';
}

function insertHome(h) {
    const c   = h.coordinates || {};
    const now = new Date().toISOString();
    // Accept the generic date_start/date_end (falling back to the legacy birth/death keys).
    const dStart = (h.date_start != null ? h.date_start : h.birth_date) || null;
    const dEnd   = (h.date_end   != null ? h.date_end   : h.death_date) || null;
    db.run(`INSERT OR REPLACE INTO homes
        (id,slug,name,name_lower,biography,address,lat,lng,images,photo_date,
         sources,tags,published,created_at,updated_at,portrait_url,birth_date,death_date,date_label,category,credited_to)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
            h.id || h.slug, h.slug, h.name, (h.name || '').toLowerCase(), h.biography, h.address,
            c.lat || null, c.lng || null,
            JSON.stringify(h.images  || []),
            h.photo_date  || null,
            JSON.stringify(h.sources || []),
            JSON.stringify(h.tags    || []),
            h.published !== false ? 1 : 0,
            h.created_at || now, h.updated_at || now,
            h.portrait_url || null, dStart, dEnd, (h.date_label ? String(h.date_label).trim().slice(0, 80) : null),
            normCategory(h.category), h.credited_to || null,
        ]
    );
}

// ── Related places (self-referencing M2M) ─────────────────────────────────────
// Replace a home's OUTGOING related links. Drops self-links / unknown ids, dedups,
// caps the count. Call AFTER the home row exists (FK enforcement is ON).
async function syncRelated(homeId, relatedIds) {
    await dbRun('DELETE FROM related_places WHERE home_id=?', [homeId]);
    if (!Array.isArray(relatedIds)) return;
    const ids = [...new Set(relatedIds.map(x => String(x)).filter(x => x && x !== homeId))].slice(0, 12);
    if (!ids.length) return;
    const rows  = await dbAll(`SELECT id FROM homes WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
    const valid = new Set(rows.map(r => r.id));
    const now   = new Date().toISOString();
    for (const rid of ids) {
        if (valid.has(rid)) await dbRun('INSERT OR IGNORE INTO related_places (home_id,related_id,created_at) VALUES (?,?,?)', [homeId, rid, now]);
    }
}
// Best thumbnail for a related-place card: the place photo first, portrait as fallback.
function relatedThumb(r) {
    try { const imgs = JSON.parse(r.images || '[]'); if (imgs[0]) { const t = ensureThumb(imgs[0]); return t.thumb || t.path || null; } } catch {}
    if (r.portrait_url) return /^https?:\/\/.+\.jpe?g$/i.test(r.portrait_url) ? r.portrait_url.replace(/\.jpe?g$/i, '_thumb.jpg') : r.portrait_url;
    return null;
}
// Union of a home's outgoing + incoming links → published homes only, as preview cards.
async function getRelatedPlaces(homeId) {
    const rows = await dbAll(
        `SELECT h.slug, h.name, h.address, h.category, h.images, h.portrait_url
         FROM homes h
         WHERE h.published = 1 AND h.id <> ? AND h.id IN (
             SELECT related_id FROM related_places WHERE home_id = ?
             UNION
             SELECT home_id    FROM related_places WHERE related_id = ?
         )
         ORDER BY h.category, h.name
         LIMIT 12`,
        [homeId, homeId, homeId]
    );
    return rows.map(r => ({
        slug: r.slug, name: r.name, address: r.address || '',
        category: r.category || 'home', image: relatedThumb(r),
    }));
}
// The links FROM this home (what the admin editor pre-fills) - with names for chips.
async function getRelatedEdit(homeId) {
    return dbAll(
        `SELECT h.id, h.name, h.category FROM related_places rp
         JOIN homes h ON h.id = rp.related_id
         WHERE rp.home_id = ? ORDER BY h.name`, [homeId]);
}

// Many older homes store images without a `thumb` field, even though the matching
// <name>_thumb.jpg exists in R2 (created by the thumbnail backfill). Derive it from the
// path so list cards load the small thumbnail instead of the full-size image.
function ensureThumb(img) {
    if (!img || typeof img !== 'object' || img.thumb) return img;
    const p = img.path || '';
    if (/^https?:\/\/.+\.jpe?g$/i.test(p)) return Object.assign({}, img, { thumb: p.replace(/\.jpe?g$/i, '_thumb.jpg') });
    return img;
}
// Best calendar thumbnail for a person: prefer the portrait (the person's face) so
// visitors recognise who it is, falling back to the first address photo. Derives the
// lightweight _thumb.jpg variant when the URL follows our upload naming convention.
function calPic(portraitUrl, imagesJson) {
    const thumbOf = (url) => (typeof url === 'string' && /^https?:\/\/.+\.jpe?g$/i.test(url))
        ? url.replace(/\.jpe?g$/i, '_thumb.jpg') : url;
    if (portraitUrl) return thumbOf(portraitUrl) || portraitUrl;
    let a = []; try { a = JSON.parse(imagesJson || '[]'); } catch {}
    const t = ensureThumb(a[0] || null);
    return t ? (t.thumb || t.path) : null;
}
function rowToHome(row, listMode = false) {
    const parse = (s, def = []) => { try { return JSON.parse(s || 'null') ?? def; } catch { return def; } };
    if (listMode) {
        const imgs = parse(row.images);
        return {
            id:          row.id,
            slug:        row.slug,
            name:        row.name,
            address:     row.address || '',
            coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
            images:      imgs.length ? [ensureThumb(imgs[0])] : [],
            tags:        parse(row.tags),
            category:    row.category || 'home',
            published:   true,
            biography:   row.bio_snippet ? row.bio_snippet + '…' : '',
        };
    }
    return {
        id:          row.id,
        slug:        row.slug,
        name:        row.name,
        biography:   row.biography,
        address:     row.address,
        coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
        images:      parse(row.images).map(ensureThumb),
        photo_date:  row.photo_date,
        sources:     parse(row.sources),
        tags:        parse(row.tags),
        published:   row.published === 1,
        created_at:  row.created_at,
        updated_at:  row.updated_at,
        portrait_url: row.portrait_url,
        // Generic, flexible dates. date_start/date_end are stored in the legacy
        // birth_date/death_date columns; date_label customises how they're shown.
        date_start:  row.birth_date,
        date_end:    row.death_date,
        date_label:  row.date_label || null,
        birth_date:  row.birth_date,   // kept for backward compatibility
        death_date:  row.death_date,
        category:    row.category || 'home',
        credited_to: row.credited_to || null,
    };
}

// Wrap db.get / db.all in promises for cleaner async routes
function dbGet(sql, params = []) {
    return new Promise((res, rej) => db.get(sql, params, (e, r) => e ? rej(e) : res(r)));
}
function dbAll(sql, params = []) {
    return new Promise((res, rej) => db.all(sql, params, (e, r) => e ? rej(e) : res(r)));
}
function dbRun(sql, params = []) {
    return new Promise((res, rej) => db.run(sql, params, function(e) { e ? rej(e) : res(this); }));
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// ── User auth & profile ───────────────────────────────────────────────────────

// Register: validate, ensure unique email, bcrypt-hash, store, log the user in.
app.post('/api/auth/register', rateLimitAuth, async (req, res) => {
    const email    = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = (req.body && req.body.password) || '';
    if (!validEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    if (isDisposableEmail(email)) return res.status(400).json({ error: 'Моля, използвайте постоянен имейл адрес - временните (10-минутни) пощи не се приемат.' });
    // Age gate (GDPR/COPPA): the user must confirm they are 14+. We store no birth
    // data - only require and check the attestation.
    const ageOk = req.body && (req.body.age_confirmed === true || req.body.age_confirmed === 'true' || req.body.age_confirmed === 1);
    if (!ageOk) return res.status(400).json({ error: 'Трябва да потвърдите, че сте на поне 14 години, за да създадете профил.' });
    const issue = passwordIssue(password);
    if (issue) return res.status(400).json({ error: issue });
    try {
        const existing = await dbGet('SELECT id FROM users WHERE email=?', [email]);
        if (existing) return res.status(409).json({ error: 'This email is already registered' });

        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS); // never store plaintext
        const id  = crypto.randomUUID();
        const now = new Date().toISOString();
        const newsletter = (req.body && (req.body.newsletter === true || req.body.newsletter === 1)) ? 1 : 0;
        // email_verified starts at 0 → the account is restricted until the link is clicked.
        await dbRun(
            'INSERT INTO users (id,email,password_hash,role,permissions,newsletter,created_at,email_verified) VALUES (?,?,?,?,?,?,?,0)',
            [id, email, password_hash, 'user', '[]', newsletter, now]
        );

        // Account claiming: any past anonymous submissions made with this exact email are
        // transferred to the new profile (ownership + stats/badges, which derive from the
        // owned rows). Best-effort: never block or fail the registration over it.
        await claimGuestSubmissions(id, email);

        issueAuthCookie(res, { id, role: 'user' });
        res.status(201).json({ id, email, role: 'user', email_verified: false });

        // Fire-and-forget verification email - never blocks or fails the registration.
        issueVerification(id, email).catch(() => {});
    } catch (e) {
        console.error('register error:', e.message);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login: verify credentials (constant-time), set the secure cookie.
app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
    const email    = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = (req.body && req.body.password) || '';
    try {
        const user = await dbGet('SELECT id,email,password_hash,role,totp_enabled FROM users WHERE email=?', [email]);
        // Always run a compare to keep timing uniform whether or not the email exists.
        const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
        if (!user || !ok) return res.status(401).json({ error: 'Invalid email or password' });

        // 2FA: when enabled, the password step alone does NOT grant a session. We hand
        // back a short-lived pending token; the client must clear the TOTP step next.
        if (user.totp_enabled) {
            return res.json({ twofa_required: true, pending: sign2faPending(user.id) });
        }
        issueAuthCookie(res, { id: user.id, role: user.role });
        // Claim any guest submissions left under this email (e.g. submitted while logged out).
        await claimGuestSubmissions(user.id, user.email);
        // Staff without 2FA can sign in but must enrol before using staff tools.
        res.json({ id: user.id, email: user.email, role: user.role, enroll_2fa_required: roleRequires2fa(user.role) });
    } catch (e) {
        console.error('login error:', e.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

// 2FA login step: exchange the pending token + a TOTP (or backup) code for a session.
app.post('/api/auth/2fa-login', rateLimitAuth, async (req, res) => {
    const pending = (req.body && req.body.pending) || '';
    const code    = (req.body && req.body.code) || '';
    const userId  = verify2faPending(pending);
    if (!userId) return res.status(401).json({ error: 'Сесията изтече. Влезте отново.' });
    try {
        const user = await dbGet('SELECT id,email,role,totp_enabled,totp_secret,totp_backup_codes FROM users WHERE id=?', [userId]);
        if (!user || !user.totp_enabled) return res.status(400).json({ error: 'Двуфакторната автентикация не е активна.' });
        const r = check2faCode(user, code);
        if (!r.ok) return res.status(401).json({ error: 'Невалиден код.' });
        if (r.backupRemaining !== null) {
            await dbRun('UPDATE users SET totp_backup_codes=? WHERE id=?', [r.backupRemaining, user.id]);
        }
        issueAuthCookie(res, { id: user.id, role: user.role });
        // Claim any guest submissions left under this email (e.g. submitted while logged out).
        await claimGuestSubmissions(user.id, user.email);
        res.json({ id: user.id, email: user.email, role: user.role });
    } catch (e) {
        console.error('2fa-login error:', e.message);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Logout: clear the cookie (must match the attributes it was set with).
app.post('/api/auth/logout', (req, res) => {
    res.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, path: '/' });
    res.json({ message: 'Logged out' });
});

// Forgot password: if the email exists, store a hashed one-hour reset token and
// email a reset link. The response is ALWAYS the same generic message so the
// endpoint can't be used to discover which emails are registered.
app.post('/api/auth/forgot-password', rateLimitAuth, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const generic = { message: 'Ако този имейл съществува в системата, изпратихме връзка за нулиране на паролата.' };
    if (!validEmail(email)) return res.json(generic);
    try {
        const user = await dbGet('SELECT id FROM users WHERE email=?', [email]);
        if (user) {
            const token   = crypto.randomBytes(32).toString('hex');   // raw token → goes in the link
            const hash    = sha256hex(token);                          // only the hash is stored
            const expires = Date.now() + 60 * 60 * 1000;               // 1 hour
            await dbRun('UPDATE users SET reset_token_hash=?, reset_token_expires=? WHERE id=?', [hash, expires, user.id]);
            const link = `${DOMAIN}/reset-password.html?token=${token}`;
            await sendEmail({
                to: email,
                subject: 'Нулиране на паролата - Адресът на историята',
                html: resetEmailHtml(link),
            });
        }
        res.json(generic);
    } catch (e) {
        console.error('forgot-password error:', e.message);
        res.json(generic);   // stay generic even on error → no information leak
    }
});

// Reset password: validate the token (hash match + not expired), set the new
// bcrypt-hashed password, and invalidate the token so it can't be reused.
app.post('/api/auth/reset-password', rateLimitAuth, async (req, res) => {
    const token    = String((req.body && req.body.token) || '').trim();
    const password = (req.body && req.body.password) || '';
    if (!token || token.length < 32) return res.status(400).json({ error: 'Невалидна заявка за нулиране.' });
    if (passwordIssue(password))      return res.status(400).json({ error: 'Паролата трябва да е поне 8 символа и да съдържа букви и цифри.' });
    try {
        const hash = sha256hex(token);
        const user = await dbGet('SELECT id, reset_token_expires FROM users WHERE reset_token_hash=?', [hash]);
        if (!user || !user.reset_token_expires || user.reset_token_expires < Date.now()) {
            return res.status(400).json({ error: 'Връзката е невалидна или изтекла. Моля, заявете нова.' });
        }
        const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await dbRun(
            'UPDATE users SET password_hash=?, reset_token_hash=NULL, reset_token_expires=NULL WHERE id=?',
            [password_hash, user.id]
        );
        res.json({ message: 'Паролата е променена успешно. Вече можете да влезете.' });
    } catch (e) {
        console.error('reset-password error:', e.message);
        res.status(500).json({ error: 'Възникна грешка. Моля, опитайте отново.' });
    }
});

// Verify email from the link in the registration email. Server-rendered themed page
// (one click → done), then a button onward to the profile.
app.get('/api/auth/verify-email', async (req, res) => {
    const token = String(req.query.token || '').trim();
    const page = (icon, title, msg, cta) => `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Потвърждение на имейл</title><link rel="stylesheet" href="/assets/css/styles.css?v=7"><style>body{display:flex;min-height:92vh;align-items:center;justify-content:center;font-family:'Mulish',sans-serif;text-align:center;padding:2rem;background:var(--bg)}.v-card{max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:2.4rem 2rem;box-shadow:var(--shadow)}.v-ico{font-size:2.6rem;margin-bottom:0.6rem}.v-card h1{font-family:'Cormorant Garamond',serif;color:var(--fg);font-size:1.7rem;margin:0 0 0.5rem}.v-card p{color:var(--muted);line-height:1.6;margin:0 0 1.4rem}.v-btn{display:inline-block;padding:0.8rem 1.6rem;border-radius:10px;background:linear-gradient(135deg,#cd853f,#daa520);color:#1a1410;font-weight:700;text-decoration:none}</style></head><body><div class="v-card"><div class="v-ico">${icon}</div><h1>${title}</h1><p>${msg}</p>${cta}</div></body></html>`;
    const ok   = page('✅', 'Имейлът е потвърден!', 'Профилът Ви вече е напълно активен. Благодарим Ви!', '<a class="v-btn" href="/profile.html">Към профила</a>');
    const bad  = page('⚠️', 'Невалидна или изтекла връзка', 'Връзката за потвърждение е невалидна или е изтекла. Влезте в профила си и заявете нова от банера за потвърждение.', '<a class="v-btn" href="/login.html">Вход</a>');
    if (!token || token.length < 32) return res.status(400).send(bad);
    try {
        const user = await dbGet('SELECT id, email, email_verified, verify_token_expires FROM users WHERE verify_token_hash=?', [sha256hex(token)]);
        if (!user || !user.verify_token_expires || user.verify_token_expires < Date.now()) return res.status(400).send(bad);
        if (user.email_verified === 1) return res.send(ok);
        await dbRun('UPDATE users SET email_verified=1, verify_token_hash=NULL, verify_token_expires=NULL WHERE id=?', [user.id]);
        // Now that they're verified, the welcome email is timely.
        sendEmail({ to: user.email, subject: 'Добре дошли в Адресът на историята! 🏛️', html: welcomeEmailHtml() }).catch(() => {});
        res.send(ok);
    } catch (e) {
        console.error('verify-email error:', e.message);
        res.status(500).send(bad);
    }
});

// Resend the verification email (logged-in users who haven't verified yet).
app.post('/api/auth/resend-verification', requireUser, rateLimitAuth, async (req, res) => {
    try {
        const user = await dbGet('SELECT email, email_verified FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        if (user.email_verified === 1) return res.json({ message: 'Имейлът Ви вече е потвърден.', already: true });
        await issueVerification(req.user.sub, user.email);
        res.json({ message: 'Изпратихме нова връзка за потвърждение на имейла Ви.' });
    } catch (e) {
        console.error('resend-verification error:', e.message);
        res.status(500).json({ error: 'Възникна грешка. Опитайте отново.' });
    }
});

// One-click newsletter unsubscribe from the email link (token-verified, no login).
app.get('/api/newsletter/unsubscribe', async (req, res) => {
    const id = String(req.query.u || '');
    const t  = String(req.query.t || '');
    const page = (msg) => `<!doctype html><html lang="bg"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Отписване</title><link rel="stylesheet" href="/assets/css/styles.css?v=X"><style>body{display:flex;min-height:90vh;align-items:center;justify-content:center;font-family:'Mulish',sans-serif;text-align:center;padding:2rem}.u-card{max-width:420px;background:var(--card);border:1px solid var(--border);border-radius:18px;padding:2.2rem}.u-card h1{font-family:'Cormorant Garamond',serif;color:var(--fg)}.u-card a{color:var(--accent-strong);font-weight:700;text-decoration:none}</style></head><body><div class="u-card">${msg}</div></body></html>`;
    try {
        if (!id || t !== unsubToken(id)) {
            return res.status(400).send(page('<h1>Невалидна връзка</h1><p style="color:var(--muted)">Връзката за отписване е невалидна.</p><a href="/index.html">Към началото</a>'));
        }
        await dbRun('UPDATE users SET newsletter=0 WHERE id=?', [id]);
        res.send(page('<h1>Отписахте се</h1><p style="color:var(--muted)">Вече няма да получавате новини по имейл от нас.</p><a href="/index.html">Към началото</a>'));
    } catch (e) {
        console.error('unsubscribe error:', e.message);
        res.status(500).send(page('<h1>Грешка</h1><p style="color:var(--muted)">Опитайте отново по-късно.</p>'));
    }
});

// Change password from the profile (logged-in users): verify the current password,
// then store the new bcrypt hash. Rate-limited to blunt current-password guessing.
app.post('/api/auth/change-password', requireUser, rateLimitAuth, async (req, res) => {
    const current = (req.body && req.body.current_password) || '';
    const next    = (req.body && req.body.new_password) || '';
    if (!current) return res.status(400).json({ error: 'Въведете текущата си парола.' });
    if (passwordIssue(next)) return res.status(400).json({ error: 'Новата парола трябва да е поне 8 символа и да съдържа букви и цифри.' });
    if (current === next) return res.status(400).json({ error: 'Новата парола трябва да е различна от текущата.' });
    try {
        const user = await dbGet('SELECT password_hash FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(404).json({ error: 'User not found' });
        const ok = await bcrypt.compare(current, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Текущата парола е грешна.' });

        const password_hash = await bcrypt.hash(next, BCRYPT_ROUNDS);
        await dbRun('UPDATE users SET password_hash=? WHERE id=?', [password_hash, req.user.sub]);
        res.json({ message: 'Паролата е променена успешно.' });
    } catch (e) {
        console.error('change-password error:', e.message);
        res.status(500).json({ error: 'Възникна грешка. Опитайте отново.' });
    }
});

// Cheap "am I logged in?" check for the frontend.
app.get('/api/auth/me', requireUser, async (req, res) => {
    const user = await dbGet('SELECT id,email,role,display_name,email_verified,totp_enabled FROM users WHERE id=?', [req.user.sub]);
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    res.json({
        id: user.id, email: user.email, role: user.role, display_name: user.display_name,
        email_verified: user.email_verified === 1,
        totp_enabled: user.totp_enabled === 1,
        totp_required: roleRequires2fa(user.role),   // staff must enrol
    });
});

// ── TOTP 2FA management ────────────────────────────────────────────────────────
// Begin enrolment: generate a secret (stored, not yet active) + return the otpauth
// URI and a QR data-URL for the authenticator app. Re-callable until enabled.
app.post('/api/2fa/setup', requireUser, async (req, res) => {
    try {
        const user = await dbGet('SELECT email, totp_enabled FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(401).json({ error: 'Not authenticated' });
        if (user.totp_enabled) return res.status(400).json({ error: 'Двуфакторната автентикация вече е активна.' });
        const secret = authenticator.generateSecret();
        await dbRun('UPDATE users SET totp_secret=? WHERE id=?', [encryptSecret(secret), req.user.sub]);
        const otpauth = authenticator.keyuri(user.email, 'Адресът на историята', secret);
        const qr = await QRCode.toDataURL(otpauth, { margin: 1, width: 220 });
        res.json({ secret, otpauth, qr });
    } catch (e) {
        console.error('2fa setup error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Confirm enrolment with a first valid code → activate 2FA and hand back backup codes
// (shown exactly once).
app.post('/api/2fa/enable', rateLimitAuth, requireUser, async (req, res) => {
    const code = String((req.body && req.body.code) || '').trim();
    try {
        const user = await dbGet('SELECT totp_secret, totp_enabled FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(401).json({ error: 'Not authenticated' });
        if (user.totp_enabled) return res.status(400).json({ error: 'Вече е активна.' });
        const secret = decryptSecret(user.totp_secret);
        if (!secret) return res.status(400).json({ error: 'Започнете настройката отначало.' });
        if (!/^\d{6}$/.test(code) || !authenticator.verify({ token: code, secret })) {
            return res.status(400).json({ error: 'Невалиден код. Опитайте отново.' });
        }
        const { plain, hashes } = makeBackupCodes(10);
        await dbRun('UPDATE users SET totp_enabled=1, totp_backup_codes=? WHERE id=?', [JSON.stringify(hashes), req.user.sub]);
        res.json({ enabled: true, backup_codes: plain });
    } catch (e) {
        console.error('2fa enable error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Disable 2FA after re-auth (current TOTP/backup code OR account password). Staff may
// NOT disable — 2FA is mandatory for them.
app.post('/api/2fa/disable', rateLimitAuth, requireUser, async (req, res) => {
    const code     = (req.body && req.body.code) || '';
    const password = (req.body && req.body.password) || '';
    try {
        const user = await dbGet('SELECT role, password_hash, totp_enabled, totp_secret, totp_backup_codes FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(401).json({ error: 'Not authenticated' });
        if (!user.totp_enabled) return res.status(400).json({ error: 'Не е активна.' });
        if (roleRequires2fa(user.role)) {
            return res.status(403).json({ error: 'Двуфакторната автентикация е задължителна за екипа и не може да бъде изключена.' });
        }
        const byCode = code && check2faCode(user, code).ok;
        const byPass = password && await bcrypt.compare(password, user.password_hash);
        if (!byCode && !byPass) return res.status(401).json({ error: 'Невалиден код или парола.' });
        await dbRun('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_backup_codes=NULL WHERE id=?', [req.user.sub]);
        res.json({ disabled: true });
    } catch (e) {
        console.error('2fa disable error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Regenerate backup codes (invalidates the old set) after a valid current code.
app.post('/api/2fa/backup-codes', rateLimitAuth, requireUser, async (req, res) => {
    const code = String((req.body && req.body.code) || '').trim();
    try {
        const user = await dbGet('SELECT totp_enabled, totp_secret, totp_backup_codes FROM users WHERE id=?', [req.user.sub]);
        if (!user || !user.totp_enabled) return res.status(400).json({ error: 'Двуфакторната автентикация не е активна.' });
        if (!check2faCode(user, code).ok) return res.status(401).json({ error: 'Невалиден код.' });
        const { plain, hashes } = makeBackupCodes(10);
        await dbRun('UPDATE users SET totp_backup_codes=? WHERE id=?', [JSON.stringify(hashes), req.user.sub]);
        res.json({ backup_codes: plain });
    } catch (e) {
        console.error('2fa backup error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Profile: the user's data + their favorite and visited addresses.
app.get('/api/user/profile', requireUser, async (req, res) => {
    try {
        const user = await dbGet('SELECT id,email,role,permissions,display_name,newsletter,created_at,email_verified FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const rows = await dbAll(
            `SELECT a.status, a.created_at AS saved_at,
                    h.id, h.slug, h.name, h.address, h.category, h.images
             FROM user_activity a
             JOIN homes h ON h.id = a.address_id
             WHERE a.user_id = ?
             ORDER BY a.created_at DESC`,
            [req.user.sub]
        );
        const toItem = r => {
            let imgs = []; try { imgs = JSON.parse(r.images || '[]'); } catch {}
            return {
                id: r.id, slug: r.slug, name: r.name, address: r.address || '',
                category: r.category || 'home',
                image: imgs[0] ? (ensureThumb(imgs[0]).thumb || imgs[0].path) : null,
                saved_at: r.saved_at,
            };
        };

        // This user's crowdsourced submissions. For approved ones we pull the
        // live thumbnail from homes; pending ones use the protected image route.
        const subs = await dbAll(
            `SELECT p.id, p.title, p.description, p.city, p.address, p.category, p.status,
                    p.created_at, p.image_path, p.result_slug, p.moderation_note, p.denied,
                    h.images AS live_images
             FROM pending_addresses p
             LEFT JOIN homes h ON h.slug = p.result_slug
             WHERE p.user_id = ?
             ORDER BY p.created_at DESC`,
            [req.user.sub]
        );
        let photosAdded = 0;   // photos this user contributed that are live on the site
        const submissions = subs.map(s => {
            let image = null;
            const pendingImgs = parsePendingImages(s.image_path);
            let images = [];   // editable photo list (pending/rejected use the protected route)
            if (s.status === 'approved' && s.live_images) {
                try {
                    const li = JSON.parse(s.live_images);
                    if (li[0]) image = ensureThumb(li[0]).thumb || li[0].path;
                    photosAdded += li.length;
                } catch {}
            } else {
                if (pendingImgs[0]) image = pendingThumbUrl(pendingImgs[0]);
                images = pendingImgs.map((u, i) => ({ thumb: pendingThumbUrl(u), download: '/api/pending-image/' + s.id + '?i=' + i }));
            }
            return {
                id: s.id, title: s.title, category: s.category || 'home',
                description: s.description || '', city: s.city || '', address: s.address || '',
                status: s.status, denied: !!s.denied, created_at: s.created_at,
                moderation_note: s.moderation_note || '',
                photo_count: (s.status === 'approved' && s.live_images) ? (() => { try { return JSON.parse(s.live_images).length; } catch { return 0; } })() : pendingImgs.length,
                slug: s.result_slug || null, image, images,
            };
        });

        res.json({
            id:            user.id,
            email:         user.email,
            display_name:  user.display_name || null,
            newsletter:    user.newsletter === 1,
            email_verified: user.email_verified === 1,
            role:          user.role,
            permissions:   (() => { try { return JSON.parse(user.permissions || '[]'); } catch { return []; } })(),
            created_at:    user.created_at,
            favorites:     rows.filter(r => r.status === 'favorite').map(toItem),
            visited:       rows.filter(r => r.status === 'visited').map(toItem),
            submissions:   submissions,
            submitted_count: submissions.length,
            approved_count:  submissions.filter(s => s.status === 'approved').length,
            pending_count:   submissions.filter(s => s.status === 'pending').length,
            correction_count: submissions.filter(s => s.status === 'rejected' && !s.denied).length,
            denied_count:    submissions.filter(s => s.status === 'rejected' && s.denied).length,
            photos_added:    photosAdded,
        });
    } catch (e) {
        console.error('profile error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Update the user's editable profile fields (currently just display name).
app.put('/api/user/profile', requireUser, async (req, res) => {
    try {
        const b = req.body || {};
        // Update only the fields that were actually provided.
        if (b.display_name !== undefined) {
            const name = sanitizeText(b.display_name, 60);
            await dbRun('UPDATE users SET display_name=? WHERE id=?', [name || null, req.user.sub]);
        }
        if (b.newsletter !== undefined) {
            const nl = (b.newsletter === true || b.newsletter === 1) ? 1 : 0;
            await dbRun('UPDATE users SET newsletter=? WHERE id=?', [nl, req.user.sub]);
        }
        const row = await dbGet('SELECT display_name, newsletter FROM users WHERE id=?', [req.user.sub]);
        res.json({ display_name: row.display_name || null, newsletter: row.newsletter === 1 });
    } catch (e) {
        console.error('profile update error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GDPR data portability: download everything we store about this user as JSON.
app.get('/api/user/export', requireUser, async (req, res) => {
    try {
        const user = await dbGet('SELECT email,display_name,role,created_at FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const activity = await dbAll(
            `SELECT a.status, a.created_at AS saved_at, h.name, h.address, h.slug
             FROM user_activity a JOIN homes h ON h.id = a.address_id
             WHERE a.user_id = ? ORDER BY a.created_at DESC`,
            [req.user.sub]
        );
        const subs = await dbAll(
            `SELECT title, category, status, created_at, result_slug
             FROM pending_addresses WHERE user_id = ? ORDER BY created_at DESC`,
            [req.user.sub]
        );
        const place = a => ({ name: a.name, address: a.address || '', slug: a.slug, saved_at: a.saved_at });

        const data = {
            exported_at: new Date().toISOString(),
            account: {
                email:        user.email,
                display_name: user.display_name || null,
                role:         user.role,
                member_since: user.created_at,
            },
            favorites:   activity.filter(a => a.status === 'favorite').map(place),
            visited:     activity.filter(a => a.status === 'visited').map(place),
            submissions: subs.map(s => ({
                title: s.title, category: s.category, status: s.status,
                created_at: s.created_at, slug: s.result_slug || null,
            })),
        };
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', 'attachment; filename="moite-danni.json"');
        res.send(JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('export error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// GDPR right to erasure: delete the account after re-confirming the password.
// Cascades remove favorites/visited + pending submissions (FK ON DELETE CASCADE);
// we also clean up R2 images for still-pending submissions. Approved content stays
// published in `homes` (it is no longer personal data once curated and live).
app.post('/api/user/delete', requireUser, async (req, res) => {
    const password = (req.body && req.body.password) || '';
    const code     = (req.body && req.body.code) || '';
    try {
        const user = await dbGet('SELECT id, password_hash, totp_enabled, totp_secret, totp_backup_codes FROM users WHERE id=?', [req.user.sub]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) return res.status(401).json({ error: 'Грешна парола' });

        // Critical action: when 2FA is on, also require a valid code.
        if (user.totp_enabled) {
            const r = check2faCode(user, code);
            if (!r.ok) return res.status(401).json({ error: 'TWOFA_REQUIRED', message: 'Въведете код от приложението за автентикация.' });
            if (r.backupRemaining !== null) await dbRun('UPDATE users SET totp_backup_codes=? WHERE id=?', [r.backupRemaining, user.id]);
        }

        const pend = await dbAll(
            "SELECT image_path FROM pending_addresses WHERE user_id=? AND status='pending'",
            [user.id]
        );
        for (const row of pend) {
            for (const url of parsePendingImages(row.image_path)) await deleteR2(url);
        }

        await dbRun('DELETE FROM users WHERE id=?', [user.id]);  // cascades to activity + pending
        res.clearCookie(AUTH_COOKIE, { httpOnly: true, sameSite: 'strict', secure: COOKIE_SECURE, path: '/' });
        res.json({ deleted: true });
    } catch (e) {
        console.error('account delete error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Activity: toggle an address as 'favorite' or 'visited' on/off for this user.
app.post('/api/user/activity', requireUser, rateLimitActivity, async (req, res) => {
    const addressRef = String((req.body && req.body.address_id) || '').trim();
    const status     = (req.body && req.body.status) || '';
    if (!addressRef) return res.status(400).json({ error: 'address_id is required' });
    if (status !== 'favorite' && status !== 'visited') {
        return res.status(400).json({ error: "status must be 'favorite' or 'visited'" });
    }
    try {
        // Accept either an id or a slug; resolve to the canonical home id.
        const addr = await dbGet('SELECT id FROM homes WHERE id=? OR slug=?', [addressRef, addressRef]);
        if (!addr) return res.status(404).json({ error: 'Address not found' });

        const existing = await dbGet(
            'SELECT id FROM user_activity WHERE user_id=? AND address_id=? AND status=?',
            [req.user.sub, addr.id, status]
        );
        if (existing) {
            await dbRun('DELETE FROM user_activity WHERE id=?', [existing.id]);
            return res.json({ address_id: addr.id, status, active: false });
        }
        await dbRun(
            'INSERT INTO user_activity (user_id,address_id,status,created_at) VALUES (?,?,?,?)',
            [req.user.sub, addr.id, status, new Date().toISOString()]
        );
        res.json({ address_id: addr.id, status, active: true });
    } catch (e) {
        console.error('activity error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Read this user's saved state for a single address (for toggle buttons).
app.get('/api/user/activity', requireUser, async (req, res) => {
    const ref = String(req.query.address_id || '').trim();
    if (!ref) return res.status(400).json({ error: 'address_id is required' });
    try {
        const addr = await dbGet('SELECT id FROM homes WHERE id=? OR slug=?', [ref, ref]);
        if (!addr) return res.status(404).json({ error: 'Address not found' });
        const rows = await dbAll(
            'SELECT status FROM user_activity WHERE user_id=? AND address_id=?',
            [req.user.sub, addr.id]
        );
        const set = new Set(rows.map(r => r.status));
        res.json({ address_id: addr.id, favorite: set.has('favorite'), visited: set.has('visited') });
    } catch (e) {
        console.error('activity status error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── Crowdsourced submissions ──────────────────────────────────────────────────

// Pending images live in R2 under the `pending/` prefix. image_path stores the
// full public URL; these helpers derive the thumbnail URL and the R2 object key.
function isHttpUrl(s) { return /^https?:\/\//i.test(s || ''); }
function pendingThumbUrl(url) {
    return url ? url.replace(/\.jpg$/i, '_thumb.jpg') : null;
}
// pending_addresses.image_path holds a JSON array of R2 URLs (new), or a single
// URL / legacy disk filename (old). Always return an array of usable R2 URLs.
function parsePendingImages(image_path) {
    if (!image_path) return [];
    let list;
    if (image_path.trim().charAt(0) === '[') {
        try { list = JSON.parse(image_path); } catch { list = []; }
    } else {
        list = [image_path];
    }
    return (Array.isArray(list) ? list : []).filter(isHttpUrl);
}
function r2KeyFromUrl(url) {
    if (!url || url.indexOf(R2_PUBLIC_URL + '/') !== 0) return null;
    return url.substring(R2_PUBLIC_URL.length + 1); // e.g. "pending/abc.jpg"
}
async function deleteR2(url) {
    const key = r2KeyFromUrl(url);
    if (!key) return;
    try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); }
    catch (e) { console.warn('R2 delete failed for', key, '-', e.message); }
}

// Resolve the email we should notify for a submission row: the owning user's email
// for registered submissions, or the stored guest_email for anonymous ones.
async function submissionRecipientEmail(row) {
    if (!row) return null;
    if (row.user_id) {
        try { const u = await dbGet('SELECT email FROM users WHERE id=?', [row.user_id]); return (u && u.email) || null; }
        catch { return null; }
    }
    return row.guest_email || null;
}

// Submit a suggestion (logged-in users). Accepts text fields + up to MAX_PHOTOS images.
app.post('/api/suggest', requireUser, requireVerified, requireNotBanned, rateLimitSuggest, acceptPhotos('images'), async (req, res) => {
    try {
        const b = req.body || {};
        // Simplified form: the suggester gives an exact address, an optional history/
        // comment and photos. Title/category/coordinates are set by a moderator on
        // review, so we derive a placeholder title from the address (NOT NULL column).
        const description = sanitizeText(b.description, 5000);
        const city        = sanitizeText(b.city, 120);
        const address     = sanitizeText(b.address, 200);
        const title = (address || description.slice(0, 80) || 'Предложение').slice(0, 200);
        if (!address && !description && !(req.files && req.files.length)) {
            return res.status(400).json({ error: 'Моля, добавете адрес, описание или снимка.' });
        }
        const category = normCategory(b.category);   // defaults to 'home'
        const lat = (b.lat !== undefined && b.lat !== '' && isFinite(+b.lat)) ? +b.lat : null;
        const lng = (b.lng !== undefined && b.lng !== '' && isFinite(+b.lng)) ? +b.lng : null;

        // Photo ownership claim → drives the watermark on approval. The name only
        // matters when the suggester ticked "this photo is mine".
        const ownsImage  = (b.owns_image === 'true' || b.owns_image === true || b.owns_image === '1') ? 1 : 0;
        const authorName = ownsImage ? sanitizeText(b.author_name, 80) : '';

        // Anti-spam: cap how many pending submissions one user can have at once.
        const cnt = await dbGet("SELECT COUNT(*) AS n FROM pending_addresses WHERE user_id=? AND status='pending'", [req.user.sub]);
        if (cnt && cnt.n >= 20) return res.status(429).json({ error: 'Достигнахте лимита на чакащи предложения. Изчакайте модерация.' });

        // Re-encode each upload (strips EXIF, normalises to JPEG, caps size) and
        // store directly in R2 under `pending/`. Each photo is processed in its own
        // try/catch so one corrupt file can't fail the whole submission.
        const urls = [];
        for (const f of (req.files || [])) {
            try {
                const base = crypto.randomBytes(16).toString('hex');
                const url  = await uploadPhotoToR2(f.buffer, `pending/${base}`);
                urls.push(url);
            } catch (e) {
                console.warn('suggest: skipped a bad photo -', e.message);
            }
        }
        const image_path = urls.length ? JSON.stringify(urls) : null;

        const id  = crypto.randomUUID();
        const now = new Date().toISOString();
        await dbRun(
            `INSERT INTO pending_addresses (id,user_id,title,description,city,address,lat,lng,category,image_path,status,created_at,owns_image,author_name)
             VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
            [id, req.user.sub, title, description || null, city || null, address || null, lat, lng, category, image_path, now, ownsImage, authorName || null]
        );
        res.status(201).json({ id, status: 'pending', photos: urls.length });

        // TRIGGER 1: confirm we received the submission (fire-and-forget).
        dbGet('SELECT email FROM users WHERE id=?', [req.user.sub])
            .then(u => u && u.email && sendEmail({
                to: u.email,
                subject: 'Получихме Вашето предложение за адрес 📨',
                html: submissionReceivedEmailHtml(title),
            }))
            .catch(() => {});
    } catch (e) {
        console.error('suggest error:', e.message);
        res.status(500).json({ error: 'Грешка при изпращане. Опитайте отново.' });
    }
});

// Submit a suggestion as an ANONYMOUS GUEST (no account). Simplified form: an email
// (so we can notify them and later auto-link the post when they register), a free-text
// address, a history/comment and photos. Category & coordinates are filled by an admin
// during moderation. Rate-limited per IP (rateLimitSuggest falls back to IP when there
// is no logged-in user).
app.post('/api/suggest-guest', rateLimitSuggest, acceptPhotos('images'), async (req, res) => {
    try {
        const b = req.body || {};
        const email = String(b.email || '').trim().toLowerCase();
        if (!validEmail(email)) return res.status(400).json({ error: 'Моля, въведете валиден имейл адрес.' });

        const address     = sanitizeText(b.address, 200);
        const description = sanitizeText(b.description, 5000);
        // Guests don't supply a title; derive one from the address so moderators have a
        // label. The admin sets the proper name on approval. Never empty (title is NOT NULL).
        const title = (address || description.slice(0, 80) || 'Предложение от гост').slice(0, 200);
        if (!address && !description && !(req.files && req.files.length)) {
            return res.status(400).json({ error: 'Моля, добавете адрес, описание или снимка.' });
        }

        const ownsImage  = (b.owns_image === 'true' || b.owns_image === true || b.owns_image === '1') ? 1 : 0;
        const authorName = ownsImage ? sanitizeText(b.author_name, 80) : '';

        // Anti-spam: cap pending submissions per guest email.
        const cnt = await dbGet("SELECT COUNT(*) AS n FROM pending_addresses WHERE guest_email=? AND status='pending'", [email]);
        if (cnt && cnt.n >= 10) return res.status(429).json({ error: 'Достигнахте лимита на чакащи предложения за този имейл. Изчакайте модерация.' });

        const urls = [];
        for (const f of (req.files || [])) {
            try {
                const base = crypto.randomBytes(16).toString('hex');
                urls.push(await uploadPhotoToR2(f.buffer, `pending/${base}`));
            } catch (e) { console.warn('guest suggest: skipped a bad photo -', e.message); }
        }
        const image_path = urls.length ? JSON.stringify(urls) : null;

        const id  = crypto.randomUUID();
        const now = new Date().toISOString();
        await dbRun(
            `INSERT INTO pending_addresses (id,user_id,guest_email,title,description,city,address,lat,lng,category,image_path,status,created_at,owns_image,author_name)
             VALUES (?,NULL,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
            [id, email, title, description || null, null, address || null, null, null, 'home', image_path, now, ownsImage, authorName || null]
        );
        res.status(201).json({ id, status: 'pending', photos: urls.length });

        // TRIGGER 1: confirm receipt to the guest (fire-and-forget).
        sendEmail({
            to: email,
            subject: 'Получихме Вашето предложение за адрес 📨',
            html: submissionReceivedEmailHtml(title),
        }).catch(() => {});
    } catch (e) {
        console.error('guest suggest error:', e.message);
        res.status(500).json({ error: 'Грешка при изпращане. Опитайте отново.' });
    }
});

// Correct & resubmit a submission that a moderator sent back ('rejected'). Only the
// owner may edit, and only while it's in the 'rejected' state. Updates the text
// fields, optionally replaces the photos, clears the note and re-queues it (pending).
app.put('/api/suggest/:id', requireUser, requireVerified, requireNotBanned, rateLimitSuggest, acceptPhotos('images'), async (req, res) => {
    try {
        const row = await dbGet('SELECT * FROM pending_addresses WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Предложението не е намерено' });
        if (row.user_id !== req.user.sub) return res.status(403).json({ error: 'Нямате достъп' });
        if (row.status !== 'rejected' || row.denied) return res.status(409).json({ error: 'Това предложение не подлежи на редакция' });

        const b = req.body || {};
        const title = sanitizeText(b.title, 200) || sanitizeText(row.title, 200);
        if (!title) return res.status(400).json({ error: 'Заглавието е задължително' });
        const category    = normCategory(b.category || row.category);
        const description = (b.description !== undefined ? sanitizeText(b.description, 5000) : row.description) || null;
        const city        = (b.city    !== undefined ? sanitizeText(b.city, 120)    : row.city) || null;
        const address     = (b.address !== undefined ? sanitizeText(b.address, 200) : row.address) || null;

        // If the user uploaded new photos, replace the old set (delete old from R2);
        // otherwise keep what was there. This matches the common "the photos were bad" case.
        let image_path = row.image_path;
        if (req.files && req.files.length) {
            for (const u of parsePendingImages(row.image_path)) { await deleteR2(u); await deleteR2(pendingThumbUrl(u)); }
            const urls = [];
            for (const f of req.files) {
                try { urls.push(await uploadPhotoToR2(f.buffer, `pending/${crypto.randomBytes(16).toString('hex')}`)); }
                catch (e) { console.warn('resubmit: skipped a bad photo -', e.message); }
            }
            image_path = urls.length ? JSON.stringify(urls) : null;
        }

        await dbRun(
            `UPDATE pending_addresses
             SET title=?, description=?, city=?, address=?, category=?, image_path=?,
                 status='pending', moderation_note=NULL, reviewed_at=NULL, reviewed_by=NULL, created_at=?
             WHERE id=?`,
            [title, description, city, address, category, image_path, new Date().toISOString(), row.id]
        );
        res.json({ id: row.id, status: 'pending' });
    } catch (e) {
        console.error('resubmit error:', e.message);
        res.status(500).json({ error: 'Грешка при изпращане. Опитайте отново.' });
    }
});

// Download a pending image (proxied from R2 so the browser forces a save, and
// access stays gated to the submitter or a moderator). Rendering still uses the
// direct R2 URL returned by /api/admin/pending.
app.get('/api/pending-image/:id', requireUser, async (req, res) => {
    try {
        const row = await dbGet('SELECT user_id, image_path FROM pending_addresses WHERE id=?', [req.params.id]);
        if (!row || !row.image_path) return res.status(404).end();

        let allowed = row.user_id === req.user.sub;
        if (!allowed) {
            const u = await dbGet('SELECT role, permissions FROM users WHERE id=?', [req.user.sub]);
            let perms = []; try { perms = JSON.parse((u && u.permissions) || '[]'); } catch {}
            allowed = u && (u.role === 'owner' || u.role === 'moderator' || perms.includes('approve:photos'));
        }
        if (!allowed) return res.status(403).end();

        const imgs = parsePendingImages(row.image_path);
        const idx  = Math.max(0, parseInt(req.query.i, 10) || 0);
        const target = imgs[idx];
        if (!target) return res.status(404).end();

        const r2resp = await fetch(target);
        if (!r2resp.ok) return res.status(404).end();
        const buf = Buffer.from(await r2resp.arrayBuffer());
        res.setHeader('Content-Disposition', 'attachment; filename="predlozhenie-' + (idx + 1) + '.jpg"');
        res.setHeader('Cache-Control', 'private, max-age=300');
        res.type('image/jpeg');
        res.send(buf);
    } catch (e) {
        res.status(500).end();
    }
});

// Moderation queue (moderators/owners).
app.get('/api/admin/pending', requireModerator, async (req, res) => {
    const status   = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
    const isAdmin  = roleRank(req.user.role) >= ROLE_RANK.admin;   // moderators can't see emails
    const wantHidden = isAdmin && req.query.hidden === 'true';      // admin-only "hidden history" view
    try {
        const rows = await dbAll(
            `SELECT p.id,p.title,p.description,p.city,p.address,p.lat,p.lng,p.category,p.image_path,
                    p.status,p.created_at,p.result_slug,p.owns_image,p.author_name,p.denied,p.moderation_note,
                    p.hidden_from_history, COALESCE(u.email, p.guest_email) AS user_email,
                    (p.user_id IS NULL) AS is_guest
             FROM pending_addresses p LEFT JOIN users u ON u.id = p.user_id
             WHERE p.status = ? AND p.hidden_from_history = ? ORDER BY p.created_at ASC LIMIT 500`,
            [status, wantHidden ? 1 : 0]
        );
        // One query for all feedback on the listed submissions, grouped by submission id.
        const ids = rows.map(r => r.id);
        const fbBy = {};
        if (ids.length) {
            const fb = await dbAll(
                `SELECT submission_id, author_name, comment, created_at FROM submission_feedback
                 WHERE submission_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at ASC`, ids);
            for (const f of fb) (fbBy[f.submission_id] = fbBy[f.submission_id] || []).push({ author: f.author_name || 'Модератор', comment: f.comment, created_at: f.created_at });
        }
        res.json(rows.map(r => {
            const imgs = parsePendingImages(r.image_path);  // array of R2 URLs (legacy paths excluded)
            const images = imgs.map((u, i) => ({
                url: u, thumb: pendingThumbUrl(u), download: '/api/pending-image/' + r.id + '?i=' + i,
            }));
            return {
                id: r.id, title: r.title, description: r.description || '',
                city: r.city || '', address: r.address || '',
                lat: r.lat, lng: r.lng, category: r.category || 'home',
                status: r.status, denied: !!r.denied, created_at: r.created_at,
                moderation_note: r.moderation_note || '',
                user_email: isAdmin ? r.user_email : null,        // moderators never see private emails
                is_guest: !!r.is_guest,                           // anonymous (no account) submission
                slug: r.result_slug || null,
                owns_image: !!r.owns_image, author_name: r.author_name || '',
                hidden_from_history: !!r.hidden_from_history,
                feedback: fbBy[r.id] || [],
                images: images,
                image: images[0] ? images[0].url : null,         // first photo (for the card)
                image_thumb: images[0] ? images[0].thumb : null,
            };
        }));
    } catch (e) {
        console.error('pending list error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Internal moderator feedback on a PENDING submission (moderator+; not shown to the
// submitter). Admins/owners read these before approving/rejecting.
app.post('/api/admin/feedback/:id', requireModerator, async (req, res) => {
    const comment = sanitizeText((req.body && req.body.comment) || '', 1000);
    if (!comment) return res.status(400).json({ error: 'Бележката не може да е празна.' });
    try {
        const sub = await dbGet('SELECT id, status FROM pending_addresses WHERE id=?', [req.params.id]);
        if (!sub) return res.status(404).json({ error: 'Предложението не е намерено' });
        if (sub.status !== 'pending') return res.status(409).json({ error: 'Бележки се добавят само към чакащи предложения.' });
        const me = await dbGet('SELECT display_name, email FROM users WHERE id=?', [req.user.sub]);
        const author = (me && (me.display_name || me.email)) || 'Модератор';
        const now = new Date().toISOString();
        await dbRun('INSERT INTO submission_feedback (submission_id,author_id,author_name,comment,created_at) VALUES (?,?,?,?,?)',
            [sub.id, req.user.sub, author, comment, now]);
        res.status(201).json({ author, comment, created_at: now });
    } catch (e) {
        console.error('feedback error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Hide a PROCESSED submission from the moderation history (admin+). Reversible.
app.post('/api/admin/submission/:id/hide', requireRole('admin'), async (req, res) => {
    const hide = !(req.body && req.body.unhide === true);
    try {
        const row = await dbGet('SELECT id, status FROM pending_addresses WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Submission not found' });
        if (row.status === 'pending') return res.status(409).json({ error: 'Само обработени предложения могат да се скриват.' });
        await dbRun('UPDATE pending_addresses SET hidden_from_history=? WHERE id=?', [hide ? 1 : 0, row.id]);
        res.json({ id: row.id, hidden_from_history: hide });
    } catch (e) {
        console.error('hide submission error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Permanently delete a submission's record + its R2 pending photos + feedback (admin+).
// Frees storage. Does NOT touch the live home that may have been published from it.
app.delete('/api/admin/submission/:id', requireRole('admin'), async (req, res) => {
    try {
        const row = await dbGet('SELECT id, image_path FROM pending_addresses WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Submission not found' });
        for (const u of parsePendingImages(row.image_path)) { await deleteR2(u); await deleteR2(pendingThumbUrl(u)); }
        await dbRun('DELETE FROM submission_feedback WHERE submission_id=?', [row.id]);
        await dbRun('DELETE FROM pending_addresses WHERE id=?', [row.id]);
        res.json({ id: row.id, deleted: true });
    } catch (e) {
        console.error('delete submission error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Approve / reject / return a submission. ADMIN+ only - moderators are read-only and
// can only leave internal feedback (above). Admins may edit fields, keep/remove the
// submitter's photos, add their own, and set tags / sources / dates.
app.post('/api/admin/moderate/:id', requireRole('admin'), acceptPhotos('images'), async (req, res) => {
    const b = req.body || {};
    const action = b.action || '';
    if (['approve', 'reject', 'deny'].indexOf(action) < 0) {
        return res.status(400).json({ error: "action must be 'approve', 'reject' or 'deny'" });
    }
    try {
        const row = await dbGet('SELECT * FROM pending_addresses WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Submission not found' });
        if (row.status !== 'pending') return res.status(409).json({ error: 'Това предложение вече е обработено' });

        const now = new Date().toISOString();
        const pendingUrls = parsePendingImages(row.image_path);

        // ── Reject / send back for correction ──
        // We keep the submitter's photos so they can fix the submission and resubmit
        // (the photos may be fine; often only one needs replacing). An optional note
        // gives the user instructions on what to correct.
        if (action === 'reject') {
            const note = sanitizeText(b.note, 1000) || null;
            await dbRun("UPDATE pending_addresses SET status='rejected', denied=0, reviewed_at=?, reviewed_by=?, moderation_note=? WHERE id=?",
                [now, req.user.sub, note, row.id]);
            res.json({ id: row.id, status: 'rejected', denied: 0, note });
            // TRIGGER 3: returned for correction - email the submitter the admin's note.
            submissionRecipientEmail(row)
                .then(to => to && sendEmail({
                    to, subject: 'Вашето предложение се нуждае от корекция ✍️',
                    html: correctionEmailHtml(row.title, note),
                }))
                .catch(() => {});
            return;
        }

        // ── Deny entirely: a final rejection. Delete the photos from R2 and mark the
        // row denied so the submitter sees it as rejected and cannot resubmit. ──
        if (action === 'deny') {
            const note = sanitizeText(b.note, 1000) || null;
            for (const u of pendingUrls) { await deleteR2(u); await deleteR2(pendingThumbUrl(u)); }
            await dbRun("UPDATE pending_addresses SET status='rejected', denied=1, image_path=NULL, reviewed_at=?, reviewed_by=?, moderation_note=? WHERE id=?",
                [now, req.user.sub, note, row.id]);
            res.json({ id: row.id, status: 'rejected', denied: 1, note });
            // TRIGGER 4: rejected outright - email the submitter the admin's reason.
            submissionRecipientEmail(row)
                .then(to => to && sendEmail({
                    to, subject: 'Относно Вашето предложение за адрес',
                    html: rejectionEmailHtml(row.title, note),
                }))
                .catch(() => {});
            return;
        }

        // ── Approve, applying moderator edits ──
        const title       = sanitizeText(b.title, 200) || sanitizeText(row.title, 200);
        const description = (b.description !== undefined ? sanitizeText(b.description, 5000) : sanitizeText(row.description, 5000)) || null;
        const city        = (b.city    !== undefined ? sanitizeText(b.city, 120)    : sanitizeText(row.city, 120));
        const addressStr  = (b.address !== undefined ? sanitizeText(b.address, 200) : sanitizeText(row.address, 200));
        const category    = normCategory(b.category || row.category);
        const lat = (b.lat !== undefined) ? (b.lat !== '' && isFinite(+b.lat) ? +b.lat : null) : row.lat;
        const lng = (b.lng !== undefined) ? (b.lng !== '' && isFinite(+b.lng) ? +b.lng : null) : row.lng;
        const credit = sanitizeText(b.credit, 120) || null;

        // Tags (comma-separated) and sources (semicolon/newline-separated), like the admin panel.
        const tags    = sanitizeText(b.tags, 500).split(',').map(s => s.trim()).filter(Boolean).slice(0, 30);
        const sources = sanitizeText(b.sources, 3000).split(/[;\n]/).map(s => s.trim()).filter(Boolean).slice(0, 30);

        // Dates: moderator picks 2 dates (person/building) or 1 (event) in the UI;
        // we accept whatever YYYY-MM-DD values arrive.
        const cleanDate = d => { d = String(d || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null; };
        const birth_date = cleanDate(b.date_start != null ? b.date_start : b.birth_date);
        const death_date = cleanDate(b.date_end   != null ? b.date_end   : b.death_date);
        const date_label = sanitizeText(b.date_label || '', 60) || null;

        const slug = await uniqueHomeSlug(slugifyTitle(title));

        // Which pending photos to keep (defaults to all). Only real pending URLs
        // are honoured - arbitrary URLs in the request are ignored.
        let keep = pendingUrls;
        if (b.keptImages !== undefined) {
            try { const arr = JSON.parse(b.keptImages); keep = Array.isArray(arr) ? arr.filter(u => pendingUrls.includes(u)) : []; }
            catch { keep = []; }
        }

        // Watermark only when the suggester claimed the photos as their own - then
        // it reads "© <author> via Адресът на историята". Unclaimed photos get NO
        // watermark (we may not own them). A moderator can override the name via the
        // 'wm_creator' field; an explicit empty value forces no watermark.
        let wmCreator = (row.owns_image && row.author_name) ? row.author_name : '';
        if (b.wm_creator !== undefined) wmCreator = sanitizeText(b.wm_creator, 80);
        const finishImage = async (rawBuf) => {
            const out = wmCreator ? await buildWatermark(rawBuf, wmCreator) : rawBuf;
            return uploadPhotoToR2(out, `img_sug_${slug}_${Date.now()}_${randomSuffix()}`);
        };

        // Build the live image list: kept pending photos + new files.
        const images = [];
        for (const url of keep) {
            try {
                const pr = await fetch(url);
                if (!pr.ok) continue;
                const liveUrl = await finishImage(Buffer.from(await pr.arrayBuffer()));
                images.push({ path: liveUrl, thumb: pendingThumbUrl(liveUrl), caption: '', alt: title });
            } catch (e) { console.warn('promote kept photo failed:', e.message); }
        }
        for (const f of (req.files || [])) {
            try {
                const liveUrl = await finishImage(f.buffer);
                images.push({ path: liveUrl, thumb: pendingThumbUrl(liveUrl), caption: '', alt: title });
            } catch (e) { console.warn('add photo failed:', e.message); }
        }

        await dbRun(
            `INSERT INTO homes
                (id,slug,name,name_lower,biography,address,lat,lng,images,photo_date,
                 sources,tags,published,created_at,updated_at,portrait_url,birth_date,death_date,date_label,category,credited_to)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [slug, slug, title, (title || '').toLowerCase(), description,
             (addressStr || city) || null, lat, lng,
             JSON.stringify(images), null, JSON.stringify(sources), JSON.stringify(tags),
             1, now, now, null, birth_date, death_date, date_label, category, credit]
        );
        await dbRun("UPDATE pending_addresses SET status='approved', reviewed_at=?, reviewed_by=?, result_slug=? WHERE id=?",
            [now, req.user.sub, slug, row.id]);

        // Delete ALL pending photos from R2 (kept ones now live under img_sug_ keys).
        for (const u of pendingUrls) { await deleteR2(u); await deleteR2(pendingThumbUrl(u)); }
        cache.clear();
        res.json({ id: row.id, status: 'approved', slug, photos: images.length });

        // TRIGGER 2: notify the suggester (registered user or guest) that it's now live.
        submissionRecipientEmail(row)
            .then(to => to && sendEmail({
                to,
                subject: 'Поздравления! Вашият адрес е одобрен 🎉',
                html: approvalEmailHtml(title, `${DOMAIN}/address.html?slug=${encodeURIComponent(slug)}`),
            }))
            .catch(() => {});
    } catch (e) {
        console.error('moderate error:', e.message);
        res.status(500).json({ error: 'Грешка при обработка. Опитайте отново.' });
    }
});

// ── User / role management (owner only) ───────────────────────────────────────
// ── User management ──────────────────────────────────────────────────────────
// Visible to admins+ (admins see emails/profiles; moderators have no access here).
app.get('/api/admin/users', requireRole('admin'), async (req, res) => {
    try {
        const rows = await dbAll(
            `SELECT u.id, u.email, u.role, u.display_name, u.created_at, u.banned_until,
                    (SELECT COUNT(*) FROM pending_addresses p WHERE p.user_id = u.id) AS submissions
             FROM users u ORDER BY
                CASE u.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'moderator' THEN 2 ELSE 3 END, u.created_at ASC
             LIMIT 2000`
        );
        res.json(rows.map(r => ({
            id: r.id, email: r.email, role: r.role, display_name: r.display_name || null,
            created_at: r.created_at, submissions: r.submissions,
            banned_until: Number(r.banned_until) || 0, banned: isBanned(r.banned_until),
            self: r.id === req.user.sub,
        })));
    } catch (e) {
        console.error('users list error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Change a user's role. Admins may only grant/revoke Moderator (on users/moderators);
// only Owners may grant/revoke Admin or Owner, or touch an existing admin/owner.
app.put('/api/admin/users/:id/role', requireRole('admin'), async (req, res) => {
    const role = (req.body && req.body.role) || '';
    if (!['user', 'moderator', 'admin', 'owner'].includes(role)) {
        return res.status(400).json({ error: 'Невалидна роля' });
    }
    if (req.params.id === req.user.sub) {
        return res.status(400).json({ error: 'Не можете да променяте собствената си роля' });
    }
    const actorRank = roleRank(req.user.role);
    try {
        const target = await dbGet('SELECT id, role FROM users WHERE id=?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'Потребителят не е намерен' });
        // Non-owners (admins) may only manage moderators/users and never reach admin+.
        if (actorRank < ROLE_RANK.owner) {
            if (roleRank(target.role) >= ROLE_RANK.admin) {
                return res.status(403).json({ error: 'Само собственик може да променя администратори.' });
            }
            if (roleRank(role) >= ROLE_RANK.admin) {
                return res.status(403).json({ error: 'Само собственик може да назначава администратори.' });
            }
        }
        await dbRun('UPDATE users SET role=? WHERE id=?', [role, target.id]);
        res.json({ id: target.id, role });
    } catch (e) {
        console.error('role update error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Rename a user (owner only).
app.put('/api/admin/users/:id/display-name', requireRole('owner'), async (req, res) => {
    const name = sanitizeText((req.body && req.body.display_name) || '', 60);
    try {
        const r = await dbRun('UPDATE users SET display_name=? WHERE id=?', [name || null, req.params.id]);
        if (!r.changes) return res.status(404).json({ error: 'Потребителят не е намерен' });
        res.json({ id: req.params.id, display_name: name || null });
    } catch (e) {
        console.error('display-name update error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Ban / timeout a user, or lift it (owner only). Blocks them from submitting content.
//   body: { unban:true } | { permanent:true } | { days:N }
app.post('/api/admin/users/:id/ban', requireRole('owner'), async (req, res) => {
    if (req.params.id === req.user.sub) {
        return res.status(400).json({ error: 'Не можете да блокирате себе си.' });
    }
    const b = req.body || {};
    let until;
    if (b.unban === true) until = 0;
    else if (b.permanent === true) until = PERMANENT_BAN;
    else {
        const days = Number(b.days);
        if (!days || days <= 0) return res.status(400).json({ error: 'Невалиден период.' });
        until = Date.now() + days * 24 * 3600 * 1000;
    }
    try {
        const target = await dbGet('SELECT id, role FROM users WHERE id=?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'Потребителят не е намерен' });
        if (target.role === 'owner') return res.status(403).json({ error: 'Не можете да блокирате собственик.' });
        await dbRun('UPDATE users SET banned_until=? WHERE id=?', [until, target.id]);
        res.json({ id: target.id, banned_until: until, banned: isBanned(until) });
    } catch (e) {
        console.error('ban error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Reset (disable) a user's 2FA — owner recovery for a locked-out staff member who lost
// their authenticator AND backup codes. They will be prompted to re-enrol on next use.
app.post('/api/admin/users/:id/reset-2fa', requireRole('owner'), async (req, res) => {
    if (req.params.id === req.user.sub) {
        return res.status(400).json({ error: 'Управлявайте собствената си 2FA от настройките.' });
    }
    try {
        const target = await dbGet('SELECT id FROM users WHERE id=?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'Потребителят не е намерен' });
        await dbRun('UPDATE users SET totp_enabled=0, totp_secret=NULL, totp_backup_codes=NULL WHERE id=?', [target.id]);
        res.json({ id: target.id, reset: true });
    } catch (e) {
        console.error('reset-2fa error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// Permanently delete a user account (owner only, re-auth with the owner's password).
// Cascades remove their activity + pending submissions; we also free their R2 images.
// Published `homes` remain (curated site content, no longer personal data).
app.delete('/api/admin/users/:id', requireRole('owner'), async (req, res) => {
    const password = (req.body && req.body.password) || '';
    if (req.params.id === req.user.sub) {
        return res.status(400).json({ error: 'Изтрийте собствения си профил от настройките.' });
    }
    try {
        const me = await dbGet('SELECT password_hash FROM users WHERE id=?', [req.user.sub]);
        if (!me) return res.status(401).json({ error: 'Not authenticated' });
        const ok = await bcrypt.compare(password, me.password_hash);
        if (!ok) return res.status(401).json({ error: 'Грешна парола' });

        const target = await dbGet('SELECT id, role FROM users WHERE id=?', [req.params.id]);
        if (!target) return res.status(404).json({ error: 'Потребителят не е намерен' });
        if (target.role === 'owner') return res.status(403).json({ error: 'Не можете да изтриете собственик.' });

        const pend = await dbAll('SELECT image_path FROM pending_addresses WHERE user_id=?', [target.id]);
        for (const row of pend) {
            for (const url of parsePendingImages(row.image_path)) { await deleteR2(url); await deleteR2(pendingThumbUrl(url)); }
        }
        await dbRun('DELETE FROM users WHERE id=?', [target.id]);  // cascades to activity + pending
        res.json({ id: target.id, deleted: true });
    } catch (e) {
        console.error('user delete error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// ── IP blacklist (owner only) ──────────────────────────────────────────────────
app.get('/api/admin/ip-blacklist', requireRole('owner'), async (_req, res) => {
    try {
        const rows = await dbAll('SELECT ip, reason, created_by, created_at FROM ip_blacklist ORDER BY created_at DESC');
        res.json(rows);
    } catch (e) {
        console.error('ip-blacklist list error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});
app.post('/api/admin/ip-blacklist', requireRole('owner'), async (req, res) => {
    const ip = normIp((req.body && req.body.ip) || '');
    const reason = sanitizeText((req.body && req.body.reason) || '', 200);
    if (!isValidIp(ip)) return res.status(400).json({ error: 'Невалиден IP адрес.' });
    if (normIp(clientIp(req)) === ip) return res.status(400).json({ error: 'Не можете да блокирате собствения си IP адрес.' });
    try {
        const me = await dbGet('SELECT email, display_name FROM users WHERE id=?', [req.user.sub]);
        const by = (me && (me.display_name || me.email)) || 'owner';
        await dbRun('INSERT OR REPLACE INTO ip_blacklist (ip, reason, created_by, created_at) VALUES (?,?,?,?)',
            [ip, reason || null, by, new Date().toISOString()]);
        ipBlacklist.add(ip);
        res.status(201).json({ ip, reason: reason || null, created_by: by });
    } catch (e) {
        console.error('ip-blacklist add error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});
app.delete('/api/admin/ip-blacklist/:ip', requireRole('owner'), async (req, res) => {
    const ip = normIp(req.params.ip);
    try {
        await dbRun('DELETE FROM ip_blacklist WHERE ip=?', [ip]);
        ipBlacklist.delete(ip);
        res.json({ ip, removed: true });
    } catch (e) {
        console.error('ip-blacklist remove error:', e.message);
        res.status(500).json({ error: 'Server error' });
    }
});

// robots.txt
app.get('/robots.txt', (_req, res) =>
    res.type('text/plain').send(`User-agent: *\nAllow: /\nSitemap: ${DOMAIN}/sitemap.xml`));

// Sitemap
app.get('/sitemap.xml', async (_req, res) => {
    const key = 'sitemap';
    const hit = cache.get(key);
    if (hit) return res.type('application/xml').send(hit);

    try {
        const rows = await dbAll('SELECT slug, updated_at FROM homes WHERE published = 1');
        const pages = ['index.html', 'addresses.html', 'map.html', 'calendar.html', 'about.html'];
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        for (const p of pages) xml += `  <url><loc>${DOMAIN}/${p}</loc><changefreq>weekly</changefreq></url>\n`;
        for (const r of rows) {
            const lm = r.updated_at ? `<lastmod>${r.updated_at.split('T')[0]}</lastmod>` : '';
            xml += `  <url><loc>${DOMAIN}/address.html?slug=${r.slug}</loc>${lm}</url>\n`;
        }
        xml += '</urlset>';
        cache.set(key, xml, 3600);
        res.type('application/xml').send(xml);
    } catch (e) {
        console.error('Sitemap error:', e);
        res.status(500).send('Error generating sitemap');
    }
});

// ── Upload ────────────────────────────────────────────────────────────────────
app.post('/api/upload', requireRole('admin'), upload.single('image'), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No image file provided' });
    try {
        const photographer = req.body.photographer || '';
        const homeSlug     = (req.body.homeSlug || 'img').replace(/[^a-z0-9]/gi, '').slice(0, 10);
        const applyWmark   = req.body.watermark === 'true';
        const filename     = `img_${homeSlug}_${Date.now()}_${randomSuffix()}.jpg`;

        if (!looksLikeImage(req.file.buffer)) return res.status(400).json({ error: 'Файлът не е валидно изображение.' });
        // Normalise to a web-friendly max width FIRST (caps huge originals so the live
        // page isn't loading multi-MB 5000px files), honour EXIF rotation, THEN watermark
        // so the mark is sized for the final image.
        const base = await sharp(req.file.buffer, SHARP_OPTS).rotate()
            .resize({ width: 2000, withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
        const buf = applyWmark ? await buildWatermark(base, photographer) : base;

        // Lightweight thumbnail for grids / list cards / map panel.
        // ~600px wide @ q70 is typically 10× smaller than the full image.
        const thumbName = filename.replace(/\.jpg$/i, '_thumb.jpg');
        const thumbBuf  = await sharp(buf)
            .resize({ width: 600, withoutEnlargement: true })
            .jpeg({ quality: 70 })
            .toBuffer();

        await Promise.all([
            r2.send(new PutObjectCommand({
                Bucket: R2_BUCKET, Key: filename, Body: buf,
                ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000',
            })),
            r2.send(new PutObjectCommand({
                Bucket: R2_BUCKET, Key: thumbName, Body: thumbBuf,
                ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000',
            })),
        ]);

        console.log(`📸 Uploaded ${filename} (+thumb) | wm:${applyWmark} | photographer:${photographer || '-'}`);
        res.json({
            url:      `${R2_PUBLIC_URL}/${filename}`,
            thumb:    `${R2_PUBLIC_URL}/${thumbName}`,
            filename,
        });
    } catch (e) {
        console.error('Upload error:', e);
        res.status(500).json({ error: e.message || 'Upload failed' });
    }
});

// ── Google Drive folder sync ───────────────────────────────────────────────────
// Imports every image from a shared Drive folder into R2 (optionally watermarked).
// Files are streamed into memory and processed in small concurrent batches to bound
// memory and avoid timeouts. Returns the resulting R2 URLs for the panel to attach.
app.post('/api/admin/drive-sync', requireRole('admin'), async (req, res) => {
    const folderId = parseDriveFolderId(req.body && req.body.folderUrl);
    if (!folderId) return res.status(400).json({ error: 'Невалиден линк към Google Drive папка.' });
    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
        return res.status(503).json({ error: 'Google Drive не е конфигуриран (липсва GOOGLE_SERVICE_ACCOUNT_JSON).' });
    }
    const applyWmark   = req.body.watermark === true || req.body.watermark === 'true';
    const photographer = String(req.body.photographer || '').trim();
    const MAX   = 60;   // per-request cap so a huge folder can't time out the request
    const BATCH = 4;    // concurrent downloads/uploads
    try {
        let files;
        try {
            files = await listDriveImages(folderId);
        } catch (e) {
            const msg = /permission|not found|notFound|403|404/i.test(e.message)
                ? 'Папката не е намерена или не е споделена със service account-а.'
                : 'Грешка при достъп до Google Drive: ' + e.message;
            return res.status(400).json({ error: msg });
        }
        if (!files.length) return res.json({ count: 0, total: 0, urls: [], errors: ['Няма изображения в папката.'] });

        const toProcess = files.slice(0, MAX);
        const urls = [], errors = [];
        for (let i = 0; i < toProcess.length; i += BATCH) {
            const batch = toProcess.slice(i, i + BATCH);
            await Promise.all(batch.map(async f => {
                try {
                    const buf      = await downloadDriveFile(f.id);
                    if (!looksLikeImage(buf)) throw new Error('не е изображение');
                    const finalBuf = applyWmark ? await buildWatermark(buf, photographer) : buf;
                    const url      = await uploadPhotoToR2(finalBuf, `img_drive_${Date.now()}_${randomSuffix()}`);
                    urls.push({ url, thumb: pendingThumbUrl(url) });
                } catch (e) { errors.push(`${f.name}: ${e.message}`); }
            }));
        }
        console.log(`☁️  Drive sync: ${urls.length}/${files.length} imported | wm:${applyWmark} | ${photographer || '-'}`);
        res.json({ count: urls.length, total: files.length, capped: files.length > MAX, urls, errors });
    } catch (e) {
        console.error('drive-sync error:', e.message);
        res.status(500).json({ error: 'Грешка при импорт от Google Drive.' });
    }
});

// ── Watermark configurator (owner only) ───────────────────────────────────────
app.get('/api/admin/settings/watermark', requireRole('admin'), async (req, res) => {
    try { res.json(await getWatermarkSettings()); }
    catch (e) { res.status(500).json({ error: 'Server error' }); }
});
app.put('/api/admin/settings/watermark', requireRole('admin'), async (req, res) => {
    const cfg = normalizeWmSettings(req.body || {});
    try {
        await dbRun("INSERT OR REPLACE INTO settings (key, value) VALUES ('watermark', ?)", [JSON.stringify(cfg)]);
        wmSettingsCache = cfg;   // Drive sync + uploads pick this up immediately
        res.json(Object.assign({ message: 'Запазено.' }, cfg));
    } catch (e) {
        console.error('watermark settings save error:', e.message);
        res.status(500).json({ error: 'Грешка при запазване.' });
    }
});
// Live preview: watermark a generated SAMPLE image with the POSTED (unsaved) settings.
// No user image is accepted (no image-bomb surface); returns a JPEG.
app.post('/api/admin/settings/watermark/preview', requireRole('admin'), async (req, res) => {
    try {
        const W = 1000, H = 667;
        const bg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7a6a52"/><stop offset="1" stop-color="#26201a"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><text x="50%" y="50%" fill="rgba(255,255,255,0.10)" font-size="44" text-anchor="middle" dominant-baseline="middle" font-family="sans-serif">ПРИМЕРНА СНИМКА</text></svg>`;
        const sample = await sharp(Buffer.from(bg)).jpeg({ quality: 86 }).toBuffer();
        const creator = sanitizeText((req.body && req.body.creator) || 'Иван Петров', 80) || 'Иван Петров';
        const out = await buildWatermark(sample, creator, req.body || {});
        res.set('Cache-Control', 'no-store');
        res.type('image/jpeg').send(out);
    } catch (e) {
        console.error('watermark preview error:', e.message);
        res.status(500).json({ error: 'preview failed' });
    }
});

// ── Homes ─────────────────────────────────────────────────────────────────────
app.get('/api/homes', async (req, res) => {
    const key    = req.url;
    const cached = cache.get(key);
    if (cached) return res.json(cached);

    const showAll    = req.query.all === 'true';
    const page       = Math.max(1, parseInt(req.query.page)  || 1);
    const limit      = Math.min(20, parseInt(req.query.limit) || 6);
    const search     = (req.query.search || '').trim();
    const tag        = (req.query.tag    || '').trim();
    const category   = (req.query.category || '').trim();
    const searchMode = req.query.searchMode || 'all';
    const offset     = (page - 1) * limit;

    const where = [], params = [];
    if (!showAll) { where.push('published = 1'); }

    // Filter by location category ('home' | 'monument' | 'events').
    // Rows with a NULL category (legacy) are treated as 'home'.
    if (CATEGORIES.includes(category)) {
        if (category === 'home') {
            where.push("(category = 'home' OR category IS NULL)");
        } else {
            where.push('category = ?');
            params.push(category);
        }
    }

    if (search) {
        const words = search.split(/\s+/).filter(Boolean);
        if (searchMode === 'name') {
            // name_lower holds a Unicode-lowercased copy, so this is truly
            // case-insensitive - including for Cyrillic.
            where.push('(' + words.map(() => 'name_lower LIKE ?').join(' AND ') + ')');
            words.forEach(w => params.push(`%${w.toLowerCase()}%`));
        } else {
            where.push('(' + words.map(() =>
                '(name_lower LIKE ? OR LOWER(biography) LIKE ? OR LOWER(address) LIKE ? OR LOWER(tags) LIKE ?)'
            ).join(' AND ') + ')');
            words.forEach(w => {
                const wl = `%${w.toLowerCase()}%`;
                params.push(wl, wl, wl, wl);
            });
        }
    }

    if (tag) { where.push('LOWER(tags) LIKE LOWER(?)'); params.push(`%${tag}%`); }

    const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

    try {
        const countRow = await dbGet(`SELECT COUNT(*) AS total FROM homes ${W}`, params);
        const total      = countRow.total;
        const rows       = await dbAll(
            `SELECT id,slug,name,address,lat,lng,images,tags,category, SUBSTR(biography,1,200) AS bio_snippet
             FROM homes ${W} ORDER BY name LIMIT ? OFFSET ?`,
            [...params, limit, offset]
        );
        const result = {
            data: rows.map(r => rowToHome(r, true)),
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasNext: page * limit < total, hasPrev: page > 1 },
        };
        if (result.data.length > 0 || search || tag) cache.set(key, result, LOW_SPEC ? 10 : 30);
        res.json(result);
    } catch (e) {
        console.error('/api/homes error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/homes/map', async (_req, res) => {
    const key = 'map_data';
    const hit = cache.get(key);
    if (hit) return res.json(hit);
    try {
        const rows = await dbAll(
            'SELECT id,slug,name,lat,lng,category FROM homes WHERE published=1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name'
        );
        const data = rows.map(r => ({ id: r.id, slug: r.slug, name: r.name, lat: r.lat, lng: r.lng, category: r.category || 'home' }));
        cache.set(key, data, 300);
        res.json(data);
    } catch (e) {
        console.error('/api/homes/map error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/homes/:slug', async (req, res) => {
    const key = `home:${req.params.slug}`;
    const hit = cache.get(key);
    if (hit) return res.json(hit);
    try {
        const row = await dbGet('SELECT * FROM homes WHERE slug=? OR id=?', [req.params.slug, req.params.slug]);
        if (!row) return res.status(404).json({ error: 'Home not found' });
        const data = rowToHome(row);
        data.related      = await getRelatedPlaces(row.id);   // preview cards (both directions)
        data.related_edit = await getRelatedEdit(row.id);     // outgoing links w/ names (admin editor)
        cache.set(key, data, 60);
        res.json(data);
    } catch (e) {
        console.error('/api/homes/:slug error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/homes', requireRole('admin'), async (req, res) => {
    const h = req.body;
    if (!h.name) return res.status(400).json({ error: 'Name is required' });
    if (!h.slug) h.slug = h.name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace(/(^-|-$)/g, '');
    h.id = h.id || h.slug;
    h.created_at = h.updated_at = new Date().toISOString();
    try {
        insertHome(h);
        // Queued after the home INSERT (sqlite serialises), so the FK target exists.
        await syncRelated(h.id, h.related_ids);
        cache.clear();
        res.status(201).json({ message: 'Home created', id: h.id, slug: h.slug });
    } catch (e) {
        console.error('POST /api/homes error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.put('/api/homes/:id', requireRole('admin'), async (req, res) => {
    const h = { ...req.body, updated_at: new Date().toISOString() };
    const c = h.coordinates || {};
    try {
        const dStart = (h.date_start != null ? h.date_start : h.birth_date) || null;
        const dEnd   = (h.date_end   != null ? h.date_end   : h.death_date) || null;
        const result = await dbRun(`UPDATE homes SET
            slug=?,name=?,name_lower=?,biography=?,address=?,lat=?,lng=?,images=?,photo_date=?,
            sources=?,tags=?,published=?,updated_at=?,portrait_url=?,birth_date=?,death_date=?,date_label=?,category=?,
            credited_to=COALESCE(?,credited_to)
            WHERE id=?`,
            [
                h.slug, h.name, (h.name || '').toLowerCase(), h.biography, h.address,
                c.lat || null, c.lng || null,
                JSON.stringify(h.images  || []), h.photo_date || null,
                JSON.stringify(h.sources || []),
                JSON.stringify(h.tags    || []),
                h.published !== false ? 1 : 0,
                h.updated_at, h.portrait_url || null, dStart, dEnd, (h.date_label ? String(h.date_label).trim().slice(0, 80) : null),
                normCategory(h.category),
                (h.credited_to !== undefined ? (h.credited_to || null) : null),
                req.params.id,
            ]
        );
        if (!result.changes) return res.status(404).json({ error: 'Home not found' });
        if (h.related_ids !== undefined) await syncRelated(req.params.id, h.related_ids);
        cache.clear();
        res.json({ message: 'Home updated' });
    } catch (e) {
        console.error('PUT /api/homes error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/homes/:id', requireRole('admin'), async (req, res) => {
    try {
        await dbRun('DELETE FROM homes WHERE id=?', [req.params.id]);
        cache.clear();
        res.json({ message: 'Home deleted' });
    } catch (e) {
        console.error('DELETE /api/homes error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Tags ──────────────────────────────────────────────────────────────────────
app.get('/api/tags', async (req, res) => {
    const category = (req.query.category || '').trim();
    const useCat   = CATEGORIES.includes(category);
    const key = 'tags:' + (useCat ? category : 'all');
    const hit = cache.get(key);
    if (hit) return res.json(hit);
    try {
        let sql = 'SELECT DISTINCT tags FROM homes WHERE published=1';
        const params = [];
        if (useCat) {
            if (category === 'home') { sql += " AND (category='home' OR category IS NULL)"; }
            else { sql += ' AND category=?'; params.push(category); }
        }
        const rows = await dbAll(sql, params);
        const set  = new Set();
        for (const r of rows) {
            try { JSON.parse(r.tags || '[]').forEach(t => t && set.add(t.trim())); } catch {}
        }
        const tags = [...set].sort((a, b) => a.localeCompare(b, 'bg'));
        cache.set(key, tags, 600);
        res.json(tags);
    } catch (e) {
        console.error('/api/tags error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Partners ──────────────────────────────────────────────────────────────────
app.get('/api/partners', async (req, res) => {
    const showAll = req.query.all === 'true';
    const W = showAll ? '' : 'WHERE published=1';
    try {
        const rows = await dbAll(`SELECT * FROM partners ${W} ORDER BY display_order ASC, name ASC`);
        res.json(rows);
    } catch (e) {
        console.error('/api/partners error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET single partner (needed by admin edit)
app.get('/api/partners/:id', async (req, res) => {
    try {
        const row = await dbGet('SELECT * FROM partners WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Partner not found' });
        res.json(row);
    } catch (e) {
        console.error('/api/partners/:id error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/partners', requireRole('owner'), async (req, res) => {
    const p = req.body;
    if (!p.name) return res.status(400).json({ error: 'Name is required' });
    const id  = p.id || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const now = new Date().toISOString();
    try {
        await dbRun(
            `INSERT INTO partners (id,name,description,logo_url,website,instagram,email,published,display_order,created_at,updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [id, p.name, p.description||null, p.logo_url||null, p.website||null,
             p.instagram||null, p.email||null, p.published!==false?1:0, p.display_order||0, now, now]
        );
        res.status(201).json({ id, message: 'Partner created' });
    } catch (e) {
        console.error('POST /api/partners error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.put('/api/partners/:id', requireRole('owner'), async (req, res) => {
    const p   = req.body;
    const now = new Date().toISOString();
    try {
        const r = await dbRun(
            `UPDATE partners SET name=?,description=?,logo_url=?,website=?,instagram=?,email=?,published=?,display_order=?,updated_at=? WHERE id=?`,
            [p.name, p.description||null, p.logo_url||null, p.website||null,
             p.instagram||null, p.email||null, p.published!==false?1:0, p.display_order||0, now, req.params.id]
        );
        if (!r.changes) return res.status(404).json({ error: 'Partner not found' });
        res.json({ message: 'Partner updated' });
    } catch (e) {
        console.error('PUT /api/partners error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/partners/:id', requireRole('owner'), async (req, res) => {
    try {
        await dbRun('DELETE FROM partners WHERE id=?', [req.params.id]);
        res.json({ message: 'Partner deleted' });
    } catch (e) {
        console.error('DELETE /api/partners error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── News ──────────────────────────────────────────────────────────────────────
app.get('/api/news', async (req, res) => {
    const page    = Math.max(1, parseInt(req.query.page)  || 1);
    const limit   = Math.min(100, parseInt(req.query.limit) || 10);
    const offset  = (page - 1) * limit;
    const showAll = req.query.all === 'true';
    const W       = showAll ? '' : 'WHERE is_published=1';
    try {
        const countRow = await dbGet(`SELECT COUNT(*) AS total FROM news ${W}`);
        const rows     = await dbAll(
            `SELECT id,title,slug,excerpt,cover_image,published_date,author,is_published,link
             FROM news ${W} ORDER BY published_date DESC LIMIT ? OFFSET ?`,
            [limit, offset]
        );
        res.json({
            data: rows,
            pagination: { page, limit, total: countRow.total, totalPages: Math.ceil(countRow.total / limit) },
        });
    } catch (e) {
        console.error('/api/news error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// GET single article - public by slug OR admin by numeric id
app.get('/api/news/:ref', async (req, res) => {
    const ref = req.params.ref;
    try {
        // Numeric id → admin fetch (no published filter)
        const row = /^\d+$/.test(ref)
            ? await dbGet('SELECT * FROM news WHERE id=?', [ref])
            : await dbGet('SELECT * FROM news WHERE slug=? AND is_published=1', [ref]);
        if (!row) return res.status(404).json({ error: 'Article not found' });
        res.json(row);
    } catch (e) {
        console.error('/api/news/:ref error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/news', requireRole('owner'), async (req, res) => {
    const { title, slug, content, excerpt, cover_image, published_date, author, is_published, link } = req.body;
    if (!title || !slug || !content) return res.status(400).json({ error: 'title, slug and content are required' });
    const cleanLink = isHttpUrl(link) ? String(link).trim() : null;
    const published  = is_published !== false ? 1 : 0;
    try {
        const r = await dbRun(
            `INSERT INTO news (title,slug,content,excerpt,cover_image,published_date,author,is_published,link) VALUES (?,?,?,?,?,?,?,?,?)`,
            [title, slug, content, excerpt||'', cover_image||'',
             published_date || new Date().toISOString().split('T')[0],
             author || 'Екипът на Адресът на историята',
             published, cleanLink]
        );
        cache.clear();
        res.json({ success: true, id: r.lastID });

        // If published, email newsletter subscribers (fire-and-forget - never blocks).
        if (published) {
            sendNewsletter({ title, slug, excerpt: excerpt || '', cover_image: cover_image || '', link: cleanLink })
                .catch(e => console.error('newsletter send error:', e.message));
        }
    } catch (e) {
        console.error('POST /api/news error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/news/:id', requireRole('owner'), async (req, res) => {
    const { title, slug, content, excerpt, cover_image, published_date, author, is_published, link } = req.body;
    const cleanLink = isHttpUrl(link) ? String(link).trim() : null;
    try {
        await dbRun(
            `UPDATE news SET title=?,slug=?,content=?,excerpt=?,cover_image=?,published_date=?,author=?,is_published=?,link=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`,
            [title, slug, content, excerpt, cover_image, published_date, author, is_published, cleanLink, req.params.id]
        );
        cache.clear();
        res.json({ success: true });
    } catch (e) {
        console.error('PUT /api/news error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/news/:id', requireRole('owner'), async (req, res) => {
    try {
        await dbRun('DELETE FROM news WHERE id=?', [req.params.id]);
        cache.clear();
        res.json({ success: true });
    } catch (e) {
        console.error('DELETE /api/news error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Calendar ──────────────────────────────────────────────────────────────────
app.get('/api/calendar', async (req, res) => {
    const month = String(parseInt(req.query.month) || new Date().getMonth() + 1).padStart(2, '0');
    const year  = parseInt(req.query.year) || new Date().getFullYear();
    const key   = `cal:${month}:${year}`;
    const hit   = cache.get(key);
    if (hit) return res.json(hit);

    try {
        const rows = await dbAll(
            `SELECT name,slug,birth_date,death_date,date_label,images,category,portrait_url FROM homes WHERE published=1
             AND (strftime('%m',birth_date)=? OR strftime('%m',death_date)=?)`,
            [month, month]
        );
        const events = {};
        for (const r of rows) {
            const image = calPic(r.portrait_url, r.images);
            for (const [field, type] of [['birth_date','birth'],['death_date','death']]) {
                const d = r[field];
                if (!d || !d.includes(`-${month}-`)) continue;
                const date = new Date(d);
                const day  = String(date.getDate()).padStart(2,'0');
                const k    = `${month}-${day}`;
                if (!events[k]) events[k] = [];
                events[k].push({ name: r.name, slug: r.slug, type, full_date: d, years_ago: year - date.getFullYear(), image, birth_date: r.birth_date, death_date: r.death_date, date_label: r.date_label || null, category: r.category || 'home' });
            }
        }
        cache.set(key, events, 300);
        res.json(events);
    } catch (e) {
        console.error('/api/calendar error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/calendar/today', async (req, res) => {
    const today     = new Date();
    const monthDay  = String(today.getMonth()+1).padStart(2,'0') + '-' + String(today.getDate()).padStart(2,'0');
    const viewYear  = parseInt(req.query.year) || today.getFullYear();
    const key       = `cal_today:${monthDay}`;
    const hit       = cache.get(key);
    if (hit) return res.json(hit);

    try {
        const rows = await dbAll(
            `SELECT name,slug,birth_date,death_date,date_label,images,category,portrait_url FROM homes WHERE published=1
             AND (strftime('%m-%d',birth_date)=? OR strftime('%m-%d',death_date)=?)`,
            [monthDay, monthDay]
        );
        const events = [];
        for (const r of rows) {
            const image = calPic(r.portrait_url, r.images);
            for (const [field, type] of [['birth_date','birth'],['death_date','death']]) {
                if (r[field] && r[field].substring(5) === monthDay) {
                    events.push({ name: r.name, slug: r.slug, type, full_date: r[field], years_ago: viewYear - new Date(r[field]).getFullYear(), image, birth_date: r.birth_date, death_date: r.death_date, date_label: r.date_label || null, category: r.category || 'home' });
                }
            }
        }
        cache.set(key, events, 300);
        res.json(events);
    } catch (e) {
        console.error('/api/calendar/today error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/calendar/all', async (_req, res) => {
    const key = 'cal_all';
    const hit = cache.get(key);
    if (hit) return res.json(hit);
    try {
        const rows = await dbAll(
            'SELECT name,slug,birth_date,death_date,date_label,portrait_url,images FROM homes WHERE published=1 AND (birth_date IS NOT NULL OR death_date IS NOT NULL)'
        );
        const out = rows.map(r => ({
            name: r.name, slug: r.slug, birth_date: r.birth_date, death_date: r.death_date,
            date_start: r.birth_date, date_end: r.death_date, date_label: r.date_label || null,
            image: calPic(r.portrait_url, r.images),
        }));
        cache.set(key, out, 1800);
        res.json(out);
    } catch (e) {
        console.error('/api/calendar/all error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Team ──────────────────────────────────────────────────────────────────────
app.get('/api/team', async (req, res) => {
    // ?all=true used by admin panel to see hidden members too
    const showAll = req.query.all === 'true';
    const W = showAll ? '' : 'WHERE is_published=1';
    try {
        const rows = await dbAll(`SELECT id,name,role,bio,photo,display_order,is_published FROM team ${W} ORDER BY display_order ASC, id ASC`);
        res.json(rows);
    } catch (e) {
        console.error('/api/team error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.get('/api/team/:id', async (req, res) => {
    try {
        const row = await dbGet('SELECT * FROM team WHERE id=?', [req.params.id]);
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(row);
    } catch (e) {
        console.error('/api/team/:id error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.post('/api/team', requireRole('owner'), async (req, res) => {
    const { name, role, bio, photo, display_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Name is required' });
    try {
        const r = await dbRun(
            'INSERT INTO team (name,role,bio,photo,display_order) VALUES (?,?,?,?,?)',
            [name, role||'', bio||'', photo||'', display_order||0]
        );
        cache.clear();
        res.json({ success: true, id: r.lastID });
    } catch (e) {
        console.error('POST /api/team error:', e);
        res.status(500).json({ error: e.message });
    }
});

app.put('/api/team/:id', requireRole('owner'), async (req, res) => {
    const { name, role, bio, photo, display_order, is_published } = req.body;
    try {
        const r = await dbRun(
            'UPDATE team SET name=?,role=?,bio=?,photo=?,display_order=?,is_published=? WHERE id=?',
            [name, role, bio, photo, display_order, is_published, req.params.id]
        );
        cache.clear();
        res.json({ success: true, changes: r.changes });
    } catch (e) {
        console.error('PUT /api/team error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

app.delete('/api/team/:id', requireRole('owner'), async (req, res) => {
    try {
        const r = await dbRun('DELETE FROM team WHERE id=?', [req.params.id]);
        cache.clear();
        res.json({ success: true, deleted: r.changes > 0 });
    } catch (e) {
        console.error('DELETE /api/team error:', e);
        res.status(500).json({ error: 'Database error' });
    }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    const mem = process.memoryUsage();
    res.json({
        status:  'healthy',
        uptime:  Math.round(process.uptime()),
        memory:  { rss: mb(mem.rss), heap: mb(mem.heapUsed) },
        cache:   cache.stats(),
        mode:    LOW_SPEC ? 'lean' : 'performance',
    });
    function mb(b) { return Math.round(b / 1024 / 1024) + ' MB'; }
});

// ── Owner-only database backup (hidden) ───────────────────────────────────────
// Lets the owner download a full, consistent SQLite snapshot for off-site safe-
// keeping. Double-gated: the request must (1) supply the secret DB_BACKUP_KEY and
// (2) come from a logged-in owner. ANY failure returns the normal 404 page, so the
// route is invisible to anyone lacking both. VACUUM INTO yields a clean, WAL-
// consistent copy that is streamed and then deleted.
function safeEqual(a, b) {
    const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
app.get('/api/sys/db-export', async (req, res) => {
    const notFound = () => { try { res.status(404).sendFile(path.join(__dirname, '404.html')); } catch {} };
    try {
        const key = req.get('x-backup-key') || req.query.key || '';
        if (!process.env.DB_BACKUP_KEY || !safeEqual(key, process.env.DB_BACKUP_KEY)) return notFound();

        const token = req.cookies && req.cookies[AUTH_COOKIE];
        if (!token) return notFound();
        let payload;
        try { payload = jwt.verify(token, JWT_SECRET); } catch { return notFound(); }
        const row = await dbGet('SELECT role FROM users WHERE id=?', [payload.sub]);
        if (!row || row.role !== 'owner') return notFound();

        const tmp = path.join(path.dirname(DB_FILE), 'ha-backup-' + crypto.randomBytes(8).toString('hex') + '.db');
        const sqlPath = tmp.replace(/\\/g, '/').replace(/'/g, "''");   // server-generated, no user input
        await dbRun(`VACUUM INTO '${sqlPath}'`);
        const fname = 'historyaddress-backup-' + new Date().toISOString().slice(0, 10) + '.db';
        res.download(tmp, fname, () => { fs.unlink(tmp, () => {}); });
    } catch (e) {
        console.error('db-export error:', e.message);
        notFound();
    }
});

// ── Page catch-alls ───────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:page.html', (req, res) => {
    const fp = path.join(__dirname, `${req.params.page}.html`);
    fs.existsSync(fp) ? res.sendFile(fp) : res.status(404).sendFile(path.join(__dirname, '404.html'));
});

// Final fallback: any other unmatched route. API paths get JSON; everything else
// (e.g. /some-old-link with no extension) gets the themed 404 page.
app.use((req, res) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
        return res.status(404).sendFile(path.join(__dirname, '404.html'));
    }
    res.status(404).json({ error: 'Not found' });
});

// ─── Memory watchdog ──────────────────────────────────────────────────────────
const GC_WARN  = LOW_SPEC ? 150 : 500;
const GC_CRIT  = LOW_SPEC ? 250 : 800;
setInterval(() => {
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    if (rss > GC_WARN && typeof global.gc === 'function') {
        global.gc();
        if (rss > GC_CRIT) { console.warn(`⚠️  Critical RSS ${rss} MB - flushing cache`); cache.clear(); }
    }
}, LOW_SPEC ? 30_000 : 60_000);

// ─── Start ────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Listening on :${PORT} - ${DOMAIN}\n`);
});
server.keepAliveTimeout = 30_000;
server.headersTimeout   = 31_000;

// ─── Graceful shutdown ────────────────────────────────────────────────────────
function shutdown(sig) {
    console.log(`\n${sig} received - shutting down…`);
    server.close(() => db.close(() => { console.log('👋 Closed.'); process.exit(0); }));
    setTimeout(() => process.exit(1), 10_000);
}
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException',   err => { console.error('Uncaught:', err);   process.exit(1); });
process.on('unhandledRejection',  err => { console.error('Unhandled:', err);  process.exit(1); });