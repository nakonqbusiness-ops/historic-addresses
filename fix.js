const Database = require('better-sqlite3');
const db = new Database('database.db');

const rows = db.prepare('SELECT id, images FROM homes').all();
const stmt = db.prepare('UPDATE homes SET images = ? WHERE id = ?');

rows.forEach(row => {
    if (!row.images || row.images === '[]') return;
    
    try {
        const images = JSON.parse(row.images);
        // Change 'url' back to 'path'
        const fixedImages = images.map(img => ({ path: img.url }));
        
        stmt.run(JSON.stringify(fixedImages), row.id);
    } catch (e) {
        console.error(`Error processing ID ${row.id}`);
    }
});

console.log("Database updated! All keys renamed to 'path'. Refresh your site.");