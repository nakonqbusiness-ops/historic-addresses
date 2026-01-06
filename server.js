const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = 'https://historyaddress.bg';

// REDUCED from 5mb to 2mb
app.use(cors());
app.use(express.json({ limit: '2mb' })); 
app.use(express.static(path.join(__dirname)));

// Favicon routes
app.get('/favicon.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png'));
});

app.get('/apple-touch-icon.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png'));
});

app.get('/android-chrome-192x192.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png'));
});

app.get('/android-chrome-512x512.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png'));
});

app.get('/assets/img/HistAdrLogoOrig.ico', (req, res) => {
    res.sendFile(path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png'));
});

// CRITICAL FIX: NO DATABASE LOGGING - just console
const recentVisits = new Map();
app.use((req, res, next) => {
    // Skip static files completely
    if (req.originalUrl.startsWith('/assets/') || 
        req.originalUrl.startsWith('/favicon') ||
        req.originalUrl.endsWith('.css') ||
        req.originalUrl.endsWith('.js') ||
        req.originalUrl.endsWith('.png') ||
        req.originalUrl.endsWith('.jpg')) {
        return next();
    }
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    
    // Rate limit: Only log if not seen in last 10 seconds
    const now = Date.now();
    const lastLog = recentVisits.get(ip);
    
    if (!lastLog || (now - lastLog) > 10000) {
        console.log(`[${req.method}] ${req.originalUrl.substring(0, 50)} - ${ip.substring(0, 15)}`);
        recentVisits.set(ip, now);
    }
    
    // Clean old entries every 100 requests
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
    try {
        fs.mkdirSync(DB_DIR, { recursive: true });
        console.log(`✅ Created persistent data directory: ${DB_DIR}`);
    } catch (e) {
        console.error('CRITICAL ERROR:', e);
        process.exit(1);
    }
}

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// ULTRA AGGRESSIVE SQLITE SETTINGS
db.configure('busyTimeout', 3000); // Reduced from 5000
db.run('PRAGMA journal_mode = DELETE'); // DELETE uses less memory than WAL
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 50'); // REDUCED from 500 to 50!
db.run('PRAGMA temp_store = MEMORY');
db.run('PRAGMA mmap_size = 0');
db.run('PRAGMA page_size = 1024'); // Smaller pages = less memory
db.run('PRAGMA locking_mode = NORMAL'); // Release locks faster

function initializeDatabase() {
    db.run(`
        CREATE TABLE IF NOT EXISTS homes (
           id TEXT PRIMARY KEY,
           slug TEXT UNIQUE,
           name TEXT NOT NULL,
           biography TEXT,
           address TEXT,
           lat REAL,
           lng REAL,
           images TEXT,
           photo_date TEXT,
           sources TEXT,
           tags TEXT,
           published INTEGER DEFAULT 1,
           created_at TEXT,
           updated_at TEXT,
           portrait_url TEXT
        )
    `, (err) => {
        if (err) {
            console.error('Error creating table:', err);
        } else {
            console.log('Database table ready');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_published ON homes(published)');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_slug ON homes(slug)');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_name ON homes(name)');
            checkAndMigrateSchema();
        }
    });
}

function checkAndMigrateSchema() {
    db.all("PRAGMA table_info(homes)", (err, columns) => {
        if (err) {
            console.error('Error checking columns:', err);
            importInitialData();
            return;
        }
        const columnNames = columns.map(col => col.name);
        if (!columnNames.includes('portrait_url')) {
            db.run('ALTER TABLE homes ADD COLUMN portrait_url TEXT', (err) => {
                if (err) console.error('Migration failed:', err);
                else console.log('✅ Added portrait_url column');
                importInitialData();
            });
        } else {
            importInitialData();
        }
    });
}

function importInitialData() {
    db.get('SELECT COUNT(*) as count FROM homes', (err, row) => {
        if (err || !row || row.count > 0) return;
        try {
            const dataPath = path.join(__dirname, 'data', 'people.js');
            if (fs.existsSync(dataPath)) {
                const fileContent = fs.readFileSync(dataPath, 'utf8');
                const match = fileContent.match(/var\s+PEOPLE\s*=\s*(\[[\s\S]*?\]);/);
                if (match) {
                    const people = JSON.parse(match[1]);
                    people.forEach(person => insertHome(person));
                    console.log(`✅ Imported ${people.length} homes`);
                }
            }
        } catch (error) {
            console.error('Error importing data:', error);
        }
    });
}

function insertHome(home) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO homes
        (id, slug, name, biography, address, lat, lng, images, photo_date, sources, tags, published, created_at, updated_at, portrait_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const coordinates = home.coordinates || {};
    stmt.run(
        home.id || home.slug, home.slug, home.name, home.biography, home.address,
        coordinates.lat, coordinates.lng,
        JSON.stringify(home.images || []), home.photo_date,
        JSON.stringify(home.sources || []), JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0,
        home.created_at || new Date().toISOString(),
        home.updated_at || new Date().toISOString(),
        home.portrait_url || null
    );
    stmt.finalize();
}

// CRITICAL: Don't parse base64 images for list view!
function rowToHome(row, ultraLean = false) {
    if (ultraLean) {
        // Don't parse images at all - just return thumbnail path
        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            address: row.address || '',
            coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
            images: [{
                thumb: `/thumbnails/${row.id}.jpg`,
                path: `/thumbnails/${row.id}.jpg`,
                alt: row.name
            }],
            tags: JSON.parse(row.tags || '[]'),
            published: true
        };
    }
    
    // Full view
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        biography: row.biography,
        address: row.address,
        coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
        images: JSON.parse(row.images || '[]'),
        photo_date: row.photo_date,
        sources: JSON.parse(row.sources || '[]'),
        tags: JSON.parse(row.tags || '[]'),
        published: row.published === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
        portrait_url: row.portrait_url
    };
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /sys-maintenance-panel-v2.html
Disallow: /assets/
Sitemap: ${DOMAIN}/sitemap.xml`);
});

// Serve thumbnails
app.get('/thumbnails/:filename', (req, res) => {
    const thumbPath = path.join(DB_DIR, 'thumbs', req.params.filename);
    if (fs.existsSync(thumbPath)) {
        res.sendFile(thumbPath);
    } else {
        res.sendFile(path.join(__dirname, 'assets', 'img', 'placeholder.svg'));
    }
});

app.get('/sitemap.xml', (req, res) => {
    db.all('SELECT slug, updated_at FROM homes WHERE published = 1', [], (err, rows) => {
        if (err) return res.status(500).send('Error');
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        [
            { url: '', priority: '1.0', changefreq: 'weekly' },
            { url: 'addresses.html', priority: '0.9', changefreq: 'daily' },
            { url: 'map.html', priority: '0.8', changefreq: 'weekly' },
            { url: 'about.html', priority: '0.7', changefreq: 'monthly' }
        ].forEach(page => {
            xml += `  <url>\n    <loc>${DOMAIN}/${page.url}</loc>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
        });
        rows.forEach(home => {
            const lastmod = home.updated_at ? new Date(home.updated_at).toISOString().split('T')[0] : '';
            xml += `  <url>\n    <loc>${DOMAIN}/address.html?slug=${encodeURIComponent(home.slug)}</loc>\n`;
            if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
            xml += `    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>\n`;
        });
        xml += '</urlset>';
        res.type('application/xml').send(xml);
    });
});

