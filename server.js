const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = 'https://historyaddress.bg';

// Keep 5mb for admin operations (adding/updating homes with images)
app.use(cors());
app.use(express.json({ limit: '5mb' })); 
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
        initializePartnersTable();
    }
});

// ULTRA AGGRESSIVE SQLITE SETTINGS
db.configure('busyTimeout', 3000);
db.run('PRAGMA journal_mode = DELETE'); 
db.run('PRAGMA synchronous = NORMAL');
db.run('PRAGMA cache_size = 50'); 
db.run('PRAGMA temp_store = MEMORY');
db.run('PRAGMA mmap_size = 0');
db.run('PRAGMA page_size = 1024'); 
db.run('PRAGMA locking_mode = NORMAL'); 

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
            // ВАЖНО ЗА СКОРОСТТА НА КАЛЕНДАРА:
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_dates ON homes(birth_date, death_date)');
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
    `, (err) => {
        if (!err) {
            console.log('✅ Partners table ready');
            db.run('CREATE INDEX IF NOT EXISTS idx_partners_published ON partners(published)');
            db.run('CREATE INDEX IF NOT EXISTS idx_partners_order ON partners(display_order)');
        } else {
            console.error('Error creating partners table:', err);
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
        
        const columnsToAdd = [];
        
        if (!columnNames.includes('portrait_url')) {
            columnsToAdd.push({ name: 'portrait_url', type: 'TEXT' });
        }
        
        if (!columnNames.includes('birth_date')) {
            columnsToAdd.push({ name: 'birth_date', type: 'TEXT' });
        }
        
        if (!columnNames.includes('death_date')) {
            columnsToAdd.push({ name: 'death_date', type: 'TEXT' });
        }
        
        if (columnsToAdd.length === 0) {
            importInitialData();
            return;
        }
        
        let addedCount = 0;
        columnsToAdd.forEach((col, index) => {
            db.run(`ALTER TABLE homes ADD COLUMN ${col.name} ${col.type}`, (err) => {
                if (err) {
                    console.error(`Migration failed for ${col.name}:`, err);
                } else {
                    console.log(`✅ Added ${col.name} column`);
                }
                
                addedCount++;
                if (addedCount === columnsToAdd.length) {
                    importInitialData();
                }
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
        } catch (error) {
            console.error('Error importing data:', error);
        }
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

function rowToHome(row, ultraLean = false) {
    if (ultraLean) {
        let firstImage = null;
        try {
            const images = JSON.parse(row.images || '[]');
            firstImage = images.length > 0 ? images[0] : null;
        } catch (e) {
            firstImage = null;
        }
        
        let tags = [];
        try {
            tags = JSON.parse(row.tags || '[]');
        } catch (e) {
            tags = [];
        }
        
        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            address: row.address || '',
            coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
            images: firstImage ? [firstImage] : [],
            tags: tags,
            published: true
        };
    }
    
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
Allow: /assets/img/Historyaddress.bg.png
Allow: /favicon.ico
Allow: /assets/img/HistAdrLogoOrig.ico
Allow: /assets/img/Historyaddress.bg2.png
Disallow: /sys-maintenance-panel-v2.html
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
            { url: 'calendar.html', priority: '0.8', changefreq: 'daily' },
            { url: 'about.html', priority: '0.7', changefreq: 'monthly' }
        ].forEach(page => {
            xml += `  <url>\n    <loc>${DOMAIN}/${page.url}</loc>\n    <changefreq>${page.changefreq}</changefreq>\n    <priority>${page.priority}</priority>\n  </url>\n`;
        });
        rows.forEach(home => {
            const lastmod = home.updated_at ? new Date(home.updated_at).toISOString().split('T')[0] : '';
            xml += `  <url>\n    <loc>${DOMAIN}/address.html?slug=${encodeURIComponent(home.slug)}</loc>\n`;
            if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
            xml += `    <changefreq>monthly</changefreq>\n    <priority>0.6</priority>\n  </url>\n`;
        });
        xml += '</urlset>';
        res.type('application/xml').send(xml);
    });
});

app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 6, 10);
    const search = req.query.search || '';
    const tag = req.query.tag || '';
    const searchMode = req.query.searchMode || 'all';
    const offset = (page - 1) * limit;
    
    let whereConditions = [];
    let params = [];
    
    if (!showAll) whereConditions.push('published = 1');
    
    if (search) {
        const searchWords = search.trim().split(/\s+/).filter(word => word.length > 0);
        
        if (searchMode === 'name') {
            const nameConditions = searchWords.map(() => 'LOWER(name) LIKE LOWER(?)');
            whereConditions.push('(' + nameConditions.join(' AND ') + ')');
            searchWords.forEach(word => params.push(`%${word}%`));
        } else {
            const allConditions = searchWords.map(() => 
                '(LOWER(name) LIKE LOWER(?) OR LOWER(biography) LIKE LOWER(?) OR LOWER(address) LIKE LOWER(?) OR LOWER(sources) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))'
            );
            whereConditions.push('(' + allConditions.join(' AND ') + ')');
            searchWords.forEach(word => {
                const sp = `%${word}%`;
                params.push(sp, sp, sp, sp, sp);
            });
        }
    }
    
    if (tag) {
        whereConditions.push('LOWER(tags) LIKE LOWER(?)');
        params.push(`%${tag}%`);
    }
    
    const whereClause = whereConditions.length > 0 ? 'WHERE ' + whereConditions.join(' AND ') : '';
    
    db.get(`SELECT COUNT(*) as total FROM homes ${whereClause}`, params, (err, countRow) => {
        if (err) {
            console.error('Count error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const total = countRow.total;
        const totalPages = Math.ceil(total / limit);
        
        const query = `
            SELECT id, slug, name, address, lat, lng, images, tags
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
            
            rows.length = 0;
            homes.length = 0;
            
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
    db.all('SELECT id, slug, name, lat, lng FROM homes WHERE published = 1 AND lat IS NOT NULL AND lng IS NOT NULL ORDER BY name', 
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
        res.json(rowToHome(row, false));
        setImmediate(() => { if (global.gc) global.gc(); });
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
    const stmt = db.prepare(`UPDATE homes SET slug=?, name=?, biography=?, address=?, lat=?, lng=?, images=?, photo_date=?, sources=?, tags=?, published=?, updated_at=?, portrait_url=?, birth_date=?, death_date=? WHERE id=?`);
    stmt.run(
        home.slug, home.name, home.biography, home.address, coordinates.lat, coordinates.lng,
        JSON.stringify(home.images || []), home.photo_date,
        JSON.stringify(home.sources || []), JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0, home.updated_at, home.portrait_url || null,
        home.birth_date || null, home.death_date || null, req.params.id,
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

// ============================================================================
// PARTNERS API
// ============================================================================

app.get('/api/partners', (req, res) => {
    const showAll = req.query.all === 'true';
    const whereClause = showAll ? '' : 'WHERE published = 1';
    
    db.all(`SELECT * FROM partners ${whereClause} ORDER BY display_order ASC, name ASC`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
        if (global.gc) setImmediate(() => global.gc());
    });
});

app.get('/api/partners/:id', (req, res) => {
    db.get('SELECT * FROM partners WHERE id = ?', [req.params.id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Partner not found' });
        res.json(row);
    });
});

app.post('/api/partners', (req, res) => {
    const p = req.body;
    if (!p.name) return res.status(400).json({ error: 'Name is required' });
    
    const id = p.id || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const now = new Date().toISOString();
    
    const stmt = db.prepare(`
        INSERT INTO partners (id, name, description, logo_url, website, instagram, email, published, display_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    stmt.run(
        id, p.name, p.description || '', p.logo_url || null, p.website || null,
        p.instagram || null, p.email || null, p.published !== false ? 1 : 0,
        p.display_order || 0, now, now,
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.status(201).json({ message: 'Partner created', id: id });
        }
    );
    stmt.finalize();
});

app.put('/api/partners/:id', (req, res) => {
    const p = req.body;
    const now = new Date().toISOString();
    
    const stmt = db.prepare(`
        UPDATE partners 
        SET name=?, description=?, logo_url=?, website=?, instagram=?, email=?, published=?, display_order=?, updated_at=?
        WHERE id=?
    `);
    
    stmt.run(
        p.name, p.description || '', p.logo_url || null, p.website || null,
        p.instagram || null, p.email || null, p.published !== false ? 1 : 0,
        p.display_order || 0, now, req.params.id,
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Partner not found' });
            res.json({ message: 'Partner updated' });
        }
    );
    stmt.finalize();
});

app.delete('/api/partners/:id', (req, res) => {
    db.run('DELETE FROM partners WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Partner not found' });
        res.json({ message: 'Partner deleted' });
    });
});

// ============================================================================
// CALENDAR API - ОПТИМИЗИРАН ЗА СКОРОСТ
// ============================================================================

app.get('/api/calendar', (req, res) => {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const viewingYear = parseInt(req.query.year) || new Date().getFullYear();
    const monthStr = String(month).padStart(2, '0');

    // Оптимизация: Използваме SQL strftime, за да изтеглим само нужния месец
    const query = `
        SELECT name, slug, birth_date, death_date 
        FROM homes 
        WHERE published = 1 
        AND (
            strftime('%m', birth_date) = ? 
            OR strftime('%m', death_date) = ?
        )
    `;

    db.all(query, [monthStr, monthStr], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const events = {};
        rows.forEach(row => {
            // Обработка на раждания
            if (row.birth_date && row.birth_date.includes(`-${monthStr}-`)) {
                const date = new Date(row.birth_date);
                const key = monthStr + '-' + String(date.getDate()).padStart(2, '0');
                if (!events[key]) events[key] = [];
                events[key].push({
                    name: row.name,
                    slug: row.slug,
                    type: 'birth',
                    full_date: row.birth_date,
                    years_ago: viewingYear - date.getFullYear()
                });
            }
            // Обработка на починали
            if (row.death_date && row.death_date.includes(`-${monthStr}-`)) {
                const date = new Date(row.death_date);
                const key = monthStr + '-' + String(date.getDate()).padStart(2, '0');
                if (!events[key]) events[key] = [];
                events[key].push({
                    name: row.name,
                    slug: row.slug,
                    type: 'death',
                    full_date: row.death_date,
                    years_ago: viewingYear - date.getFullYear()
                });
            }
        });
        
        res.json(events);
        if (global.gc) setImmediate(() => global.gc());
    });
});

app.get('/api/calendar/today', (req, res) => {
    const today = new Date();
    const monthDay = String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const viewingYear = parseInt(req.query.year) || today.getFullYear();
    
    // Оптимизация: Търсим само събития за днешната дата в SQL
    const query = `
        SELECT name, slug, birth_date, death_date 
        FROM homes 
        WHERE published = 1 
        AND (
            strftime('%m-%d', birth_date) = ? 
            OR strftime('%m-%d', death_date) = ?
        )
    `;

    db.all(query, [monthDay, monthDay], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const events = [];
        rows.forEach(row => {
            if (row.birth_date && row.birth_date.endsWith(monthDay)) {
                events.push({
                    name: row.name,
                    slug: row.slug,
                    type: 'birth',
                    years_ago: viewingYear - new Date(row.birth_date).getFullYear()
                });
            }
            if (row.death_date && row.death_date.endsWith(monthDay)) {
                events.push({
                    name: row.name,
                    slug: row.slug,
                    type: 'death',
                    years_ago: viewingYear - new Date(row.death_date).getFullYear()
                });
            }
        });
        
        res.json(events);
        if (global.gc) setImmediate(() => global.gc());
    });
});

// ============================================================================
// STATIC PAGES
// ============================================================================

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

// ULTRA AGGRESSIVE: GC every 20 seconds
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
    if (rss > 150) {
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
