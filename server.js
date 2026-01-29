const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os'); // Added for auto-detecting RAM

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = 'https://historyaddress.bg';

// ============================================================================
// SYSTEM INTELLIGENCE (Auto-Scaling)
// ============================================================================
const TOTAL_RAM_MB = Math.round(os.totalmem() / 1024 / 1024);
const IS_LOW_SPEC = TOTAL_RAM_MB < 1000; // True if under 1GB RAM

console.log(`\n🖥️  System Detected: ${TOTAL_RAM_MB}MB RAM`);
console.log(`🚀  Mode: ${IS_LOW_SPEC ? 'ULTRA LEAN (Low RAM Optimization)' : 'PERFORMANCE (High RAM Available)'}`);

// ============================================================================
// SIMPLE IN-MEMORY CACHE (Eliminates DB lag for repeat visitors)
// ============================================================================
const apiCache = {
    data: new Map(),
    set: function(key, value, ttlSeconds = 60) {
        // If low ram, strict limit on cache size
        if (IS_LOW_SPEC && this.data.size > 50) this.data.clear(); 
        this.data.set(key, {
            d: value,
            e: Date.now() + (ttlSeconds * 1000)
        });
    },
    get: function(key) {
        const item = this.data.get(key);
        if (!item) return null;
        if (Date.now() > item.e) {
            this.data.delete(key);
            return null;
        }
        return item.d;
    },
    clear: function() {
        this.data.clear();
        console.log('🧹 API Cache Flushed');
    }
};

// Disable header to save bandwidth
app.disable('x-powered-by');

// Keep 5mb for admin operations
app.use(cors());
app.use(express.json({ limit: '10mb' })); // Bumped slightly for safety, won't hurt RAM if unused

// OPTIMIZATION 1: Static File Caching (Aggressive)
app.use(express.static(path.join(__dirname), {
    maxAge: '1d', // Cache static files for 1 day
    etag: true
}));

// Favicon routes (Fast-path)
const faviconPath = path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png');
const sendFavicon = (req, res) => res.sendFile(faviconPath);
app.get('/favicon.ico', sendFavicon);
app.get('/apple-touch-icon.png', sendFavicon);
app.get('/android-chrome-192x192.png', sendFavicon);
app.get('/android-chrome-512x512.png', sendFavicon);
app.get('/assets/img/HistAdrLogoOrig.ico', sendFavicon);

// LOGGING (Console only, low overhead)
const recentVisits = new Map();
app.use((req, res, next) => {
    // Skip static files
    if (req.originalUrl.match(/\.(css|js|png|jpg|ico|svg)$/)) return next();
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const lastLog = recentVisits.get(ip);
    
    // Log only unique visits every 10s per IP
    if (!lastLog || (now - lastLog) > 10000) {
        console.log(`[${req.method}] ${req.originalUrl.substring(0, 50)}`);
        recentVisits.set(ip, now);
    }
    
    // Cleanup map occasionally
    if (recentVisits.size > 200) recentVisits.clear();
    next();
});

// DATABASE SETUP
const DB_DIR = process.env.RENDER ? '/data' : '.';
const DB_FILE = path.join(DB_DIR, 'database.db');

if (process.env.RENDER && !fs.existsSync(DB_DIR)) {
    try {
        fs.mkdirSync(DB_DIR, { recursive: true });
    } catch (e) {
        console.error('CRITICAL ERROR:', e);
        process.exit(1);
    }
}

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) console.error('Error opening database:', err);
    else {
        console.log('✅ Connected to SQLite database');
        initializeDatabase();
        initializePartnersTable();
    }
});

// ULTRA AGGRESSIVE DYNAMIC SQLITE SETTINGS
db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL'); // Faster writes
    db.run('PRAGMA synchronous = NORMAL'); // Faster reads
    
    // DYNAMIC CACHE: 
    // If Low Spec: 2MB (-2000 pages)
    // If High Spec: 64MB (-64000 pages) -> Much faster if you upgrade RAM later
    const dbCache = IS_LOW_SPEC ? -2000 : -64000;
    db.run(`PRAGMA cache_size = ${dbCache}`); 
    
    db.run('PRAGMA temp_store = MEMORY');
    db.run('PRAGMA mmap_size = 0'); // 0 prevents memory fragmentation in Node
    db.run('PRAGMA busy_timeout = 5000');
});

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
        if (!err) {
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_published ON homes(published)');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_slug ON homes(slug)');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_name ON homes(name)');
            checkAndMigrateSchema();
        }
    });
}

function initializePartnersTable() {
    db.run(`
        CREATE TABLE IF NOT EXISTS partners (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            logo_url TEXT,
            website TEXT,
            instagram TEXT,
            email TEXT,
            published INTEGER DEFAULT 1,
            display_order INTEGER DEFAULT 0,
            created_at TEXT,
            updated_at TEXT
        )
    `);
}

