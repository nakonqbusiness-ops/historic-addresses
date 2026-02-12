const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();

const PORT = process.env.PORT || 10000;
const NODE_ENV = process.env.NODE_ENV || 'production';
const DOMAIN = 'https://historyaddress.bg';

const possiblePaths = [
    process.env.DB_PATH,
    '/data/database.db',
    '/opt/render/project/src/database.db',
    path.join(__dirname, 'database.db'),
    './database.db'
].filter(Boolean);

let DB_FILE = null;
for (const dbPath of possiblePaths) {
    if (fs.existsSync(dbPath)) {
        DB_FILE = dbPath;
        console.log('✅ Found existing database at:', dbPath);
        break;
    }
}

if (!DB_FILE) {
    const DB_DIR = process.env.RENDER ? '/data' : '.';
    DB_FILE = path.join(DB_DIR, 'database.db');
    console.log('⚠️  No existing database found, will create new at:', DB_FILE);
}

const MANUAL_HIGH_PERFORMANCE_MODE = false;

const TOTAL_RAM_MB = MANUAL_HIGH_PERFORMANCE_MODE 
    ? 2048 
    : (process.env.RENDER ? 512 : Math.round(os.totalmem() / 1024 / 1024));

const IS_LOW_SPEC = MANUAL_HIGH_PERFORMANCE_MODE ? false : (TOTAL_RAM_MB < 1024);

console.log(`\n🚀 HistoryAddress Server Starting...`);
console.log(`🌍 Domain: ${DOMAIN}`);
console.log(`📦 DB Path: ${DB_FILE}`);
console.log(`🖥️  RAM Detected: ${TOTAL_RAM_MB}MB`);
console.log(`⚡ Mode: ${IS_LOW_SPEC ? 'ULTRA LEAN (512MB Optimization)' : 'PERFORMANCE (High RAM Available)'}`);

const apiCache = {
    data: new Map(),
    maxSize: IS_LOW_SPEC ? 50 : 200,
    
    set: function(key, value, ttlSeconds = 60) {
        if (this.data.size >= this.maxSize) {
            const toRemove = Math.floor(this.maxSize * 0.25);
            const keys = Array.from(this.data.keys()).slice(0, toRemove);
            keys.forEach(k => this.data.delete(k));
        }
        
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
    },
    
    getStats: function() {
        return {
            size: this.data.size,
            maxSize: this.maxSize
        };
    }
};

app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const recentVisits = new Map();
app.use((req, res, next) => {
    if (req.originalUrl.match(/\.(css|js|png|jpg|jpeg|ico|svg|webp|woff|woff2|ttf)$/)) {
        return next();
    }
    
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    const now = Date.now();
    const lastLog = recentVisits.get(ip);
    
    if (!lastLog || (now - lastLog) > 10000) {
        const time = new Date().toISOString().replace('T', ' ').substring(0, 19);
        console.log(`[${time}] ${ip} -> ${req.method} ${req.originalUrl.substring(0, 60)}`);
        recentVisits.set(ip, now);
    }
    
    if (recentVisits.size > 200) {
        const cutoff = now - 60000;
        for (const [key, value] of recentVisits.entries()) {
            if (value < cutoff) recentVisits.delete(key);
        }
    }
    
    next();
});

app.use(express.static(path.join(__dirname), {
    maxAge: '1d',
    etag: true,
    immutable: true
}));

const faviconPath = path.join(__dirname, 'assets', 'img', 'Historyaddress.bg2.png');
const sendFavicon = (req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(faviconPath);
};
app.get('/favicon.ico', sendFavicon);
app.get('/apple-touch-icon.png', sendFavicon);
app.get('/android-chrome-192x192.png', sendFavicon);
app.get('/android-chrome-512x512.png', sendFavicon);
app.get('/assets/img/HistAdrLogoOrig.ico', sendFavicon);

const dbDirectory = path.dirname(DB_FILE);
if (!fs.existsSync(dbDirectory)) {
    try {
        fs.mkdirSync(dbDirectory, { recursive: true });
        console.log('✅ Created database directory:', dbDirectory);
    } catch (e) {
        console.error('❌ CRITICAL: Cannot create DB directory:', e);
        console.error('Path attempted:', dbDirectory);
        process.exit(1);
    }
}

try {
    fs.accessSync(dbDirectory, fs.constants.W_OK);
    console.log('✅ Database directory is writable');
} catch (e) {
    console.error('❌ CRITICAL: Database directory not writable:', dbDirectory);
    process.exit(1);
}

