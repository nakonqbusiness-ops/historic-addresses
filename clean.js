const Database = require('better-sqlite3');
const db = new Database('database.db');

const OLD_DOMAIN = 'https://historyaddress.bg';
const NEW_DOMAIN = 'https://pub-b40e453eddaf4bc5b299af8f6d7b7de2.r2.dev';

console.log("Updating database records...");

// This SQL uses the correct column name: portrait_url
const updateQuery = db.prepare(`
    UPDATE homes 
    SET 
        images = REPLACE(images, ?, ?),
        portrait_url = REPLACE(portrait_url, ?, ?)
    WHERE 
        images LIKE ? OR portrait_url LIKE ?
`);

try {
    const info = updateQuery.run(
        OLD_DOMAIN, NEW_DOMAIN,       // For images
        OLD_DOMAIN, NEW_DOMAIN,       // For portrait_url
        `%${OLD_DOMAIN}%`, `%${OLD_DOMAIN}%` // Filtering where updates are needed
    );

    console.log(`Success! Updated ${info.changes} rows.`);
} catch (err) {
    console.error("An error occurred during the update:", err.message);
} finally {
    db.close();
}