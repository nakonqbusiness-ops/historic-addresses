const Database = require('better-sqlite3');

const db = new Database('database.db');

console.log("Starting database vacuum...");
db.exec('VACUUM');
console.log("Vacuum complete! Your database file size has been optimized.");