let dbReady = false;

const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('❌ Database connection error:', err);
        console.error('DB File Path:', DB_FILE);
        console.error('DB Directory:', dbDirectory);
        process.exit(1);
    } else {
        console.log('✅ SQLite Connected:', DB_FILE);
        initializeDatabase();
        initializePartnersTable();
    }
});

db.serialize(() => {
    db.run('PRAGMA journal_mode = WAL');
    db.run('PRAGMA synchronous = NORMAL');
    db.run('PRAGMA temp_store = MEMORY');
    db.run('PRAGMA busy_timeout = 5000');
    
    const dbCacheSize = IS_LOW_SPEC ? -2000 : -64000;
    db.run(`PRAGMA cache_size = ${dbCacheSize}`);
    console.log(`📊 SQLite cache: ${IS_LOW_SPEC ? '2MB' : '64MB'}`);
    
    db.run('PRAGMA mmap_size = 0');
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
           portrait_url TEXT,
           birth_date TEXT,
           death_date TEXT
        )
    `, (err) => {
        if (err) {
            console.error('❌ Error creating homes table:', err);
            return;
        }
        
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_published ON homes(published)');
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_slug ON homes(slug)');
        db.run('CREATE INDEX IF NOT EXISTS idx_homes_name ON homes(name)');
        
        console.log('✅ Homes table initialized');
        checkAndMigrateSchema();
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
        if (!err) console.log('✅ Partners table initialized');
    });
}

function checkAndMigrateSchema() {
    db.all("PRAGMA table_info(homes)", (err, columns) => {
        if (err) {
            console.error('Schema check error:', err);
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
        columnsToAdd.forEach((col) => {
            db.run(`ALTER TABLE homes ADD COLUMN ${col.name} ${col.type}`, (err) => {
                if (!err) {
                    console.log(`✅ Added column: ${col.name}`);
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
    db.serialize(() => {
        db.get('SELECT COUNT(*) as count FROM homes', (err, row) => {
            if (err) {
                console.error('❌ Error checking DB count:', err);
                dbReady = true;
                return;
            }

            if (row && row.count > 0) {
                console.log(`📊 Database has ${row.count} homes. Ready.`);
                dbReady = true;
                return;
            }
            
            console.log('⚠️  Database is empty. Attempting import from people.js...');

            try {
                const dataPath = path.join(__dirname, 'data', 'people.js');
                
                if (!fs.existsSync(dataPath)) {
                    console.error('❌ CRITICAL: people.js NOT FOUND at:', dataPath);
                    console.error('   Please ensure the data folder is included in the build.');
                    dbReady = true;
                    return;
                }

                const fileContent = fs.readFileSync(dataPath, 'utf8');
                const match = fileContent.match(/var\s+PEOPLE\s*=\s*(\[[\s\S]*?\]);/);
                
                if (match) {
                    const people = JSON.parse(match[1]);
                    let imported = 0;
                    
                    db.serialize(() => {
                        db.run("BEGIN TRANSACTION");
                        people.forEach(person => {
                            insertHome(person);
                            imported++;
                        });
                        db.run("COMMIT", () => {
                            console.log(`✅ Imported ${imported} initial homes from people.js`);
                            dbReady = true;
                            apiCache.clear();
                        });
                    });
                } else {
                    console.log('⚠️  Could not parse people.js variable structure');
                    dbReady = true;
                }
            } catch (error) {
                console.error('❌ Error importing initial data:', error.message);
                dbReady = true;
            }
        });
    });
}

function insertHome(home) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO homes
        (id, slug, name, biography, address, lat, lng, images, photo_date, 
         sources, tags, published, created_at, updated_at, portrait_url, 
         birth_date, death_date)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const coordinates = home.coordinates || {};
    const now = new Date().toISOString();
    
    stmt.run(
        home.id || home.slug,
        home.slug,
        home.name,
        home.biography,
        home.address,
        coordinates.lat || null,
        coordinates.lng || null,
        JSON.stringify(home.images || []),
        home.photo_date || null,
        JSON.stringify(home.sources || []),
        JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0,
        home.created_at || now,
        home.updated_at || now,
        home.portrait_url || null,
        home.birth_date || null,
        home.death_date || null
    );
    
    stmt.finalize();
}

function rowToHome(row, listMode = false) {
    if (listMode) {
        let firstImage = null;
        let tags = [];
        
        try {
            if (row.images) {
                const img = JSON.parse(row.images);
                if (img && img.length > 0) firstImage = img[0];
            }
            if (row.tags) {
                tags = JSON.parse(row.tags);
            }
        } catch (e) {}
        
        return {
            id: row.id,
            slug: row.slug,
            name: row.name,
            address: row.address || '',
            coordinates: (row.lat && row.lng) ? { lat: row.lat, lng: row.lng } : null,
            images: firstImage ? [firstImage] : [],
            tags: tags,
            published: true,
            biography: row.bio_snippet ? (row.bio_snippet + '...') : ''
        };
    }
    
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        biography: row.biography,
        address: row.address,
        coordinates: (row.lat && row.lng) ? { lat: row.lat, lng: row.lng } : null,
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
    const cacheKey = 'sitemap_xml';
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.type('application/xml').send(cached);
    }

    db.all('SELECT slug, updated_at FROM homes WHERE published = 1', [], (err, rows) => {
        if (err) {
            console.error('Sitemap error:', err);
            return res.status(500).send('Error generating sitemap');
        }
        
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        
        const pages = ['index.html', 'addresses.html', 'map.html', 'calendar.html', 'about.html'];
        pages.forEach(page => {
            xml += `  <url>\n`;
            xml += `    <loc>${DOMAIN}/${page}</loc>\n`;
            xml += `    <changefreq>weekly</changefreq>\n`;
            xml += `  </url>\n`;
        });
        
        rows.forEach(home => {
            const lastmod = home.updated_at ? home.updated_at.split('T')[0] : '';
            xml += `  <url>\n`;
            xml += `    <loc>${DOMAIN}/address.html?slug=${home.slug}</loc>\n`;
            if (lastmod) xml += `    <lastmod>${lastmod}</lastmod>\n`;
            xml += `  </url>\n`;
        });
        
        xml += '</urlset>';
        
        apiCache.set(cacheKey, xml, 3600);
        res.type('application/xml').send(xml);
    });
});

app.get('/api/homes', (req, res) => {
    const cacheKey = req.url;
    const cachedData = apiCache.get(cacheKey);
    
    if (cachedData && cachedData.data && cachedData.data.length > 0) {
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
    
    if (!showAll) {
        whereConditions.push('published = 1');
    }
    
    if (search) {
        const searchWords = search.trim().split(/\s+/).filter(w => w.length > 0);
        
        if (searchMode === 'name') {
            const nameConditions = searchWords.map(() => 'LOWER(name) LIKE LOWER(?)');
            whereConditions.push('(' + nameConditions.join(' AND ') + ')');
            searchWords.forEach(word => params.push(`%${word}%`));
        } else {
            const allConditions = searchWords.map(() => 
                '(LOWER(name) LIKE LOWER(?) OR LOWER(biography) LIKE LOWER(?) OR LOWER(address) LIKE LOWER(?) OR LOWER(tags) LIKE LOWER(?))'
            );
            whereConditions.push('(' + allConditions.join(' AND ') + ')');
            searchWords.forEach(word => {
                const searchParam = `%${word}%`;
                params.push(searchParam, searchParam, searchParam, searchParam);
            });
        }
    }
    
    if (tag) {
        whereConditions.push('LOWER(tags) LIKE LOWER(?)');
        params.push(`%${tag}%`);
    }
    
    const whereClause = whereConditions.length > 0 
        ? 'WHERE ' + whereConditions.join(' AND ') 
        : '';
    
    db.get(`SELECT COUNT(*) as total FROM homes ${whereClause}`, params, (err, countRow) => {
        if (err) {
            console.error('Count error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const total = countRow.total;
        const totalPages = Math.ceil(total / limit);
        
        const query = `
            SELECT 
                id, slug, name, address, lat, lng, images, tags,
                SUBSTR(biography, 1, 200) as bio_snippet 
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
            
            const responseData = {
                data: homes,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages,
                    hasNext: page < totalPages,
                    hasPrev: page > 1
                }
            };

            const hasFilters = search || tag;
            const shouldCache = homes.length > 0 || hasFilters;
            
            if (shouldCache) {
                apiCache.set(cacheKey, responseData, IS_LOW_SPEC ? 10 : 30);
            } else {
                console.log('⚠️  Skipping cache for empty unfiltered result');
            }
            
            res.json(responseData);
            
            if (IS_LOW_SPEC && global.gc) {
                setImmediate(() => {
                    rows.length = 0;
                    homes.length = 0;
                    global.gc();
                });
            }
        });
    });
});