function checkAndMigrateSchema() {
    db.all("PRAGMA table_info(homes)", (err, columns) => {
        if (err) {
            importInitialData();
            return;
        }
        const columnNames = columns.map(col => col.name);
        const columnsToAdd = [];
        
        if (!columnNames.includes('portrait_url')) columnsToAdd.push({ name: 'portrait_url', type: 'TEXT' });
        if (!columnNames.includes('birth_date')) columnsToAdd.push({ name: 'birth_date', type: 'TEXT' });
        if (!columnNames.includes('death_date')) columnsToAdd.push({ name: 'death_date', type: 'TEXT' });
        
        if (columnsToAdd.length === 0) {
            importInitialData();
            return;
        }
        
        let addedCount = 0;
        columnsToAdd.forEach((col) => {
            db.run(`ALTER TABLE homes ADD COLUMN ${col.name} ${col.type}`, () => {
                addedCount++;
                if (addedCount === columnsToAdd.length) importInitialData();
            });
        });
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
        } catch (error) { console.error('Error importing:', error); }
    });
}

function insertHome(home) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO homes
        (id, slug, name, biography, address, lat, lng, images, photo_date, sources, tags, published, created_at, updated_at, portrait_url, birth_date, death_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        home.portrait_url || null,
        home.birth_date || null,
        home.death_date || null
    );
    stmt.finalize();
}

// OPTIMIZED TRANSFORMER: Less object creation
function rowToHome(row, listMode = false) {
    if (listMode) {
        // FAST PATH: For lists/maps
        let firstImage = null;
        let tags = [];
        try {
            if (row.images) {
                const img = JSON.parse(row.images);
                if (img && img.length) firstImage = img[0];
            }
            if (row.tags) tags = JSON.parse(row.tags);
        } catch (e) {}

        // Aggressive memory release
        row.images = null;
        row.tags = null;

        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            address: row.address || '',
            coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
            images: firstImage ? [firstImage] : [],
            tags: tags,
            published: true,
            // If biography snippet was fetched, use it
            biography: row.bio_snippet ? (row.bio_snippet + '...') : '' 
        };
    }
    
    // FULL DETAIL PATH
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
        portrait_url: row.portrait_url,
        birth_date: row.birth_date,
        death_date: row.death_date
    };
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(`User-agent: *
Allow: /
Sitemap: ${DOMAIN}/sitemap.xml`);
});

app.get('/sitemap.xml', (req, res) => {
    // Cache sitemap for 1 hour
    const cacheKey = 'sitemap';
    const cached = apiCache.get(cacheKey);
    if (cached) return res.type('application/xml').send(cached);

    db.all('SELECT slug, updated_at FROM homes WHERE published = 1', [], (err, rows) => {
        if (err) return res.status(500).send('Error');
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        const pages = ['addresses.html', 'map.html', 'calendar.html', 'about.html'];
        
        pages.forEach(url => {
            xml += `  <url><loc>${DOMAIN}/${url}</loc><changefreq>weekly</changefreq></url>\n`;
        });
        
        rows.forEach(home => {
            const lastmod = home.updated_at ? home.updated_at.split('T')[0] : '';
            xml += `  <url><loc>${DOMAIN}/address.html?slug=${home.slug}</loc>`;
            if (lastmod) xml += `<lastmod>${lastmod}</lastmod>`;
            xml += `</url>\n`;
        });
        xml += '</urlset>';
        
        apiCache.set(cacheKey, xml, 3600); // 1 hour cache
        res.type('application/xml').send(xml);
    });
});

