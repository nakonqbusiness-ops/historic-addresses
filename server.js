const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = 'https://historyaddress.bg';

// REDUCED: Lower JSON limit to prevent memory bloat
app.use(cors());
app.use(express.json({ limit: '5mb' })); // Reduced from 10mb
app.use(express.static(path.join(__dirname)));

// --- NEW VISITS LOGGING: MIDDLEWARE ---
app.use((req, res, next) => {
    // 1. Get the IP Address. Uses 'x-forwarded-for' for services like Render,
    // which is critical for getting the *actual* visitor IP.
    const ip = req.headers['x-forwarded-for'] ?
               req.headers['x-forwarded-for'].split(',')[0].trim() :
               req.socket.remoteAddress;

    const timestamp = new Date().toISOString();
    const path = req.originalUrl;
    const method = req.method;

    // 2. Log to Console for real-time monitoring
    console.log(`[VISIT] ${method} | IP: ${ip} | Path: ${path} | Time: ${timestamp}`);

    // 3. Save to Database (Non-blocking)
    db.run('INSERT INTO visits (ip_address, timestamp, path) VALUES (?, ?, ?)',
        [ip, timestamp, path],
        (err) => {
            if (err && !err.message.includes('no such table')) {
                // Ignore the "no such table" error if the tracking table hasn't been created yet
                console.error('Error logging visit to DB:', err);
            }
        }
    );

    // 4. Continue to the next middleware/route handler
    next();
});
// --- END NEW VISITS LOGGING: MIDDLEWARE ---

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
        // --- NEW VISITS LOGGING: INITIALIZE TABLE ---
        initializeTrackingTable(); 
        // --- END NEW VISITS LOGGING: INITIALIZE TABLE ---
    }
});

// CRITICAL: Reduce SQLite memory usage
db.configure('busyTimeout', 5000);
db.run('PRAGMA journal_mode = DELETE'); // Changed from WAL - uses less memory
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 500'); // Reduced from 1000
db.run('PRAGMA temp_store = MEMORY');
db.run('PRAGMA mmap_size = 0'); // Disable memory mapping

// --- NEW VISITS LOGGING: TRACKING TABLE CREATION ---
function initializeTrackingTable() {
    db.run(`
        CREATE TABLE IF NOT EXISTS visits (
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           ip_address TEXT,
           timestamp TEXT,
           path TEXT
        )
    `, (err) => {
        if (!err) {
            console.log('✅ Visits tracking table ready.');
        } else {
            console.error('Error creating visits table:', err);
        }
    });
}
// --- END NEW VISITS LOGGING: TRACKING TABLE CREATION ---

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

// ULTRA LEAN: No biography/sources for lists, only 1 image
function rowToHome(row, ultraLean = false) {
    if (ultraLean) {
        const images = JSON.parse(row.images || '[]');
        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            address: row.address,
            coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
            images: images.length > 0 ? [images[0]] : [],
            tags: JSON.parse(row.tags || '[]'),
            published: row.published === 1
        };
    }
    // Full data for detail pages
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

// SEO ROUTES
app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /assets/
Sitemap: ${DOMAIN}/sitemap.xml`);
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
            xml += `  <url>\n    <loc>${DOMAIN}/${page.url}</loc>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
        });
        rows.forEach(home => {
            const lastmod = home.updated_at ? new Date(home.updated_at).toISOString().split('T')[0] : '';
            xml += `  <url>\n    <loc>${DOMAIN}/address.html?slug=${encodeURIComponent(home.slug)}</loc>\n`;
            if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
            xml += `    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
        });
        xml += '</urlset>';
        res.type('application/xml').send(xml);
    });
});

// API ROUTES - ULTRA LEAN
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 6, 10); // Max 10 instead of 20
    const search = req.query.search || '';
    const tag = req.query.tag || '';
    const searchMode = req.query.searchMode || 'all';
    const offset = (page - 1) * limit;
    
    let whereConditions = [];
    let params = [];
    
    if (!showAll) whereConditions.push('published = 1');
    
    if (search) {
        if (searchMode === 'name') {
            whereConditions.push('LOWER(name) LIKE LOWER(?)');
            params.push(`%${search}%`);
        } else {
            whereConditions.push('(LOWER(name) LIKE LOWER(?) OR LOWER(biography) LIKE LOWER(?) OR LOWER(address) LIKE LOWER(?) OR LOWER(sources) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))');
            const sp = `%${search}%`;
            params.push(sp, sp, sp, sp, sp);
        }
    }
    
    if (tag) {
        whereConditions.push('LOWER(tags) LIKE LOWER(?)');
        params.push(`%${tag}%`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    db.get(`SELECT COUNT(*) as total FROM homes ${whereClause}`, params, (err, countRow) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const total = countRow.total;
        const totalPages = Math.ceil(total / limit);
        
        db.all(`SELECT * FROM homes ${whereClause} ORDER BY name LIMIT ? OFFSET ?`, [...params, limit, offset], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            
            const homes = rows.map(row => rowToHome(row, true)); // ULTRA LEAN
            
            res.json({
                data: homes,
                pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 }
            });
            
            // FORCE GC after response
            setImmediate(() => {
                if (global.gc) global.gc();
            });
        });
    });
});

// NO CACHE - Map loads fresh every time (prevents memory accumulation)
app.get('/api/homes/map', (req, res) => {
    db.all('SELECT id, slug, name, lat, lng FROM homes WHERE published = 1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        // NO IMAGES - just coordinates
        const mapData = rows.map(row => ({
            id: row.id,
            slug: row.slug,
            name: row.name,
            lat: row.lat,
            lng: row.lng
        }));
        
        res.json(mapData);
        
        // FORCE GC immediately after sending
        setImmediate(() => {
            if (global.gc) global.gc();
        });
    });
});

// Tags - Simple cache with 5min TTL
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

// Single home - Full data
app.get('/api/homes/:slug', (req, res) => {
    db.get('SELECT * FROM homes WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Home not found' });
        res.json(rowToHome(row, false));
        setImmediate(() => { if (global.gc) global.gc(); });
    });
});

// CRUD operations
app.post('/api/homes', (req, res) => {
    const home = req.body;
    if (!home.name) return res.status(400).json({ error: 'Name is required' });
    if (!home.slug) home.slug = home.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = new Date().toISOString();
    insertHome(home);
    tagsCache = null; // Clear cache
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

// Serve HTML
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:page.html', (req, res) => {
    const filePath = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(filePath)) res.sendFile(filePath);
    else res.status(404).send('Page not found');
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏛️ Historic Addresses Server - NUCLEAR MEMORY MODE`);
    console.log(`✅ Running on port ${PORT}`);
    console.log(`⚡ Ultra-lean mode: No caching, aggressive GC, minimal data`);
    console.log(`📊 DB: ${DB_FILE}\n`);
});

// AGGRESSIVE GC every 1 minute
setInterval(() => {
    if (global.gc) {
        const before = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        global.gc();
        global.gc(); // Run twice
        const after = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
        console.log(`♻️ GC: ${before}MB → ${after}MB (freed ${before - after}MB)`);
    }
    const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
    console.log(`📊 RSS: ${rss}MB`);
}, 60000);

process.on('SIGINT', () => {
    db.close((err) => {
        if (err) console.error(err.message);
        console.log('\n✅ Closed');
        process.exit(0);
    });
});
