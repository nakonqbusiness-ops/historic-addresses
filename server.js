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
app.use(express.json({ limit: '50mb' })); // Consider reducing this to 10mb if possible
app.use(express.static(path.join(__dirname)));

const DB_DIR = process.env.RENDER ? '/data' : '.';
const DB_FILE = path.join(DB_DIR, 'database.db');

if (process.env.RENDER && !fs.existsSync(DB_DIR)) {
    try {
        fs.mkdirSync(DB_DIR, { recursive: true });
        console.log(`✅ Created persistent data directory: ${DB_DIR}`);
    } catch (e) {
        console.error('CRITICAL ERROR: Failed to create persistent directory. Check Render Disk configuration!', e);
        process.exit(1);
    }
}
console.log("📦 Using persistent database at:", DB_FILE);


// Initialize SQLite database
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Optimize SQLite for memory
db.configure('busyTimeout', 5000);
db.run('PRAGMA journal_mode = WAL'); // Write-Ahead Logging for better performance
db.run('PRAGMA synchronous = NORMAL'); // Faster writes
db.run('PRAGMA cache_size = 1000'); // Limit cache size (about 4MB)
db.run('PRAGMA temp_store = MEMORY'); // Use memory for temp tables

// Create tables if they don't exist and run necessary migrations
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
            
            // Create indexes for faster queries
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_published ON homes(published)');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_slug ON homes(slug)');
            db.run('CREATE INDEX IF NOT EXISTS idx_homes_name ON homes(name)');
            
            checkAndMigrateSchema();
        }
    });
}

// Function to check and add missing columns (migration)
function checkAndMigrateSchema() {
    db.all("PRAGMA table_info(homes)", (err, columns) => {
        if (err) {
            console.error('Error checking columns for migration:', err);
            importInitialData();
            return;
        }

        const columnNames = columns.map(col => col.name);
        
        if (!columnNames.includes('portrait_url')) {
            console.log('Column portrait_url missing. Running migration...');
            
            db.run('ALTER TABLE homes ADD COLUMN portrait_url TEXT', (err) => {
                if (err) {
                    console.error('Migration failed (ALTER TABLE):', err);
                } else {
                    console.log('✅ Migration successful: Added portrait_url column.');
                }
                importInitialData();
            });
        } else {
            console.log('Database schema is up-to-date. Skipping migration.');
            importInitialData();
        }
    });
}

// Import initial data from people.js if database is empty
function importInitialData() {
    db.get('SELECT COUNT(*) as count FROM homes', (err, row) => {
        if (err) {
            console.error('Error checking data:', err);
            return;
        }
        
        if (row.count === 0) {
            console.log('Importing initial data from people.js...');
            try {
                const dataPath = path.join(__dirname, 'data', 'people.js');
                if (fs.existsSync(dataPath)) {
                    const fileContent = fs.readFileSync(dataPath, 'utf8');
                    const match = fileContent.match(/var\s+PEOPLE\s*=\s*(\[[\s\S]*?\]);/);
                    if (match) {
                        const people = JSON.parse(match[1]);
                        people.forEach(person => {
                            insertHome(person);
                        });
                        console.log(`✅ Imported ${people.length} homes from people.js`);
                    } else {
                        console.error('Could not parse PEOPLE array from people.js');
                    }
                } else {
                    console.error('people.js file not found at:', dataPath);
                }
            } catch (error) {
                console.error('Error importing initial data:', error);
            }
        } else {
            console.log(`Database already contains ${row.count} records. Skipping initial data import.`);
        }
    });
}

// Helper function to insert a home
function insertHome(home) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO homes
        (id, slug, name, biography, address, lat, lng, images, photo_date, sources, tags, published, created_at, updated_at, portrait_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const coordinates = home.coordinates || {};
    stmt.run(
        home.id || home.slug,
        home.slug,
        home.name,
        home.biography,
        home.address,
        coordinates.lat,
        coordinates.lng,
        JSON.stringify(home.images || []),
        home.photo_date,
        JSON.stringify(home.sources || []),
        JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0,
        home.created_at || new Date().toISOString(),
        home.updated_at || new Date().toISOString(),
        home.portrait_url || null
    );
    stmt.finalize();
}

