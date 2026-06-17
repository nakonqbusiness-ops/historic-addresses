/**
 * One-time backfill: generate thumbnails for images that don't have one yet.
 *
 * For every home image stored as { path: "...jpg" } (no `thumb`), this:
 *   1. downloads the full image from R2,
 *   2. creates a ~600px-wide q70 JPEG thumbnail,
 *   3. uploads it next to the original as "<name>_thumb.jpg",
 *   4. adds `thumb` to the image object in the DB.
 *
 * Safe to re-run: images that already have a `thumb` are skipped.
 *
 * Usage (on the server where the production DB + R2 creds live):
 *     node generate-thumbnails.js
 */
require('dotenv').config();
const sqlite3 = require('sqlite3').verbose();
const sharp   = require('sharp');
const path    = require('path');
const fs      = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

// ── Same config as server.js ──────────────────────────────────────────────
const R2_BUCKET     = 'history-address-images';
const R2_PUBLIC_URL = 'https://pub-b40e453eddaf4bc5b299af8f6d7b7de2.r2.dev';

const r2 = new S3Client({
    region: 'auto',
    endpoint: 'https://ae436e2433a501e9b779b8993e95d5b1.r2.cloudflarestorage.com',
    credentials: {
        accessKeyId:     process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_KEY,
    },
});

const DB_FILE = (() => {
    const candidates = [
        process.env.DATABASE_URL,
        '/data/database.db',
        path.join(__dirname, 'database.db'),
    ].filter(Boolean);
    for (const p of candidates) if (fs.existsSync(p)) return p;
    return path.join(__dirname, 'database.db');
})();

const db = new sqlite3.Database(DB_FILE);
const dbAll = (sql, p = []) => new Promise((res, rej) => db.all(sql, p, (e, r) => e ? rej(e) : res(r)));
const dbRun = (sql, p = []) => new Promise((res, rej) => db.run(sql, p, function (e) { e ? rej(e) : res(this); }));

function thumbKeyFor(url) {
    const key = url.split('/').pop();                       // filename only
    return key.replace(/\.(jpe?g|png|webp)$/i, '') + '_thumb.jpg';
}

async function makeThumb(url) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    const thumbBuf = await sharp(buf)
        .resize({ width: 600, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
    const thumbKey = thumbKeyFor(url);
    await r2.send(new PutObjectCommand({
        Bucket: R2_BUCKET, Key: thumbKey, Body: thumbBuf,
        ContentType: 'image/jpeg', CacheControl: 'public, max-age=31536000',
    }));
    return `${R2_PUBLIC_URL}/${thumbKey}`;
}

(async () => {
    console.log('📦 DB:', DB_FILE);
    const rows = await dbAll('SELECT id, images FROM homes WHERE images IS NOT NULL');
    let homesUpdated = 0, thumbsMade = 0, skipped = 0, failed = 0;

    for (const row of rows) {
        let images;
        try { images = JSON.parse(row.images || '[]'); } catch { continue; }
        if (!Array.isArray(images) || !images.length) continue;

        let changed = false;
        for (const img of images) {
            if (!img || !img.path) continue;
            if (img.thumb) { skipped++; continue; }                 // already done
            if (!/^https?:\/\//i.test(img.path)) { skipped++; continue; } // local/placeholder
            try {
                img.thumb = await makeThumb(img.path);
                thumbsMade++; changed = true;
                process.stdout.write('.');
            } catch (e) {
                failed++;
                console.warn('\n⚠️  ' + img.path + ' → ' + e.message);
            }
        }
        if (changed) {
            await dbRun('UPDATE homes SET images=? WHERE id=?', [JSON.stringify(images), row.id]);
            homesUpdated++;
        }
    }

    console.log(`\n\n✅ Done. Homes updated: ${homesUpdated} | thumbnails created: ${thumbsMade} | skipped: ${skipped} | failed: ${failed}`);
    db.close();
    process.exit(0);
})().catch(e => { console.error('Fatal:', e); process.exit(1); });
