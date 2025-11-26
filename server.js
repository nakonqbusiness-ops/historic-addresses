const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// Initialize SQLite database with Render persistent storage support
const DB_PATH = process.env.RENDER 
    ? '/opt/render/project/data/database.db' 
    : path.join(__dirname, 'database.db');

console.log("📦 Using database at:", DB_PATH);

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
});

// Create tables if they don't exist
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
            portrait_url TEXT  -- NEW FIELD FOR CELEBRITY PORTRAIT
        )
    `, (err) => {
        if (err) {
            console.error('Error creating table:', err);
        } else {
            console.log('Database table ready');
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
                    }
                }
            } catch (error) {
                console.error('Error importing initial data:', error);
            }
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
        home.portrait_url || null // <- NEW VALUE
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
        portrait_url: row.portrait_url // <- NEW FIELD
    };
}

// ============ API ROUTES ============

// GET all homes
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const query = showAll 
        ? 'SELECT * FROM homes ORDER BY name'
        : 'SELECT * FROM homes WHERE published = 1 ORDER BY name';
    
    db.all(query, [], (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
            return;
        }
        const homes = rows.map(rowToHome);
        res.json(homes);
    });
});

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
    
    // Generate slug if not provided
    if (!home.slug) {
        home.slug = home.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
    
    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = new Date().toISOString();
    
    insertHome(home);
    
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
            portrait_url = ? -- NEW FIELD
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
        home.portrait_url || null, // <- NEW VALUE
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
    
    // Get all IPv4 addresses
    Object.keys(interfaces).forEach(name => {
        interfaces[name].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                addresses.push(iface.address);
            }
        });
    });
    
    console.log(`\n🏛️  Historic Addresses Server`);
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Database: SQLite (database.db)`);
    
    // IMPORTANT NOTE: If you see the SQLITE_ERROR, please delete database.db to create the new table structure!
    console.log(`\n*** DATABASE UPDATE: If you delete database.db, the server will create a new table with 'portrait_url' field. ***`);
    
    console.log(`\n📍 Access from this computer:`);
    console.log(`  http://localhost:${PORT}`);
    
    if (addresses.length > 0) {
        console.log(`\n🌐 Access from other devices on your network:`);
        addresses.forEach(addr => {
            console.log(`  http://${addr}:${PORT}`);
        });
    }
    console.log(`\n🔌 API Endpoint: /api/homes\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) console.error(err.message);
        console.log('\n✅ Database connection closed.');
        process.exit(0);
    });
});