// Helper function to convert DB row to home object
function rowToHome(row) {
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

// ============ SEO ROUTES ============

// Serve robots.txt dynamically
app.get('/robots.txt', (req, res) => {
    const robotsTxt = `User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /assets/

Sitemap: ${DOMAIN}/sitemap.xml`;
    
    res.type('text/plain');
    res.send(robotsTxt);
});

// Generate dynamic sitemap.xml
app.get('/sitemap.xml', (req, res) => {
    db.all('SELECT slug, updated_at FROM homes WHERE published = 1 ORDER BY updated_at DESC', [], (err, rows) => {
        if (err) {
            console.error('Error generating sitemap:', err);
            res.status(500).send('Error generating sitemap');
            return;
        }
        
        const staticPages = [
            { url: '', priority: '1.0', changefreq: 'weekly' },
            { url: 'addresses.html', priority: '0.9', changefreq: 'daily' },
            { url: 'map.html', priority: '0.8', changefreq: 'weekly' },
            { url: 'about.html', priority: '0.7', changefreq: 'monthly' }
        ];
        
        let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
        xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
        
        // Add static pages
        staticPages.forEach(page => {
            xml += '  <url>\n';
            xml += `    <loc>${DOMAIN}/${page.url}</loc>\n`;
            xml += `    <changefreq>${page.changefreq}</changefreq>\n`;
            xml += `    <priority>${page.priority}</priority>\n`;
            xml += '  </url>\n';
        });
        
        // Add all published addresses
        rows.forEach(home => {
            const lastmod = home.updated_at ? new Date(home.updated_at).toISOString().split('T')[0] : '';
            xml += '  <url>\n';
            xml += `    <loc>${DOMAIN}/address.html?slug=${encodeURIComponent(home.slug)}</loc>\n`;
            if (lastmod) {
                xml += `    <lastmod>${lastmod}</lastmod>\n`;
            }
            xml += '    <changefreq>monthly</changefreq>\n';
            xml += '    <priority>0.6</priority>\n';
            xml += '  </url>\n';
        });
        
        xml += '</urlset>';
        
        res.type('application/xml');
        res.send(xml);
    });
});

// ============ API ROUTES ============

// GET all homes with pagination
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const search = req.query.search || '';
    const tag = req.query.tag || '';
    
    const offset = (page - 1) * limit;
    
    // Build the WHERE clause based on filters
    let whereConditions = [];
    let params = [];
    
    if (!showAll) {
        whereConditions.push('published = 1');
    }
    
    // Search filter (name, biography, sources)
    if (search) {
        whereConditions.push(`(
            name LIKE ? OR 
            biography LIKE ? OR 
            sources LIKE ? OR
            tags LIKE ?
        )`);
        const searchPattern = `%${search}%`;
        params.push(searchPattern, searchPattern, searchPattern, searchPattern);
    }
    
    // Tag filter
    if (tag) {
        whereConditions.push('tags LIKE ?');
        params.push(`%"${tag}"%`);
    }
    
    const whereClause = whereConditions.length > 0 
        ? 'WHERE ' + whereConditions.join(' AND ')
        : '';
    
    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM homes ${whereClause}`;
    
    db.get(countQuery, params, (err, countRow) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        const total = countRow.total;
        const totalPages = Math.ceil(total / limit);
        
        // Get paginated results
        const dataQuery = `
            SELECT * FROM homes 
            ${whereClause}
            ORDER BY name
            LIMIT ? OFFSET ?
        `;
        
        db.all(dataQuery, [...params, limit, offset], (err, rows) => {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            
            const homes = rows.map(rowToHome);
            
            res.json({
                data: homes,
                pagination: {
                    page: page,
                    limit: limit,
                    total: total,
                    totalPages: totalPages,
                    hasNext: page < totalPages,
                    hasPrev: page > 1
                }
            });
        });
    });
});

// GET all tags (for the filter dropdown) - CACHED
let tagsCache = null;
let tagsCacheTime = 0;
const TAGS_CACHE_TTL = 300000; // 5 minutes

app.get('/api/tags', (req, res) => {
    const now = Date.now();
    
    // Return cached tags if still valid
    if (tagsCache && (now - tagsCacheTime) < TAGS_CACHE_TTL) {
        return res.json(tagsCache);
    }
    
    db.all('SELECT DISTINCT tags FROM homes WHERE published = 1', [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        const tagSet = new Set();
        rows.forEach(row => {
            try {
                const tags = JSON.parse(row.tags || '[]');
                tags.forEach(tag => {
                    if (tag) tagSet.add(String(tag));
                });
            } catch (e) {
                console.error('Error parsing tags:', e);
            }
        });
        
        const tagArray = Array.from(tagSet).sort((a, b) => a.localeCompare(b));
        
        // Cache the result
        tagsCache = tagArray;
        tagsCacheTime = now;
        
        res.json(tagArray);
    });
});

// GET homes for map (lightweight - only coordinates and basic info) - CACHED
let mapCache = null;
let mapCacheTime = 0;
const MAP_CACHE_TTL = 600000; // 10 minutes

app.get('/api/homes/map', (req, res) => {
    const now = Date.now();
    
    // Return cached map data if still valid
    if (mapCache && (now - mapCacheTime) < MAP_CACHE_TTL) {
        console.log('✅ Serving map data from cache');
        return res.json(mapCache);
    }
    
    // Only select the fields needed for map markers
    const query = `
        SELECT id, slug, name, lat, lng, images
        FROM homes 
        WHERE published = 1 
        AND lat IS NOT NULL 
        AND lng IS NOT NULL
        ORDER BY name
    `;
    
    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        
        // Return minimal data - just what's needed for map markers
        const mapData = rows.map(row => {
            let thumbnail = null;
            
            // Extract only the first image thumbnail (not all images)
            try {
                const images = JSON.parse(row.images || '[]');
                if (images && images[0]) {
                    thumbnail = images[0].thumb || images[0].path || null;
                }
            } catch (e) {
                // Ignore parse errors
            }
            
            return {
                id: row.id,
                slug: row.slug,
                name: row.name,
                lat: row.lat,
                lng: row.lng,
                thumbnail: thumbnail
            };
        });
        
        // Cache the result
        mapCache = mapData;
        mapCacheTime = now;
        
        console.log(`📍 Generated map data: ${mapData.length} locations (cached for 10 min)`);
        res.json(mapData);
    });
});

// Invalidate caches when data changes
function invalidateCaches() {
    tagsCache = null;
    mapCache = null;
    console.log('♻️ Caches invalidated');
}

// GET single home by slug
app.get('/api/homes/:slug', (req, res) => {
    db.get('SELECT * FROM homes WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug], (err, row) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (!row) {
            res.status(404).json({ error: 'Home not found' });
            return;
        }
        res.json(rowToHome(row));
    });
});

// POST create new home
app.post('/api/homes', (req, res) => {
    const home = req.body;
    
    if (!home.name) {
        res.status(400).json({ error: 'Name is required' });
        return;
    }
    
    if (!home.slug) {
        home.slug = home.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    
    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = new Date().toISOString();
    
    insertHome(home);
    invalidateCaches(); // Clear cache when data changes
    
    res.status(201).json({ message: 'Home created successfully', id: home.id });
});

// PUT update existing home
app.put('/api/homes/:id', (req, res) => {
    const home = req.body;
    home.updated_at = new Date().toISOString();
    
    const coordinates = home.coordinates || {};
    const stmt = db.prepare(`
        UPDATE homes SET
            slug = ?, name = ?, biography = ?, address = ?,
            lat = ?, lng = ?, images = ?, photo_date = ?,
            sources = ?, tags = ?, published = ?, updated_at = ?,
            portrait_url = ?
        WHERE id = ?
    `);
    
    stmt.run(
        home.slug, home.name, home.biography, home.address,
        coordinates.lat, coordinates.lng,
        JSON.stringify(home.images || []), home.photo_date,
        JSON.stringify(home.sources || []),
        JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0,
        home.updated_at,
        home.portrait_url || null,
        req.params.id,
        function(err) {
            if (err) {
                res.status(500).json({ error: err.message });
                return;
            }
            if (this.changes === 0) {
                res.status(404).json({ error: 'Home not found' });
                return;
            }
            invalidateCaches(); // Clear cache when data changes
            res.json({ message: 'Home updated successfully' });
        }
    );
    stmt.finalize();
});

// DELETE home
app.delete('/api/homes/:id', (req, res) => {
    db.run('DELETE FROM homes WHERE id = ?', [req.params.id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        if (this.changes === 0) {
            res.status(404).json({ error: 'Home not found' });
            return;
        }
        invalidateCaches(); // Clear cache when data changes
        res.json({ message: 'Home deleted successfully' });
    });
});

// ============ SERVE HTML PAGES ============

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:page.html', (req, res) => {
    const page = req.params.page;
    const filePath = path.join(__dirname, `${page}.html`);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).send('Page not found');
    }
});

// Start server on all network interfaces
app.listen(PORT, '0.0.0.0', () => {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    const addresses = [];
    
    Object.keys(interfaces).forEach(name => {
        interfaces[name].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        });
    });
    
    console.log(`\n🏛️ Historic Addresses Server`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Database: SQLite (Persistent at ${DB_FILE})`);
    console.log(`🌍 Domain: ${DOMAIN}`);
    console.log(`🔍 SEO: robots.txt and sitemap.xml enabled`);
    console.log(`⚡ Optimizations: Database indexes, Query caching`);
    
    console.log(`\n📍 Access from this computer:`);
    console.log(`  http://localhost:${PORT}`);
    
    if (addresses.length > 0) {
        console.log(`\n🌐 Access from other devices on your network:`);
        addresses.forEach(addr => {
            console.log(`  http://${addr}:${PORT}`);
        });
    }
    console.log(`\n🔌 API Endpoints:`);
    console.log(`  /api/homes - Paginated homes`);
    console.log(`  /api/homes/map - Lightweight map data (cached 10 min)`);
    console.log(`  /api/tags - Tags list (cached 5 min)`);
    console.log(`🔍 SEO: /robots.txt | /sitemap.xml\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) console.error(err.message);
        console.log('\n✅ Database connection closed.');
        process.exit(0);
    });
});
