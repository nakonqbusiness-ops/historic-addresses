const Database = require('better-sqlite3');
const db = new Database('database.db');

// The OLD URL that is currently in your database (the S3 API one)
const OLD_URL = "https://ae436e2433a501e9b779b8993e95d5b1.r2.cloudflarestorage.com";
// The NEW URL you should use (your custom domain)
const NEW_URL = "https://historyaddress.bg"; 

const tables = ['homes', 'partners', 'news', 'team'];

console.log("Updating database URLs...");

tables.forEach(table => {
    const rows = db.prepare(`SELECT * FROM ${table}`).all();
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();

    rows.forEach(row => {
        let updated = false;
        let newRow = { ...row };

        columns.forEach(col => {
            let val = row[col.name];
            if (typeof val === 'string' && val.includes(OLD_URL)) {
                newRow[col.name] = val.replace(new RegExp(OLD_URL, 'g'), NEW_URL);
                updated = true;
            }
        });

        if (updated) {
            const keys = Object.keys(newRow).filter(k => k !== 'id');
            const setClause = keys.map(k => `${k} = ?`).join(', ');
            const params = keys.map(k => newRow[k]);
            db.prepare(`UPDATE ${table} SET ${setClause} WHERE id = ?`).run(...params, row.id);
            console.log(`Updated row in ${table} (ID: ${row.id})`);
        }
    });
});

console.log("URL update complete!");