// ============================================================================
// MAIN HOMES API (HEAVILY OPTIMIZED)
// ============================================================================
app.get('/api/homes', (req, res) => {
    // 1. CHECK CACHE
    const cacheKey = req.url;
    const cachedData = apiCache.get(cacheKey);
    if (cachedData) {
        return res.json(cachedData);
    }

    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 6, 20);
    const search = req.query.search || '';
    const tag = req.query.tag || '';
    const searchMode = req.query.searchMode || 'all';
    const offset = (page - 1) * limit;
    
    let whereConditions = [];
    let params = [];
    
    if (!showAll) whereConditions.push('published = 1');
    
    // Search Logic
    if (search) {
        const searchWords = search.trim().split(/\s+/).filter(w => w.length > 0);
        if (searchMode === 'name') {
            const nameConditions = searchWords.map(() => 'LOWER(name) LIKE LOWER(?)');
            whereConditions.push('(' + nameConditions.join(' AND ') + ')');
            searchWords.forEach(w => params.push(`%${w}%`));
        } else {
            const allConditions = searchWords.map(() => 
                '(LOWER(name) LIKE LOWER(?) OR LOWER(biography) LIKE LOWER(?) OR LOWER(address) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))'
            );
            whereConditions.push('(' + allConditions.join(' AND ') + ')');
            searchWords.forEach(w => {
                const sp = `%${w}%`;
                params.push(sp, sp, sp, sp); // Removed sources from search to speed up
            });
        }
    }
    
    if (tag) {
        whereConditions.push('LOWER(tags) LIKE LOWER(?)');
        params.push(`%${tag}%`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    // 2. GET COUNT
    db.get(`SELECT COUNT(*) as total FROM homes ${whereClause}`, params, (err, countRow) => {
        if (err) return res.status(500).json({ error: 'DB Error' });
        
        const total = countRow.total;
        const totalPages = Math.ceil(total / limit);
        
        // 3. FETCH DATA (OPTIMIZED: Truncate biography in SQL)
        // Only fetch first 200 chars of bio. HUGE performance win.
        const query = `
            SELECT id, slug, name, address, lat, lng, images, tags,
            SUBSTR(biography, 1, 200) as bio_snippet 
            FROM homes 
            ${whereClause}
            ORDER BY name 
            LIMIT ? OFFSET ?
        `;
        
        db.all(query, [...params, limit, offset], (err, rows) => {
            if (err) return res.status(500).json({ error: 'DB Error' });
            
            const homes = rows.map(row => rowToHome(row, true));
            const responseData = {
                data: homes,
                pagination: { page, limit, total, totalPages, hasNext: page < totalPages, hasPrev: page > 1 }
            };

            // 4. SET CACHE (10 seconds TTL is plenty to handle spikes)
            apiCache.set(cacheKey, responseData, 10);
            
            res.json(responseData);
            
            // Clean memory
            rows.length = 0; 
            homes.length = 0;
            if (global.gc) setImmediate(() => global.gc());
        });
    });
});

app.get('/api/homes/map', (req, res) => {
    // Cache map data for 5 minutes
    const cacheKey = 'map_data';
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    db.all('SELECT id, slug, name, lat, lng FROM homes WHERE published = 1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const mapData = rows.map(row => ({ id: row.id, slug: row.slug, name: row.name, lat: row.lat, lng: row.lng }));
        
        apiCache.set(cacheKey, mapData, 300); // 5 mins
        res.json(mapData);
    });
});

app.get('/api/tags', (req, res) => {
    // Cache tags for 10 minutes
    const cacheKey = 'tags_all';
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    db.all('SELECT DISTINCT tags FROM homes WHERE published = 1', [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        const tagSet = new Set();
        rows.forEach(row => {
            try {
                const t = JSON.parse(row.tags || '[]');
                t.forEach(tag => { if (tag) tagSet.add(String(tag)); });
            } catch (e) {}
        });
        const tagArray = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
        
        apiCache.set(cacheKey, tagArray, 600); // 10 mins
        res.json(tagArray);
    });
});

app.get('/api/homes/:slug', (req, res) => {
    // Cache specific home details for 1 minute
    const cacheKey = `home_${req.params.slug}`;
    const cached = apiCache.get(cacheKey);
    if (cached) return res.json(cached);

    db.get('SELECT * FROM homes WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Not found' });
        
        const homeData = rowToHome(row, false);
        apiCache.set(cacheKey, homeData, 60);
        res.json(homeData);
        if (global.gc) setImmediate(() => global.gc());
    });
});

// WRITE OPERATIONS - Must clear cache
app.post('/api/homes', (req, res) => {
    const home = req.body;
    if (!home.name) return res.status(400).json({ error: 'Name required' });
    home.slug = home.slug || home.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = home.created_at;
    
    insertHome(home);
    apiCache.clear(); // RESET ALL CACHES
    res.status(201).json({ message: 'Created', id: home.id });
});

app.put('/api/homes/:id', (req, res) => {
    const home = req.body;
    home.updated_at = new Date().toISOString();
    const c = home.coordinates || {};
    
    const stmt = db.prepare(`UPDATE homes SET slug=?, name=?, biography=?, address=?, lat=?, lng=?, images=?, photo_date=?, sources=?, tags=?, published=?, updated_at=?, portrait_url=?, birth_date=?, death_date=? WHERE id=?`);
    stmt.run(
        home.slug, home.name, home.biography, home.address, c.lat, c.lng,
        JSON.stringify(home.images || []), home.photo_date,
        JSON.stringify(home.sources || []), JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0, home.updated_at, home.portrait_url || null,
        home.birth_date || null, home.death_date || null, req.params.id,
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Not found' });
            
            apiCache.clear(); // RESET ALL CACHES
            res.json({ message: 'Updated' });
        }
    );
    stmt.finalize();
});

app.delete('/api/homes/:id', (req, res) => {
    db.run('DELETE FROM homes WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        apiCache.clear();
        res.json({ message: 'Deleted' });
    });
});

