const fs = require('fs');
const https = require('https');
const path = require('path');

const dest = '/data/database.db';
const url = process.env.DB_DOWNLOAD_URL;

if (fs.existsSync(dest)) {
    console.log('Database already exists in /data, skipping download.');
    process.exit(0);
}

if (!url) {
    console.error('DB_DOWNLOAD_URL variable is missing!');
    process.exit(1);
}

console.log('Downloading database from GitHub Releases...');
const file = fs.createWriteStream(dest);

https.get(url, (response) => {
    if (response.statusCode === 302 || response.statusCode === 301) {
        // Handle GitHub redirects
        https.get(response.headers.location, (redirectResponse) => {
            redirectResponse.pipe(file);
        });
    } else {
        response.pipe(file);
    }

    file.on('finish', () => {
        file.close();
        console.log('Download complete!');
        process.exit(0);
    });
}).on('error', (err) => {
    fs.unlink(dest, () => {}); 
    console.error('Download failed:', err.message);
    process.exit(1);
});
