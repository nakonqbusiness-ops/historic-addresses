const Database = require('better-sqlite3');
const fs = require('fs');

// Open existing
const oldDb = new Database('database.db');
// Create new
const newDb = new Database('database_clean.db');

const tables = oldDb.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();

for (const table of tables) {
    if (table.name === 'sqlite_sequence') continue;
    
    // Create table in new DB
    newDb.exec(table.sql);
    
    // Copy all data
    const rows = oldDb.prepare(`SELECT * FROM "${table.name}"`).all();
    if (rows.length > 0) {
        const columns = Object.keys(rows[0]);
        const placeholders = columns.map(() => '?').join(', ');
        const insert = newDb.prepare(`INSERT INTO "${table.name}" (${columns.join(', ')}) VALUES (${placeholders})`);
        
        for (const row of rows) {
            insert.run(...Object.values(row));
        }
    }
}
console.log("Rebuild finished. Check the size of 'database_clean.db'.");