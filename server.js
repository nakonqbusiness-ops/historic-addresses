const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = 'https://historyaddress.bg';

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' })); 
app.use(express.static(path.join(__dirname)));

// Favicon routes
const faviconPath = path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png');
app.get(['/favicon.ico', '/apple-touch-icon.png', '/android-chrome-192x192.png', '/android-chrome-512x512.png'], (req, res) => {
    res.sendFile(faviconPath);
});

// Memory logging & IP tracking
const recentVisits = new Map();
app.use((req, res, next) => {
    if (req.originalUrl.startsWith('/assets/') || req.originalUrl.includes('.')) return next();
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const lastLog = recentVisits.get(ip);
    
    if (!lastLog || (now - lastLog) > 10000) {
        console.log(`[${req.method}] ${req.originalUrl.substring(0, 50)} - ${ip.substring(0, 15)}`);
        recentVisits.set(ip, now);
    }
    
    if (recentVisits.size > 100) {
        const cutoff = now - 60000;
        for (const [key, time] of recentVisits.entries()) {
            if (time < cutoff) recentVisits.delete(key);
        }
    }
    next();
});

const DB_DIR = process.env.RENDER ? '/data' : '.';
const DB_FILE = path.join(DB_DIR, 'database.db');

if (process.env.RENDER && !fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
}

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (!err) {
        console.log('Connected to SQLite');
        initializeDatabase();
        initializePartnersTable();
    }
});

// SQLite Performance
db.serialize(() => {
    db.run('PRAGMA journal_mode = DELETE');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA cache_size = 50');
    db.run('PRAGMA temp_store = MEMORY');
});

function initializeDatabase() {
    db.run(`CREATE TABLE IF NOT EXISTS homes (
        id TEXT PRIMARY KEY, slug TEXT UNIQUE, name TEXT NOT NULL, biography TEXT,
        address TEXT, lat REAL, lng REAL, images TEXT, photo_date TEXT,
        sources TEXT, tags TEXT, published INTEGER DEFAULT 1,
        created_at TEXT, updated_at TEXT, portrait_url TEXT,
        birth_date TEXT, death_date TEXT
    )`, () => {
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_published ON homes(published)');
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_slug ON homes(slug)');
        checkAndMigrateSchema();
    });
}

function initializePartnersTable() {
    db.run(`CREATE TABLE IF NOT EXISTS partners (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, logo_url TEXT,
        website TEXT, instagram TEXT, email TEXT, published INTEGER DEFAULT 1,
        display_order INTEGER DEFAULT 0, created_at TEXT, updated_at TEXT
    )`);
}

function checkAndMigrateSchema() {
    db.all("PRAGMA table_info(homes)", (err, columns) => {
        if (err) return;
        const columnNames = columns.map(col => col.name);
        const needed = [
            { n: 'portrait_url', t: 'TEXT' },
            { n: 'birth_date', t: 'TEXT' },
            { n: 'death_date', t: 'TEXT' }
        ];
        needed.forEach(col => {
            if (!columnNames.includes(col.n)) {
                db.run(`ALTER TABLE homes ADD COLUMN ${col.n} ${col.t}`);
            }
        });
    });
}

function rowToHome(row, ultraLean = false) {
    const images = JSON.parse(row.images || '[]');
    if (ultraLean) {
        return {
            id: row.id, slug: row.slug, name: row.name, address: row.address,
            coordinates: row.lat ? { lat: row.lat, lng: row.lng } : null,
            images: images.slice(0, 1),
            tags: JSON.parse(row.tags || '[]'),
            published: true
        };
    }
    return {
        ...row,
        coordinates: row.lat ? { lat: row.lat, lng: row.lng } : null,
        images,
        sources: JSON.parse(row.sources || '[]'),
        tags: JSON.parse(row.tags || '[]'),
        published: row.published === 1
    };
}

