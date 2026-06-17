00;
}

(async () => {
    const tables = ['homes', 'partners', 'news', 'team'];
    
    for (const tableName of tables) {
        console.log(`Processing table: ${tableName}...`);
        const rows = db.prepare(`SELECT * FROM ${tableName}`).all();
        const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();

        for (const row of rows) {
            let updatedRow = { ...row };
            let rowChanged = false;

            for (const col of columns) {
                let val = row[col.name];
                if (typeof val !== 'string' || !val.includes('data:image')) continue;

                try {
                    // Scenario A: It's a JSON array (like 'images')
                    if (val.startsWith('[')) {
                        let json = JSON.parse(val);
                        for (let img of json) {
                            if (img.data && img.data.startsWith('data:image')) {
                                img.url = await uploadToR2(img.data);
                                delete img.data;
                                rowChanged = true;
                            }
                        }
                        updatedRow[col.name] = JSON.stringify(json);
                    } 
                    // Scenario B: It's a plain string (like 'portrait_url')
                    else {
                        updatedRow[col.name] = await uploadToR2(val);
                        rowChanged = true;
                    }
                } catch (e) {
                    console.error(`Error processing ${tableName} ID ${row.id}:`, e);
                }
            }

            if (rowChanged) {
                const keys = Object.keys(updatedRow).filter(k => k !== 'id');
                const setClause = keys.map(k => `${k} = ?`).join(', ');
                const params = keys.map(k => updatedRow[k]);
                db.prepare(`UPDATE ${tableName} SET ${setClause} WHERE id = ?`).run(...params, row.id);
            }
        }
    }
    console.log("Purge complete! All Base64 data replaced with R2 links.");
})();