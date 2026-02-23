// ============================================
// NEWS TABLE MIGRATION - RUN THIS ONCE
// ============================================
// This creates the news table in your database
// Run with: node run-once-migration.js

const Database = require('better-sqlite3');

// CHANGE THIS to match your database filename
const db = new Database('./homes.db');

console.log('Creating news table...');

try {
    // Create the table
    db.exec(`
        CREATE TABLE IF NOT EXISTS news (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            slug TEXT UNIQUE NOT NULL,
            content TEXT NOT NULL,
            excerpt TEXT,
            cover_image TEXT,
            published_date TEXT NOT NULL,
            author TEXT DEFAULT 'Екипът на Адресът на историята',
            is_published INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
    `);
    console.log('✓ News table created');

    // Create indexes
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_news_slug ON news(slug);
        CREATE INDEX IF NOT EXISTS idx_news_published ON news(is_published, published_date DESC);
    `);
    console.log('✓ Indexes created');

    // Insert sample articles
    const insert = db.prepare(`
        INSERT INTO news (title, slug, content, excerpt, cover_image, published_date, author) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insert.run(
        'Добре дошли в секцията Новини',
        'dobre-doshli-v-sektsiyata-novini',
        'Радваме се да представим новата секция "Новини" на нашия сайт. Тук ще публикуваме редовни актуализации за новите адреси, които добавяме към каталога, интересни исторически факти и предстоящи събития.\n\nНашата мисия е да запазим и споделим историята на българските домове и личности, които са оформили културата и обществото ни. Всяка седмица ще добавяме нови адреси и ще разказваме историите зад тях.\n\nБлагодарим ви, че сте част от нашата общност!',
        'Представяме новата секция "Новини" — вашият източник за актуализации и интересни исторически факти.',
        'assets/img/HistAdrLogoOrig.png',
        new Date().toISOString().split('T')[0],
        'Екипът на Адресът на историята'
    );

    insert.run(
        'Нов адрес: Къщата на Иван Вазов',
        'nov-adres-kushtata-na-ivan-vazov',
        'С гордост съобщаваме, че добавихме къщата-музей на Иван Вазов в София към нашия каталог. Разположена на ул. "Иван Вазов" № 10, тази историческа сграда беше дом на най-великия български поет и писател.\n\nКъщата е построена през 1896 г. и Вазов живя в нея до смъртта си през 1921 г. Днес сградата е музей, който пази спомените и творческото наследство на патриарха на българската литература.\n\nПосетете страницата на адреса, за да видите снимки и да научите повече за историята на това забележително място.',
        'Добавихме къщата-музей на Иван Вазов към каталога — открийте историята на патриарха на българската литература.',
        '',
        new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        'Мария Георгиева'
    );

    insert.run(
        'Предстоящо събитие: Денят на София',
        'predstoyashto-subitie-denyat-na-sofiya',
        'На 17 септември отбелязваме Деня на София! По този повод каним всички да посетят историческите адреси в центъра на столицата и да открият богатата история на града.\n\nПрепоръчваме специален маршрут през къщите на известни софиянци от началото на XX век. Вижте нашата карта за пълния списък с адреси и планирайте вашето културно пътешествие.\n\nЧестит празник на всички софиянци!',
        'Отбелязваме Деня на София с исторически маршрут през къщите на известни личности.',
        '',
        new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        'Екипът на Адресът на историята'
    );

    console.log('✓ Sample articles inserted');

    // Verify
    const count = db.prepare('SELECT COUNT(*) as count FROM news').get();
    console.log(`✓ Database has ${count.count} news articles`);

    console.log('\n✅ Migration complete! News table is ready.');
    console.log('You can now delete this file (run-once-migration.js)');

} catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error('Full error:', err);
} finally {
    db.close();
}
