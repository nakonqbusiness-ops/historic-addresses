const Database = require('better-sqlite3');
const db = new Database('database.db');

// Changed "%data:image%" to '%data:image%'
const row = db.prepare("SELECT images FROM homes WHERE images LIKE '%data:image%' LIMIT 1").get();

if (row) {
    console.log("CRITICAL: Found Base64 data in the database!");
    console.log("The data exists and needs to be migrated.");
} else {
    console.log("Good news: No Base64 data found. The bloat might be something else.");
}