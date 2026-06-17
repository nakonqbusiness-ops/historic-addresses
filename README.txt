
================================================================================
                         VPS DEPLOYMENT
================================================================================
Ubuntu 22.04 server
2. root@YOUR-IP / WINSCP - za ftp i ssh /
3. Node.js:
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt-get install -y nodejs
4. cd historic-addresses
5. npm install
6. sudo npm install -g pm2
7. pm2 start server.js --name historic-addresses
8. Install Nginx for port 80
9. Get free SSL with Let's Encrypt

================================================================================
                         VAJNI NESHTA
================================================================================

✓ Smeni parolata na admin menuto ot admin.html (line 101) predi da se pusne / ako pushen server pm2 restart historic-addresses
✓ admin menuto e skrito kato trqbva da se zadurji logoto na saita (gore lqvo) s mishkata za okolo 2-3 sekundi
✓ databaza faila /database.db/ moje da se napravi kopie za vseki sluchai
✓ kato se vzeme VPS e dobre da se sloji nginx i ssl
✓ za smqna na textovete /index.html/ ili stranicata na koqto iskash da promenish teksta I smenqsh texta mejdu <p>.....</p>
