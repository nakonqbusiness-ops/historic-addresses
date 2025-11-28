const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
// const multer = require('multer'); // ❌ ПРЕМАХНАТО: Вече не използваме multer за качване на файлове

const app = express();
const PORT = process.env.PORT || 3000;

// 🚨 АВТЕНТИКАЦИЯ: СЕКРЕТНАТА ПАРОЛА Е ТУК!
const SERVER_SECRET_PASSWORD = '_endjvJ6!d'; // ⚠️ ЗАМЕНИ СИГУРНО, АКО Е НУЖНО
const AUTH_HEADER_KEY = 'x-admin-token';

// --- MULTER SETUP (БЕЗ ДЕЙСТВИЕ: КОМЕНТИРАН/ПРЕМАХНАТ) ---
// Тъй като вече работим с Base64 Data URLs, тази логика е ненужна.
// Ако искате да запазите възможността за качване на файлове в бъдеще,
// запазете я, но променете ендпойнтите POST/PUT.

// const UPLOADS_DIR = path.join(__dirname, 'assets');
// if (!fs.existsSync(UPLOADS_DIR)) {
//     fs.mkdirSync(UPLOADS_DIR, { recursive: true });
// }

// const storage = multer.diskStorage({
//     destination: (req, file, cb) => { cb(null, UPLOADS_DIR); },
//     filename: (req, file, cb) => {
//         const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
//         cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
//     }
// });

// const upload = multer({
//     storage: storage,
//     limits: { fileSize: 10 * 1024 * 1024 }
// });
// --------------------------------------------------

// Middleware
app.use(cors());
// ✅ ВАЖНА ПРОМЯНА: Увеличихме лимита до 50MB, за да поберем Base64 изображенията!
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
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

// --- АВТЕНТИКАЦИОНЕН MIDDLEWARE ---

// Междинно приложение за проверка на автентикацията
function checkAuth(req, res, next) {
    const providedToken = req.headers[AUTH_HEADER_KEY];

    // Проверка дали предоставеният токен съвпада с нашата секретна парола
    if (providedToken === SERVER_SECRET_PASSWORD) {
        next(); // Успешна автентикация
    } else {
        res.status(401).json({ error: 'Authentication required. Please log in.' });
    }
}
// -------------------------------------


// Initialize SQLite database
const db = new sqlite3.Database(DB_FILE, (err) => {
    if (err) {
        console.error('Error opening database:', err);
    } else {
        console.log('Connected to SQLite database');
        initializeDatabase();
    }
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
        if (err) {
            console.error('Error creating table:', err);
        } else {
            console.log('Database table ready');
            checkAndMigrateSchema();
        }
    });
}

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

// ============ API ROUTES ============

// НОВ ЕНДПОЙНТ: Вход в административния панел (непроменен)
app.post('/api/login', (req, res) => {
    const { password } = req.body;
    if (password === SERVER_SECRET_PASSWORD) {
        // Връщаме секретната парола като "токен"
        res.json({ message: 'Login successful', token: SERVER_SECRET_PASSWORD });
    } else {
        res.status(401).json({ error: 'Incorrect password' });
    }
});

// ❌ ПРЕМАХНАТ/КОМЕНТИРАН ЕНДПОЙНТ: Качване на снимка
// app.post('/api/upload-image', upload.single('file'), checkAuth, (req, res) => {
//     if (!req.file) {
//         return res.status(400).json({ error: 'No file uploaded' });
//     }
//     const publicUrl = `/assets/${req.file.filename}`;
//     res.json({
//         message: 'File uploaded successfully',
//         url: publicUrl
//     });
// });


// GET all homes (С ПАГИНАЦИЯ) (непроменен)
app.get('/api/homes', (req, res) => {
    const showAll = req.query.all === 'true';

    // Ако заявката е за всички записи (т.е. за административния панел), проверяваме за токен
    if (showAll && req.headers[AUTH_HEADER_KEY] !== SERVER_SECRET_PASSWORD) {
        return res.status(401).json({ error: 'Admin access required for "all" data.' });
    }
    
    // Добавяме параметри за пагинация
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;
    
    const whereClause = showAll ? '' : 'WHERE published = 1';
    
    // Заявка за броя на всички записи
    const countQuery = `SELECT COUNT(*) AS count FROM homes ${whereClause}`;

    db.get(countQuery, [], (err, countRow) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        const totalCount = countRow.count;

        // Основна заявка с LIMIT и OFFSET
        const dataQuery = `
            SELECT * FROM homes ${whereClause}
            ORDER BY name
            LIMIT ? OFFSET ?
        `;
        
        db.all(dataQuery, [limit, offset], (err, rows) => {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            const homes = rows.map(rowToHome);
            
            res.json({
                homes,
                meta: {
                    total: totalCount,
                    page: page,
                    limit: limit,
                    totalPages: Math.ceil(totalCount / limit)
                }
            });
        });
    });
});

// GET single home by slug (ПУБЛИЧЕН) (непроменен)
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

// POST create new home (ЗАЩИТЕН с checkAuth) (непроменен - приема JSON с Base64)
app.post('/api/homes', checkAuth, (req, res) => {
    const home = req.body;
    
    if (!home.
