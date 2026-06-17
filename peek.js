const Database = require('better-sqlite3');
const db = new Database('database_clean.db'); // Pointing to the big backup

console.log("--- Peeking at the data ---");

// Get 5 rows from the homes table
const rows = db.prepare('SELECT id, images FROM homes LIMIT 5').all();

rows.forEach(row => {
    console.log(`\nHome ID: ${row.id}`);
    console.log(`Type: ${typeof row.images}`);
    console.log(`Content Sample: ${String(row.images).substring(0, 100)}...`);
});