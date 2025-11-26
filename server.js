const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Resolve database path from environment or fallback to local file
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'database.db');

// Ensure persistent storage directory exists (VERY IMPORTANT FOR RENDER)
const dataDir = path.dirname(DB_PATH);

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log("📁 Created persistent storage directory:", dataDir);
} else {
    console.log("📁 Persistent storage directory exists:", dataDir);
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname)));

// Initialize SQLite database
let db;
try {
    db = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error('❌ Error opening database:', err);
        } else {
            console.log('✅ Connected to SQLite database at:', DB_PATH);
            initializeDatabase();
        }
    });
} catch (e) {
    console.error("❌ Fatal SQLite error:", e);
}

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
            portrait_url TEXT
        )
    `, (err) => {
        if (err) {
            console.error('❌ Error creating table:', err);
        } else {
            console.log('📦 Database table ready');
            importInitialData();
        }
    });
}

// Import initial data only once
function importInitialData() {
    db.get('SELECT COUNT(*) as count FROM homes', (err, row) => {
        if (err) return console.error('Error checking data:', err);

        if (row.count === 0) {
            const dataPath = path.join(__dirname, 'data', 'people.js');

            if (fs.existsSync(dataPath)) {
                try {
                    console.log('📥 Importing initial data from people.js...');
                    const fileContent = fs.readFileSync(dataPath, 'utf8');
                    const match = fileContent.match(/var\\s+PEOPLE\\s*=\\s*(\\[[\\s\\S]*?\\]);/);

                    if (match) {
                        const people = JSON.parse(match[1]);
                        people.forEach(person => insertHome(person));
                        console.log(`✅ Imported ${people.length} homes.`);
                    }
                } catch (e) {
                    console.error('❌ Error during import:', e);
                }
            }
        }
    });
}

// Insert home
function insertHome(home) {
    const stmt = db.prepare(`
        INSERT OR REPLACE INTO homes 
        (id, slug, name, biography, address, lat, lng, images, photo_date, sources, tags, published, created_at, updated_at, portrait_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const coords = home.coordinates || {};

    stmt.run(
        home.id || home.slug,
        home.slug,
        home.name,
        home.biography,
        home.address,
        coords.lat,
        coords.lng,
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

// Convert DB row to JS object
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

// API ROUTES
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const query = showAll ? 'SELECT * FROM homes ORDER BY name' : 'SELECT * FROM homes WHERE published = 1 ORDER BY name';

    db.all(query, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows.map(rowToHome));
    });
});

app.get('/api/homes/:slug', (req, res) => {
    db.get('SELECT * FROM homes WHERE slug = ? OR id = ?', [req.params.slug, req.params.slug], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'Home not found' });
        res.json(rowToHome(row));
    });
});

app.post('/api/homes', (req, res) => {
    const home = req.body;

    if (!home.name) return res.status(400).json({ error: 'Name is required' });

    if (!home.slug) {
        home.slug = home.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    home.id = home.id || home.slug;
    home.created_at = new Date().toISOString();
    home.updated_at = new Date().toISOString();

    insertHome(home);

    res.status(201).json({ message: 'Home created', id: home.id });
});

app.put('/api/homes/:id', (req, res) => {
    const home = req.body;
    home.updated_at = new Date().toISOString();

    const coords = home.coordinates || {};

    const stmt = db.prepare(`
        UPDATE homes SET
            slug=?, name=?, biography=?, address=?, lat=?, lng=?, images=?, photo_date=?, sources=?, tags=?, published=?, updated_at=?, portrait_url=?
        WHERE id=?
    `);

    stmt.run(
        home.slug, home.name, home.biography, home.address,
        coords.lat, coords.lng,
        JSON.stringify(home.images || []),
        home.photo_date,
        JSON.stringify(home.sources || []),
        JSON.stringify(home.tags || []),
        home.published !== false ? 1 : 0,
        home.updated_at,
        home.portrait_url || null,
        req.params.id,
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            if (this.changes === 0) return res.status(404).json({ error: 'Home not found' });
            res.json({ message: 'Home updated' });
        }
    );

    stmt.finalize();
});

app.delete('/api/homes/:id', (req, res) => {
    db.run('DELETE FROM homes WHERE id = ?', [req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        if (this.changes === 0) return res.status(404).json({ error: 'Home not found' });
        res.json({ message: 'Home deleted' });
    });
});

// Serve HTML files
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:page.html', (req, res) => {
    const file = path.join(__dirname, `${req.params.page}.html`);
    if (fs.existsSync(file)) res.sendFile(file);
    else res.status(404).send('Page not found');
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🏛️ Historic Addresses Server`);
    console.log(`✅ Running on port ${PORT}`);
    console.log(`📦 Database path: ${DB_PATH}`);
});
