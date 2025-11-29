const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp'); // You'll need to install this: npm install sharp

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
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
           portrait_url TEXT,
           portrait_thumbnail TEXT
        )
    `, (err) => {
        if (err) {
            console.error('Error creating table:', err);
        } else {
            console.log('Database table ready');
            checkAndMigrateSchema();
        }
    });
}

// Function to generate thumbnail from base64 image
async function generateThumbnail(base64Image, maxWidth = 300) {
    try {
        // Check if it's a base64 data URL
        if (!base64Image || !base64Image.startsWith('data:image')) {
            return null;
        }
        
        // Extract the base64 data
        const base64Data = base64Image.split(',')[1];
        const buffer = Buffer.from(base64Data, 'base64');
        
        // Generate thumbnail using sharp
        const thumbnailBuffer = await sharp(buffer)
            .resize(maxWidth, null, {
                fit: 'inside',
                withoutEnlargement: true
            })
            .jpeg({ quality: 80 })
            .toBuffer();
        
        // Convert back to base64 data URL
        const thumbnailBase64 = `data:image/jpeg;base64,${thumbnailBuffer.toString('base64')}`;
        return thumbnailBase64;
    } catch (error) {
        console.error('Error generating thumbnail:', error);
        return null;
    }
}

// Function to process images and add thumbnails
async function processImagesWithThumbnails(images) {
    if (!Array.isArray(images)) return [];
    
    const processedImages = await Promise.all(images.map(async (img) => {
        if (!img || !img.path) return img;
        
        // Only generate thumbnail for base64 images
        if (img.path.startsWith('data:image')) {
            const thumbnail = await generateThumbnail(img.path);
            return {
                ...img,
                thumbnail: thumbnail || img.path
            };
        }
        
        // For URL paths, just use the same path as thumbnail
        return {
            ...img,
            thumbnail: img.path
        };
    }));
    
    return processedImages;
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
        const migrationsNeeded = [];
        
        if (!columnNames.includes('portrait_url')) {
            migrationsNeeded.push('ALTER TABLE homes ADD COLUMN portrait_url TEXT');
        }
        
        if (!columnNames.includes('portrait_thumbnail')) {
            migrationsNeeded.push('ALTER TABLE homes ADD COLUMN portrait_thumbnail TEXT');
        }
        
        if (migrationsNeeded.length > 0) {
            console.log(`Running ${migrationsNeeded.length} migration(s)...`);
            
            let completedMigrations = 0;
            migrationsNeeded.forEach((migration, index) => {
                db.run(migration, (err) => {
                    if (err) {
                        console.error(`Migration ${index + 1} failed:`, err);
                    } else {
                        console.log(`✅ Migration ${index + 1} successful.`);
                    }
                    
                    completedMigrations++;
                    if (completedMigrations === migrationsNeeded.length) {
                        importInitialData();
                    }
                });
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
async function insertHome(home) {
    try {
        // Process images to add thumbnails
        const processedImages = await processImagesWithThumbnails(home.images || []);
        
        // Generate portrait thumbnail if portrait_url exists
        let portraitThumbnail = null;
        if (home.portrait_url && home.portrait_url.startsWith('data:image')) {
            portraitThumbnail = await generateThumbnail(home.portrait_url, 150);
        }
        
        const stmt = db.prepare(`
            INSERT OR REPLACE INTO homes
            (id, slug, name, biography, address, lat, lng, images, photo_date, sources, tags, published, created_at, updated_at, portrait_url, portrait_thumbnail)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            JSON.stringify(processedImages),
            home.photo_date,
            JSON.stringify(home.sources || []),
            JSON.stringify(home.tags || []),
            home.published !== false ? 1 : 0,
            home.created_at || new Date().toISOString(),
            home.updated_at || new Date().toISOString(),
            home.portrait_url || null,
            portraitThumbnail || home.portrait_url || null
        );
        stmt.finalize();
    } catch (error) {
        console.error('Error inserting home:', error);
    }
}

// Helper function to convert DB row to home object
function rowToHome(row, includeThumbnailsOnly = false) {
    const images = JSON.parse(row.images || '[]');
    
    // If thumbnailsOnly, replace full images with thumbnails for list views
    const outputImages = includeThumbnailsOnly 
        ? images.map(img => ({
            ...img,
            path: img.thumbnail || img.path
        }))
        : images;
    
    return {
        id: row.id,
        slug: row.slug,
        name: row.name,
        biography: row.biography,
        address: row.address,
        coordinates: row.lat && row.lng ? { lat: row.lat, lng: row.lng } : null,
        images: outputImages,
        photo_date: row.photo_date,
        sources: JSON.parse(row.sources || '[]'),
        tags: JSON.parse(row.tags || '[]'),
        published: row.published === 1,
        created_at: row.created_at,
        updated_at: row.updated_at,
        portrait_url: includeThumbnailsOnly ? (row.portrait_thumbnail || row.portrait_url) : row.portrait_url
    };
}

// ============ API ROUTES ============

// GET all homes with pagination
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 6;
    const search = req.query.search || '';
    const tag = req.query.tag || '';
    const thumbnailsOnly = req.query.thumbnails === 'true'; // New parameter
    
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
            
            const homes = rows.map(row => rowToHome(row, thumbnailsOnly));
            
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

// GET all tags (for the filter dropdown)
app.get('/api/tags', (req, res) => {
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
        res.json(tagArray);
    });
});

// GET single home by slug (always return full images)
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
        res.json(rowToHome(row, false)); // false = return full images
    });
});

// POST create new home
app.post('/api/homes', async (req, res) => {
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
    
    await insertHome(home);
    
    res.status(201).json({ message: 'Home created successfully', id: home.id });
});

// PUT update existing home
app.put('/api/homes/:id', async (req, res) => {
    try {
        const home = req.body;
        home.updated_at = new Date().toISOString();
        
        // Process images to add thumbnails
        const processedImages = await processImagesWithThumbnails(home.images || []);
        
        // Generate portrait thumbnail if portrait_url exists
        let portraitThumbnail = null;
        if (home.portrait_url && home.portrait_url.startsWith('data:image')) {
            portraitThumbnail = await generateThumbnail(home.portrait_url, 150);
        }
        
        const coordinates = home.coordinates || {};
        const stmt = db.prepare(`
            UPDATE homes SET
                slug = ?, name = ?, biography = ?, address = ?,
                lat = ?, lng = ?, images = ?, photo_date = ?,
                sources = ?, tags = ?, published = ?, updated_at = ?,
                portrait_url = ?, portrait_thumbnail = ?
            WHERE id = ?
        `);
        
        stmt.run(
            home.slug, home.name, home.biography, home.address,
            coordinates.lat, coordinates.lng,
            JSON.stringify(processedImages), home.photo_date,
            JSON.stringify(home.sources || []),
            JSON.stringify(home.tags || []),
            home.published !== false ? 1 : 0,
            home.updated_at,
            home.portrait_url || null,
            portraitThumbnail || home.portrait_url || null,
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
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
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
