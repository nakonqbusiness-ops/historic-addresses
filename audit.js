const Database = require('better-sqlite3');
const db = new Database('database.db');

// Get all tables
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();

console.log("--- Searching database for lingering Base64 data ---");

tables.forEach(table => {
    // Get column names for this table
    const columns = db.prepare(`PRAGMA table_info("${table.name}")`).all();
    
    // Check all rows in this table
    const rows = db.prepare(`SELECT * FROM "${table.name}"`).all();
    
    rows.forEach(row => {
        columns.forEach(col => {
            const val = row[col.name];
            // Check if this column contains Base64
            if (typeof val === 'string' && val.includes('data:image')) {
                console.log(`[!] FOUND: Table: ${table.name} | Column: ${col.name}`);
            }
        });
    });
});

console.log("--- Search complete ---");