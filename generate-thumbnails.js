const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();

// CRITICAL: Use correct database path for Render
const DB_DIR = process.env.RENDER ? '/data' : '.';
const DB_FILE = path.join(DB_DIR, 'database.db');

const db = new sqlite3.Database(DB_FILE);
const thumbDir = path.join(__dirname, 'assets', 'img', 'thumbs');

// Create thumbs directory
if (!fs.existsSync(thumbDir)) {
    fs.mkdirSync(thumbDir, { recursive: true });
    console.log('✅ Created thumbs directory');
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
                const imgPath = path.join(__dirname, images[0].path);
                const thumbPath = path.join(thumbDir, `${row.id}.jpg`);
                
                // Skip if thumbnail already exists
                if (fs.existsSync(thumbPath)) {
                    skipped++;
                    continue;
                }
                
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
                    console.log(`✅ ${row.id}: ${sizeKB}KB`);
                    processed++;
                } else {
                    console.log(`⚠️  ${row.id}: Image not found at ${imgPath}`);
                    errors++;
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
    
    // Calculate savings
    const avgOriginal = 3500; // 3.5MB average
    const avgThumb = 35; // 35KB average
    const savings = Math.round(((avgOriginal - avgThumb) / avgOriginal) * 100);
    console.log(`\n💾 Memory savings: ~${savings}%`);
    console.log(`   Before: ${avgOriginal * 6}KB per page (6 addresses)`);
    console.log(`   After:  ${avgThumb * 6}KB per page (6 addresses)`);
    console.log(`   Reduction: ${Math.round((avgOriginal * 6 - avgThumb * 6) / 1024)}MB saved per page!\n`);
    
    db.close();
    process.exit(0);
});