app.get('/api/homes/map', (req, res) => {
    const cacheKey = 'map_data_all';
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }

    const query = `
        SELECT id, slug, name, lat, lng 
        FROM homes 
        WHERE published = 1 AND lat IS NOT NULL AND lng IS NOT NULL 
        ORDER BY name
    `;

    db.all(query, [], (err, rows) => {
        if (err) {
            console.error('Map data error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const mapData = rows.map(row => ({
            id: row.id,
            slug: row.slug,
            name: row.name,
            lat: row.lat,
            lng: row.lng
        }));
        
        apiCache.set(cacheKey, mapData, 300);
        res.json(mapData);
    });
});

app.get('/api/homes/:slug', (req, res) => {
    const cacheKey = `home_detail_${req.params.slug}`;
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }

    db.get(
        'SELECT * FROM homes WHERE slug = ? OR id = ?', 
        [req.params.slug, req.params.slug], 
        (err, row) => {
            if (err) {
                console.error('Home detail error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (!row) {
                return res.status(404).json({ error: 'Home not found' });
            }
            
            const homeData = rowToHome(row, false);
            apiCache.set(cacheKey, homeData, 60);
            res.json(homeData);
            
            if (IS_LOW_SPEC && global.gc) {
                setImmediate(() => global.gc());
            }
        }
    );
});