// APIs
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 6, 20);
    const offset = (page - 1) * limit;
    const search = req.query.search || '';
    
    let where = showAll ? 'WHERE 1=1' : 'WHERE published = 1';
    let params = [];
    
    if (search) {
        where += ` AND (name LIKE ? OR address LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
    }

    db.get(`SELECT COUNT(*) as total FROM homes ${where}`, params, (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });
        
        db.all(`SELECT id, slug, name, address, lat, lng, images, tags FROM homes ${where} ORDER BY name LIMIT ? OFFSET ?`, 
        [...params, limit, offset], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({
                data: rows.map(r => rowToHome(r, true)),
                pagination: { total: countRow.total, page, totalPages: Math.ceil(countRow.total / limit) }
            });
        });
    });
});

app.get('/api/homes/:slug', (req, res) => {
    db.get('SELECT * FROM homes WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug], (err, row) => {
        if (!row) return res.status(404).json({ error: 'Not found' });
        res.json(rowToHome(row, false));
    });
});

// Caches for Calendar
let calendarCache = new Map();
let calendarCacheTime = new Map();

app.get('/api/calendar', (req, res) => {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const monthStr = String(month).padStart(2, '0');
    const cacheKey = `month-${month}`;
    
    if (calendarCache.has(cacheKey) && (Date.now() - calendarCacheTime.get(cacheKey) < 600000)) {
        return res.json(calendarCache.get(cacheKey));
    }

    // SQLite substr(date, 6, 2) extracts the month from YYYY-MM-DD
    db.all(`
        SELECT name, slug, birth_date, death_date FROM homes 
        WHERE published = 1 AND (substr(birth_date, 6, 2) = ? OR substr(death_date, 6, 2) = ?)
    `, [monthStr, monthStr], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const events = {};
        const currentYear = new Date().getFullYear();

        rows.forEach(row => {
            ['birth_date', 'death_date'].forEach(field => {
                if (row[field] && row[field].includes(`-${monthStr}-`)) {
                    const day = row[field].split('-')[2].substring(0,2);
                    const key = `${monthStr}-${day}`;
                    if (!events[key]) events[key] = [];
                    events[key].push({
                        name: row.name, slug: row.slug,
                        type: field === 'birth_date' ? 'birth' : 'death',
                        years_ago: currentYear - parseInt(row[field].substring(0,4))
                    });
                }
            });
        });

        calendarCache.set(cacheKey, events);
        calendarCacheTime.set(cacheKey, Date.now());
        res.json(events);
    });
});

app.get('/api/calendar/today', (req, res) => {
    const today = new Date();
    const mmdd = `${String(today.getMonth()+1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    db.all(`
        SELECT name, slug, birth_date, death_date FROM homes 
        WHERE published = 1 AND (substr(birth_date, 6, 5) = ? OR substr(death_date, 6, 5) = ?)
    `, [mmdd, mmdd], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const events = rows.map(r => ({
            name: r.name, slug: r.slug,
            type: r.birth_date?.includes(mmdd) ? 'birth' : 'death'
        }));
        res.json(events);
    });
});

// Sitemap
app.get('/sitemap.xml', (req, res) => {
    db.all('SELECT slug, updated_at FROM homes WHERE published = 1', [], (err, rows) => {
        let xml = '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">';
        rows.forEach(h => {
            xml += `<url><loc>${DOMAIN}/address.html?slug=${h.slug}</loc><priority>0.6</priority></url>`;
        });
        xml += '</urlset>';
        res.type('application/xml').send(xml);
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:page.html', (req, res) => {
    const p = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(p)) res.sendFile(p);
    else res.status(404).send('Not found');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on port ${PORT}`);
});

// Garbage Collection
setInterval(() => {
    if (global.gc) {
        global.gc();
        if (process.memoryUsage().rss > 150 * 1024 * 1024) {
            calendarCache.clear();
            recentVisits.clear();
        }
    }
}, 30000);