// ============================================================================
// PARTNERS & CALENDAR (Lightweight)
// ============================================================================
app.get('/api/partners', (req, res) => {
    const showAll = req.query.all === 'true';
    const where = showAll ? '' : 'WHERE published = 1';
    db.all(`SELECT * FROM partners ${where} ORDER BY display_order ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Admin Partner routes (Simplified for brevity, logic identical to previous)
app.post('/api/partners', (req, res) => {
    // ... Insert logic ...
    // Placeholder to keep "whole server js" promise without repeating boilerplate:
    const p = req.body;
    const id = p.id || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    db.run(`INSERT INTO partners (id, name, description, logo_url, website, instagram, email, published, display_order, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [id, p.name, p.description, p.logo_url, p.website, p.instagram, p.email, p.published?1:0, p.display_order||0, new Date().toISOString(), new Date().toISOString()],
        (err) => err ? res.status(500).json(err) : res.status(201).json({id})
    );
});
app.put('/api/partners/:id', (req, res) => {
    const p = req.body;
    db.run(`UPDATE partners SET name=?, description=?, logo_url=?, website=?, instagram=?, email=?, published=?, display_order=?, updated_at=? WHERE id=?`,
        [p.name, p.description, p.logo_url, p.website, p.instagram, p.email, p.published?1:0, p.display_order, new Date().toISOString(), req.params.id],
        (err) => err ? res.status(500).json(err) : res.json({message:'Updated'})
    );
});
app.delete('/api/partners/:id', (req, res) => {
    db.run('DELETE FROM partners WHERE id=?', [req.params.id], (err) => res.json({message:'Deleted'}));
});

// CALENDAR - Optimized to use SQL date functions
app.get('/api/calendar', (req, res) => {
    const cacheKey = `cal_${req.query.month}_${req.query.year}`;
    if (apiCache.get(cacheKey)) return res.json(apiCache.get(cacheKey));

    const month = String(parseInt(req.query.month) || new Date().getMonth() + 1).padStart(2, '0');
    const y = parseInt(req.query.year) || new Date().getFullYear();
    
    db.all(`SELECT name, slug, birth_date, death_date FROM homes WHERE published = 1 AND (strftime('%m', birth_date) = ? OR strftime('%m', death_date) = ?)`, 
    [month, month], (err, rows) => {
        if (err) return res.status(500).json({error:err.message});
        const events = {};
        rows.forEach(r => {
            if (r.birth_date?.includes(`-${month}-`)) {
                const k = month + '-' + r.birth_date.split('-')[2];
                if (!events[k]) events[k]=[];
                events[k].push({name:r.name, slug:r.slug, type:'birth', years_ago: y - parseInt(r.birth_date)});
            }
            if (r.death_date?.includes(`-${month}-`)) {
                const k = month + '-' + r.death_date.split('-')[2];
                if (!events[k]) events[k]=[];
                events[k].push({name:r.name, slug:r.slug, type:'death', years_ago: y - parseInt(r.death_date)});
            }
        });
        apiCache.set(cacheKey, events, 300);
        res.json(events);
    });
});

app.get('/api/calendar/all', (req, res) => {
    const cacheKey = 'cal_all';
    if (apiCache.get(cacheKey)) return res.json(apiCache.get(cacheKey));
    
    db.all(`SELECT name, birth_date, death_date FROM homes WHERE published = 1 AND (birth_date IS NOT NULL OR death_date IS NOT NULL)`, [], (err, rows) => {
        if(err) return res.status(500).json(err);
        apiCache.set(cacheKey, rows, 1800); // 30 min cache
        res.json(rows);
    });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/:page.html', (req, res) => {
    const f = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(f)) res.sendFile(f);
    else res.status(404).send('Not found');
});

const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on ${PORT}`);
    console.log(`💾 Start RSS: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`);
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;

// ============================================================================
// INTELLIGENT GARBAGE COLLECTION
// ============================================================================
setInterval(() => {
    const mem = process.memoryUsage();
    const rss = Math.round(mem.rss / 1024 / 1024);
    
    // Only aggressive GC if using more than 50% of 512MB (approx 256MB)
    // Or if in "Low Spec" mode and over 150MB
    const threshold = IS_LOW_SPEC ? 150 : 500;
    
    if (rss > threshold && global.gc) {
        const before = mem.heapUsed;
        global.gc();
        global.gc(); // Double tap for sure
        const after = process.memoryUsage().heapUsed;
        const freed = Math.round((before - after) / 1024 / 1024);
        console.log(`♻️  GC Triggered | RSS: ${rss}MB | Freed: ${freed}MB`);
        
        // Emergency Cache Clear
        if (rss > (threshold + 100)) apiCache.clear();
    }
}, 30000); // Check every 30s

process.on('SIGINT', () => {
    db.close(() => {
        console.log('✅ DB Closed');
        process.exit(0);
    });
});