app.get('/api/tags', (req, res) => {
    const cacheKey = 'tags_list_all';
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }

    db.all(
        'SELECT DISTINCT tags FROM homes WHERE published = 1', 
        [], 
        (err, rows) => {
            if (err) {
                console.error('Tags error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            const tagSet = new Set();
            
            rows.forEach(row => {
                try {
                    const tags = JSON.parse(row.tags || '[]');
                    tags.forEach(tag => {
                        if (tag && typeof tag === 'string') {
                            tagSet.add(tag.trim());
                        }
                    });
                } catch (e) {}
            });
            
            const tagArray = Array.from(tagSet).sort((a, b) => 
                a.localeCompare(b, 'bg')
            );
            
            apiCache.set(cacheKey, tagArray, 600);
            res.json(tagArray);
        }
    );
});

app.post('/api/homes', (req, res) => {
    const home = req.body;
    
    if (!home.name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    
    if (!home.slug) {
        home.slug = home.name
            .toLowerCase()
            .replace(/[^a-z0-9\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/-+/g, '-')
            .replace(/(^-|-$)/g, '');
    }
    
    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = home.created_at;
    
    insertHome(home);
    
    apiCache.clear();
    
    res.status(201).json({ 
        message: 'Home created successfully', 
        id: home.id,
        slug: home.slug
    });
});

app.put('/api/homes/:id', (req, res) => {
    const home = req.body;
    home.updated_at = new Date().toISOString();
    
    const coordinates = home.coordinates || {};
    
    const stmt = db.prepare(`
        UPDATE homes SET 
            slug = ?, name = ?, biography = ?, address = ?,
            lat = ?, lng = ?, images = ?, photo_date = ?,
            sources = ?, tags = ?, published = ?, updated_at = ?,
            portrait_url = ?, birth_date = ?, death_date = ?
        WHERE id = ?
    `);
    
    stmt.run(
        home.slug,
        home.name,
        home.biography,
        home.address,
        coordinates.lat || null,
        coordinates.lng || null,
        JSON.stringify(home.images || []),
        home.photo_date || null,
        JSON.stringify(home.sources || []),
        JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0,
        home.updated_at,
        home.portrait_url || null,
        home.birth_date || null,
        home.death_date || null,
        req.params.id,
        function(err) {
            if (err) {
                console.error('Update error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Home not found' });
            }
            
            apiCache.clear();
            res.json({ message: 'Home updated successfully' });
        }
    );
    
    stmt.finalize();
});

app.delete('/api/homes/:id', (req, res) => {
    db.run('DELETE FROM homes WHERE id = ?', [req.params.id], function(err) {
        if (err) {
            console.error('Delete error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        apiCache.clear();
        
        res.json({ 
            message: 'Home deleted successfully',
            deleted: this.changes > 0
        });
    });
});

app.get('/api/partners', (req, res) => {
    const showAll = req.query.all === 'true';
    const whereClause = showAll ? '' : 'WHERE published = 1';
    
    db.all(
        `SELECT * FROM partners ${whereClause} ORDER BY display_order ASC, name ASC`, 
        [], 
        (err, rows) => {
            if (err) {
                console.error('Partners error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.json(rows || []);
        }
    );
});

app.post('/api/partners', (req, res) => {
    const p = req.body;
    
    if (!p.name) {
        return res.status(400).json({ error: 'Name is required' });
    }
    
    const id = p.id || p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const now = new Date().toISOString();
    
    db.run(`
        INSERT INTO partners 
        (id, name, description, logo_url, website, instagram, email, published, display_order, created_at, updated_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
        [
            id, 
            p.name, 
            p.description || null, 
            p.logo_url || null, 
            p.website || null, 
            p.instagram || null, 
            p.email || null, 
            p.published !== false ? 1 : 0, 
            p.display_order || 0, 
            now, 
            now
        ],
        (err) => {
            if (err) {
                console.error('Partner create error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            res.status(201).json({ id, message: 'Partner created successfully' });
        }
    );
});

app.put('/api/partners/:id', (req, res) => {
    const p = req.body;
    const now = new Date().toISOString();
    
    db.run(`
        UPDATE partners SET 
            name = ?, description = ?, logo_url = ?, website = ?,
            instagram = ?, email = ?, published = ?, display_order = ?,
            updated_at = ?
        WHERE id = ?
    `,
        [
            p.name, 
            p.description || null, 
            p.logo_url || null, 
            p.website || null, 
            p.instagram || null, 
            p.email || null, 
            p.published !== false ? 1 : 0, 
            p.display_order || 0, 
            now, 
            req.params.id
        ],
        function(err) {
            if (err) {
                console.error('Partner update error:', err);
                return res.status(500).json({ error: 'Database error' });
            }
            
            if (this.changes === 0) {
                return res.status(404).json({ error: 'Partner not found' });
            }
            
            res.json({ message: 'Partner updated successfully' });
        }
    );
});

app.delete('/api/partners/:id', (req, res) => {
    db.run('DELETE FROM partners WHERE id = ?', [req.params.id], function(err) {
        if (err) {
            console.error('Partner delete error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        res.json({ 
            message: 'Partner deleted successfully',
            deleted: this.changes > 0
        });
    });
});

app.get('/api/calendar', (req, res) => {
    const month = String(parseInt(req.query.month) || new Date().getMonth() + 1).padStart(2, '0');
    const year = parseInt(req.query.year) || new Date().getFullYear();
    
    const cacheKey = `calendar_${month}_${year}`;
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }
    
    db.all(`
        SELECT name, slug, birth_date, death_date 
        FROM homes 
        WHERE published = 1 
        AND (strftime('%m', birth_date) = ? OR strftime('%m', death_date) = ?)
    `, [month, month], (err, rows) => {
        if (err) {
            console.error('Calendar error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const events = {};
        
        rows.forEach(row => {
            if (row.birth_date && row.birth_date.includes(`-${month}-`)) {
                const date = new Date(row.birth_date);
                const day = String(date.getDate()).padStart(2, '0');
                const key = `${month}-${day}`;
                
                if (!events[key]) events[key] = [];
                
                events[key].push({
                    name: row.name,
                    slug: row.slug,
                    type: 'birth',
                    full_date: row.birth_date,
                    years_ago: year - date.getFullYear()
                });
            }
            
            if (row.death_date && row.death_date.includes(`-${month}-`)) {
                const date = new Date(row.death_date);
                const day = String(date.getDate()).padStart(2, '0');
                const key = `${month}-${day}`;
                
                if (!events[key]) events[key] = [];
                
                events[key].push({
                    name: row.name,
                    slug: row.slug,
                    type: 'death',
                    full_date: row.death_date,
                    years_ago: year - date.getFullYear()
                });
            }
        });
        
        apiCache.set(cacheKey, events, 300);
        res.json(events);
    });
});

app.get('/api/calendar/today', (req, res) => {
    const today = new Date();
    const monthDay = String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const viewingYear = parseInt(req.query.year) || today.getFullYear();
    
    const cacheKey = 'calendar_today';
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }
    
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
        if (err) {
            console.error('Calendar today error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        const events = [];
        
        rows.forEach(row => {
            if (row.birth_date) {
                const birthMonthDay = row.birth_date.substring(5);
                if (birthMonthDay === monthDay) {
                    events.push({
                        name: row.name,
                        slug: row.slug,
                        type: 'birth',
                        full_date: row.birth_date,
                        years_ago: viewingYear - new Date(row.birth_date).getFullYear()
                    });
                }
            }
            
            if (row.death_date) {
                const deathMonthDay = row.death_date.substring(5);
                if (deathMonthDay === monthDay) {
                    events.push({
                        name: row.name,
                        slug: row.slug,
                        type: 'death',
                        full_date: row.death_date,
                        years_ago: viewingYear - new Date(row.death_date).getFullYear()
                    });
                }
            }
        });
        
        apiCache.set(cacheKey, events, 300);
        res.json(events);
        
        if (IS_LOW_SPEC && global.gc) {
            setImmediate(() => global.gc());
        }
    });
});

app.get('/api/calendar/all', (req, res) => {
    const cacheKey = 'calendar_all_dates';
    const cached = apiCache.get(cacheKey);
    if (cached) {
        return res.json(cached);
    }
    
    db.all(`
        SELECT name, slug, birth_date, death_date 
        FROM homes 
        WHERE published = 1 
        AND (birth_date IS NOT NULL OR death_date IS NOT NULL)
    `, [], (err, rows) => {
        if (err) {
            console.error('Calendar all error:', err);
            return res.status(500).json({ error: 'Database error' });
        }
        
        apiCache.set(cacheKey, rows, 1800);
        res.json(rows || []);
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:page.html', (req, res) => {
    const page = req.params.page;
    const filePath = path.join(__dirname, `${page}.html`);
    
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).sendFile(path.join(__dirname, '404.html'));
    }
});

app.get('/api/health', (req, res) => {
    const mem = process.memoryUsage();
    const uptime = process.uptime();
    
    res.json({
        status: 'healthy',
        dbReady: dbReady,
        uptime: Math.round(uptime),
        memory: {
            rss: Math.round(mem.rss / 1024 / 1024) + 'MB',
            heapUsed: Math.round(mem.heapUsed / 1024 / 1024) + 'MB',
            heapTotal: Math.round(mem.heapTotal / 1024 / 1024) + 'MB'
        },
        cache: apiCache.getStats(),
        mode: IS_LOW_SPEC ? 'low-spec' : 'high-performance',
        ramLimit: TOTAL_RAM_MB + 'MB'
    });
});

const server = app.listen(PORT, '0.0.0.0', () => {
    const mem = process.memoryUsage();
    console.log(`\n✅ Server is LIVE on port ${PORT}`);
    console.log(`🌐 Access at: http://localhost:${PORT}`);
    console.log(`💾 Initial Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS`);
    console.log(`📦 Cache Max Size: ${apiCache.maxSize} entries`);
    console.log(`\n🎯 Ready to serve HistoryAddress.bg!\n`);
});

server.keepAliveTimeout = 30000;
server.headersTimeout = 31000;

setInterval(() => {
    const mem = process.memoryUsage();
    const rss = Math.round(mem.rss / 1024 / 1024);
    const heapUsed = Math.round(mem.heapUsed / 1024 / 1024);
    
    const warningThreshold = IS_LOW_SPEC ? 150 : 500;
    const criticalThreshold = IS_LOW_SPEC ? 250 : 800;
    
    if (rss > warningThreshold && global.gc) {
        const before = mem.heapUsed;
        global.gc();
        const after = process.memoryUsage().heapUsed;
        const freed = Math.round((before - after) / 1024 / 1024);
        
        console.log(`♻️  GC Triggered | RSS: ${rss}MB | Heap: ${heapUsed}MB | Freed: ${freed}MB`);
        
        if (rss > criticalThreshold) {
            console.log(`⚠️  CRITICAL MEMORY: ${rss}MB - Emergency cache flush!`);
            apiCache.clear();
            if (global.gc) global.gc();
        }
    }
}, IS_LOW_SPEC ? 30000 : 60000);

process.on('SIGINT', () => {
    console.log('\n🛑 Received SIGINT - Shutting down gracefully...');
    
    server.close(() => {
        console.log('✅ HTTP server closed');
        
        db.close((err) => {
            if (err) {
                console.error('❌ Error closing database:', err);
                process.exit(1);
            }
            console.log('✅ Database closed');
            console.log('👋 Goodbye!');
            process.exit(0);
        });
    });
    
    setTimeout(() => {
        console.error('⚠️  Forced shutdown after timeout');
        process.exit(1);
    }, 10000);
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM - Shutting down...');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    console.error('❌ UNCAUGHT EXCEPTION:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ UNHANDLED REJECTION at:', promise, 'reason:', reason);
});