// ULTRA LEAN API
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = 6; // Fixed at 6
    const search = req.query.search || '';
    const tag = req.query.tag || '';
    const searchMode = req.query.searchMode || 'all';
    const offset = (page - 1) * limit;
    
    let whereConditions = [];
    let params = [];
    
    if (!showAll) whereConditions.push('published = 1');
    
    // Simplified search
    if (search) {
        whereConditions.push('LOWER(name) LIKE ?');
        params.push(`%${search.trim().toLowerCase()}%`);
    }
    
    if (tag) {
        whereConditions.push('LOWER(tags) LIKE ?');
        params.push(`%${tag.toLowerCase()}%`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // Count
    db.get(`SELECT COUNT(*) as total FROM homes ${whereClause}`, params, (err, countRow) => {
        if (err) {
            console.error('Count error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const total = countRow.total;
        const totalPages = Math.ceil(total / limit);
        
        // CRITICAL: Only select columns we need!
        const query = `
            SELECT id, slug, name, address, lat, lng, tags
            FROM homes 
            ${whereClause}
            ORDER BY name 
            LIMIT ? OFFSET ?
        `;
        
        db.all(query, [...params, limit, offset], (err, rows) => {
            if (err) {
                console.error('Query error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            const homes = rows.map(row => rowToHome(row, true));
            
            res.json({
                data: homes,
                pagination: { 
                    page, 
                    limit, 
                    total, 
                    totalPages, 
                    hasNext: page < totalPages, 
                    hasPrev: page > 1 
                }
            });
            
            // CRITICAL: Immediate cleanup
            rows.length = 0;
            homes.length = 0;
            
            // Triple GC
            if (global.gc) {
                setImmediate(() => {
                    global.gc();
                    global.gc();
                    global.gc();
                });
            }
        });
    });
});

app.get('/api/homes/map', (req, res) => {
    db.all('SELECT id, slug, name, lat, lng FROM homes WHERE published = 1 AND lat IS NOT NULL AND lng IS NOT NULL', 
        [], 
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const mapData = rows.map(row => ({
                id: row.id,
                slug: row.slug,
                name: row.name,
                lat: row.lat,
                lng: row.lng
            }));
            
            res.json(mapData);
            
            if (global.gc) setImmediate(() => {
                global.gc();
                global.gc();
            });
        }
    );
});

// Tags with 5min cache
let tagsCache = null;
let tagsCacheTime = 0;

app.get('/api/tags', (req, res) => {
    const now = Date.now();
    if (tagsCache && (now - tagsCacheTime) < 300000) {
        return res.json(tagsCache);
    }
    
    db.all('SELECT DISTINCT tags FROM homes WHERE published = 1', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const tagSet = new Set();
        rows.forEach(row => {
            try {
                const tags = JSON.parse(row.tags || '[]');
                tags.forEach(tag => { if (tag) tagSet.add(String(tag)); });
            } catch (e) {}
        });
        
        const tagArray = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
        tagsCache = tagArray;
        tagsCacheTime = now;
        res.json(tagArray);
    });
});

app.get('/api/homes/:slug', (req, res) => {
    db.get('SELECT * FROM homes WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Home not found' });
        const home = rowToHome(row, false);
        res.json(home);
        if (global.gc) setImmediate(() => global.gc());
    });
});

