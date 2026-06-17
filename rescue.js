const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const Database = require('better-sqlite3');
const fs = require('fs');

// 1. Setup Clients
const s3Client = new S3Client({
    region: 'auto',
    endpoint: 'https://ae436e2433a501e9b779b8993e95d5b1.r2.cloudflarestorage.com',
    credentials: {
        accessKeyId: '76877d8347a87fdad193e31158f75786', // Fill these in
        secretAccessKey: '2ebe2089e464e795d92eed487c84dc4a6537ef560884b35df37c6d0014a3dee3'
    },
});

const BUCKET_NAME = 'history-address-images';
const PUBLIC_URL = 'https://historyaddress.bg';

// 2. Open databases
const sourceDb = new Database('database_clean.db'); // The Big One
const destDb = new Database('database.db');        // The Clean One

async function uploadToR2(base64Data, id) {
    try {
        // Fix the base64 string if it contains metadata headers
        const base64Content = base64Data.includes(',') ? base64Data.split(',')[1] : base64Data;
        const buffer = Buffer.from(base64Content, 'base64');
        
        const fileName = `img_${id}_${Date.now()}_${Math.random().toString(36).substring(7)}.jpg`;
        
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: fileName,
            Body: buffer,
            ContentType: 'image/jpeg'
        }));
        return `${PUBLIC_URL}/${fileName}`;
    } catch (e) {
        console.error(`Upload failed for home ${id}:`, e.message);
        return null;
    }
}

(async () => {
    console.log("Starting Rescue Mission...");
    
    // Get all homes
    const homes = sourceDb.prepare('SELECT id, images FROM homes').all();
    console.log(`Found ${homes.length} homes to process.`);

    for (const home of homes) {
        if (!home.images || home.images === '[]') continue;

        try {
            const images = JSON.parse(home.images);
            const newImages = [];
            let updated = false;

            for (const imgObj of images) {
                // FIXED: Looking for 'path' instead of 'data'
                if (imgObj.path && imgObj.path.startsWith('data:image')) {
                    console.log(`Uploading image for Home ID: ${home.id}...`);
                    const url = await uploadToR2(imgObj.path, home.id);
                    if (url) {
                        newImages.push({ url: url });
                        updated = true;
                    }
                } else if (imgObj.url) {
                    newImages.push(imgObj);
                }
            }

            // Update the clean database
            if (updated) {
                destDb.prepare('UPDATE homes SET images = ? WHERE id = ?')
                      .run(JSON.stringify(newImages), home.id);
                console.log(`SUCCESS: Updated Home ID: ${home.id}`);
            }

        } catch (e) {
            console.error(`Skipping Home ID ${home.id} due to parse error.`);
        }
    }
    console.log("Rescue complete! Your database is now linked to R2.");
})();