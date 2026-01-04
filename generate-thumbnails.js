const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// Check if database exists in /data first, then fallback to current directory
let DB_FILE;
if (fs.existsSync('/data/database.db')) {
    DB_FILE = '/data/database.db';
    console.log('✅ Using database at /data/database.db');
} else if (fs.existsSync('./database.db')) {
    DB_FILE = './database.db';
    console.log('✅ Using database at ./database.db');
} else {
    console.error('❌ No database found! Checked /data/database.db and ./database.db');
    process.exit(1);
}

const db = new sqlite3.Database(DB_FILE);

// CRITICAL: Store thumbnails in persistent /data directory on Render
const thumbDir = fs.existsSync('/data') ? '/data/thumbs' : path.join(__dirname, 'assets', 'img', 'thumbs');

// Create thumbs directory
if (!fs.existsSync(thumbDir)) {
    fs.mkdirSync(thumbDir, { recursive: true });
    console.log('✅ Created thumbs directory:', thumbDir);
}

db.all('SELECT id, images FROM homes WHERE published = 1', [], async (err, rows) => {
    if (err) {
        console.error('Database error:', err);
        process.exit(1);
    }
    
    console.log(`\n🖼️  Found ${rows.length} homes to process...\n`);
    let processed = 0;
    let errors = 0;
    let skipped = 0;
    
    for (const row of rows) {
        try {
            const images = JSON.parse(row.images || '[]');
            
            if (images.length > 0 && images[0].path) {
                const thumbPath = path.join(thumbDir, `${row.id}.jpg`);
                
                // Skip if thumbnail already exists
                if (fs.existsSync(thumbPath)) {
                    skipped++;
                    continue;
                }
                
                const imagePath = images[0].path;
                
                // Check if it's a base64 image
                if (imagePath.startsWith('data:image/')) {
                    // Extract base64 data
                    const base64Data = imagePath.split(',')[1];
                    if (!base64Data) {
                        console.log(`⚠️  ${row.id}: Invalid base64 format`);
                        errors++;
                        continue;
                    }
                    
                    // Convert base64 to buffer
                    const imageBuffer = Buffer.from(base64Data, 'base64');
                    
                    // Generate thumbnail from buffer
                    await sharp(imageBuffer)
                        .resize(400, 300, { 
                            fit: 'cover',
                            position: 'center'
                        })
                        .jpeg({ 
                            quality: 70,
                            progressive: true
                        })
                        .toFile(thumbPath);
                    
                    const stats = fs.statSync(thumbPath);
                    const sizeKB = Math.round(stats.size / 1024);
                    console.log(`✅ ${row.id}: ${sizeKB}KB (from base64)`);
                    processed++;
                    
                } else {
                    // It's a file path
                    const imgPath = path.join(__dirname, imagePath);
                    
                    if (fs.existsSync(imgPath)) {
                        await sharp(imgPath)
                            .resize(400, 300, { 
                                fit: 'cover',
                                position: 'center'
                            })
                            .jpeg({ 
                                quality: 70,
                                progressive: true
                            })
                            .toFile(thumbPath);
                        
                        const stats = fs.statSync(thumbPath);
                        const sizeKB = Math.round(stats.size / 1024);
                        console.log(`✅ ${row.id}: ${sizeKB}KB (from file)`);
                        processed++;
                    } else {
                        console.log(`⚠️  ${row.id}: Image file not found at ${imgPath}`);
                        errors++;
                    }
                }
            } else {
                console.log(`⚠️  ${row.id}: No images in database`);
                errors++;
            }
        } catch (e) {
            console.error(`❌ ${row.id}: ${e.message}`);
            errors++;
        }
    }
    
    console.log(`\n📊 Complete!`);
    console.log(`   ✅ ${processed} new thumbnails generated`);
    console.log(`   ⏭️  ${skipped} already existed`);
    console.log(`   ❌ ${errors} errors`);
    
    // Calculate savings - base64 images are HUGE in memory
    const avgOriginalBase64 = 3500; // 3.5MB average base64 in memory
    const avgThumb = 35; // 35KB average thumbnail
    const savings = Math.round(((avgOriginalBase64 - avgThumb) / avgOriginalBase64) * 100);
    console.log(`\n💾 Memory savings: ~${savings}%`);
    console.log(`   Before: ~${avgOriginalBase64 * 6}KB per page (6 addresses, base64)`);
    console.log(`   After:  ${avgThumb * 6}KB per page (6 addresses, thumbnails)`);
    console.log(`   Reduction: ${Math.round((avgOriginalBase64 * 6 - avgThumb * 6) / 1024)}MB saved per page!\n`);
    
    db.close();
    process.exit(0);
});