app.post('/api/homes', (req, res) => {
    const home = req.body;
    if (!home.name) return res.status(400).json({ error: 'Name is required' });
    if (!home.slug) home.slug = home.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = new Date().toISOString();
    insertHome(home);
    tagsCache = null; 
    res.status(201).json({ message: 'Home created', id: home.id });
});

app.put('/api/homes/:id', (req, res) => {
    const home = req.body;
    home.updated_at = new Date().toISOString();
    const coordinates = home.coordinates || {};
    const stmt = db.prepare(`UPDATE homes SET slug=?, name=?, biography=?, address=?, lat=?, lng=?, images=?, photo_date=?, sources=?, tags=?, published=?, updated_at=?, portrait_url=? WHERE id=?`);
    stmt.run(
        home.slug, home.name, home.biography, home.address, coordinates.lat, coordinates.lng,
        JSON.stringify(home.images || []), home.photo_date,
        JSON.stringify(home.sources || []), JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0, home.updated_at, home.portrait_url || null, req.params.id,
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Home not found' });
            tagsCache = null;
            res.json({ message: 'Home updated' });
        }
    );
    stmt.finalize();
});

app.delete('/api/homes/:id', (req, res) => {
    db.run('DELETE FROM homes WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Home not found' });
        tagsCache = null;
        res.json({ message: 'Home deleted' });
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:page.html', (req, res) => {
    const filePath = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('Page not found');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏛️ Historic Addresses Server - ULTRA AGGRESSIVE MEMORY MODE`);
    console.log(`✅ Running on port ${PORT}`);
    console.log(`📊 DB: ${DB_FILE}`);
    console.log(`💾 Start RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB\n`);
});

// ULTRA AGGRESSIVE: GC every 20 seconds (was 60)
setInterval(() => {
    const before = process.memoryUsage();
    
    // Run GC 5 TIMES!
    if (global.gc) {
        global.gc();
        global.gc();
        global.gc();
        global.gc();
        global.gc();
    }
    
    const after = process.memoryUsage();
    const rss = Math.round(after.rss / 1024 / 1024);
    const heap = Math.round(after.heapUsed / 1024 / 1024);
    const freed = Math.round((before.heapUsed - after.heapUsed) / 1024 / 1024);
    
    console.log(`♻️  RSS: ${rss}MB | Heap: ${heap}MB | Freed: ${freed}MB`);
    
    // Clear tags cache if memory too high
    if (rss > 600) {
        tagsCache = null;
        tagsCacheTime = 0;
        recentVisits.clear();
        console.log('   🗑️  Cleared all caches (high memory)');
    }
}, 20000); // Every 20 seconds!

process.on('SIGINT', () => {
    console.log('\n🛑 Shutting down...');
    db.close((err) => {
        if (err) console.error(err.message);
        console.log('✅ Database closed');
        process.exit(0);
    });
});
