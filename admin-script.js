(function(){
    const PASSWORD_HASH = '135a21d2896b3b414a72f31aa2ada261c499b0740bc747b731dcfbd4315619ec';
    const SESSION_KEY = 'sys_auth_token';

    async function hashPassword(password) {
        const msgBuffer = new TextEncoder().encode(password);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async function checkAuth() {
        const input = document.getElementById('authPassword').value;
        const errorEl = document.getElementById('authError');
        const buttonEl = document.getElementById('authButton');
        
        if (!input) {
            errorEl.textContent = 'Please enter password';
            return;
        }

        buttonEl.disabled = true;
        buttonEl.textContent = 'Checking...';

        const hash = await hashPassword(input);
        
        if (hash === PASSWORD_HASH) {
            sessionStorage.setItem(SESSION_KEY, hash);
            showAdminPanel();
        } else {
            errorEl.textContent = '❌ Invalid password';
            document.getElementById('authPassword').value = '';
            
            setTimeout(() => {
                buttonEl.disabled = false;
                buttonEl.textContent = 'Access';
                document.getElementById('authPassword').focus();
            }, 2000);
        }
    }

    function showAdminPanel() {
        document.getElementById('authOverlay').style.display = 'none';
        document.getElementById('adminContent').style.display = 'block';
        loadHomes(1);
    }

    function logout() {
        sessionStorage.removeItem(SESSION_KEY);
        location.reload();
    }

    window.addEventListener('DOMContentLoaded', function() {
        const stored = sessionStorage.getItem(SESSION_KEY);
        if (stored === PASSWORD_HASH) {
            showAdminPanel();
        } else {
            document.getElementById('authPassword').focus();
        }
        
        setupTabHandlers();
    });

    function setupTabHandlers() {
        var tabNews = document.getElementById('tabNews');
        var tabPartners = document.getElementById('tabPartners');
        var tabHomes = document.getElementById('tabHomes');
        
        if (!tabNews || !tabPartners || !tabHomes) {
            console.error('Tab buttons not found');
            return;
        }
        
        tabHomes.addEventListener('click', function() {
            document.getElementById('homesSection').style.display = '';
            document.getElementById('partnersSection').style.display = 'none';
            document.getElementById('newsSection').style.display = 'none';
            this.classList.add('active');
            tabPartners.classList.remove('active');
            tabNews.classList.remove('active');
        });
        
        tabPartners.addEventListener('click', function() {
            document.getElementById('homesSection').style.display = 'none';
            document.getElementById('partnersSection').style.display = '';
            document.getElementById('newsSection').style.display = 'none';
            this.classList.add('active');
            tabHomes.classList.remove('active');
            tabNews.classList.remove('active');
            loadPartners();
        });

        tabNews.addEventListener('click', function() {
            document.getElementById('homesSection').style.display = 'none';
            document.getElementById('partnersSection').style.display = 'none';
            document.getElementById('newsSection').style.display = '';
            this.classList.add('active');
            tabHomes.classList.remove('active');
            tabPartners.classList.remove('active');
            loadNews();
        });
    }

    document.getElementById('authPassword').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') checkAuth();
    });

    window.logout = logout;
    window.checkAuth = checkAuth;

    var apiBase = window.location.origin;
    var API_URL = apiBase + '/api/homes';
    var PARTNERS_API = apiBase + '/api/partners';
    var NEWS_API = apiBase + '/api/news';
    var state = { 
        currentPage: 1,
        totalPages: 1,
        totalHomes: 0,
        currentHomes: [],
        searchQuery: ''
    };
    var currentPartners = [];
    var currentNews = [];
    var searchTimeout;
    var imageSources = [];
    var portraitPreviewEl = document.getElementById('portraitPreview');
    var fPortraitEl = document.getElementById('f_portrait');

    function loadHomes(page){
        page = page || state.currentPage;
        var url = API_URL + '?all=true&page=' + page + '&limit=6';
        if (state.searchQuery) {
            url += '&search=' + encodeURIComponent(state.searchQuery);
        }
        
        fetch(url)
            .then(function(res){ 
                if (!res.ok) throw new Error('Server error');
                return res.json(); 
            })
            .then(function(response){
                var homes = response.data || response;
                var pagination = response.pagination || { 
                    page: 1, 
                    totalPages: Math.max(1, Math.ceil(homes.length / 6)), 
                    total: homes.length 
                };
                
                state.currentHomes = homes;
                state.currentPage = pagination.page;
                state.totalPages = pagination.totalPages;
                state.totalHomes = pagination.total;
                
                renderList();
                updatePagination();
            })
            .catch(function(err){
                console.error('Error loading homes:', err);
                alert('Error loading data');
            });
    }

    function renderList(){
        var list = document.getElementById('list');
        list.innerHTML = '';
        
        if (state.currentHomes.length === 0) {
            list.innerHTML = '<p style="text-align:center;padding:2rem;color:#999;">No homes found.</p>';
            return;
        }
        
        state.currentHomes.forEach(function(p){
            var card = document.createElement('div');
            card.className = 'thumb';
            var img = (p.images&&p.images[0])? p.images[0].path : '';
            card.innerHTML = '<img alt="" loading="lazy" src="'+img+'" onerror="this.style.display=\'none\'">' +
                '<div class="meta"><strong>'+(p.name||'(no name)')+'</strong><div class="muted">'+(p.address||'')+'</div>'+
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">'
                + '<button data-act="edit" data-id="'+(p.slug||p.id)+'" class="theme-toggle">Edit</button>'
                + '<button data-act="toggle" data-id="'+(p.slug||p.id)+'" class="theme-toggle">'+(p.published? 'Unpublish':'Publish')+'</button>'
                + '<button data-act="delete" data-id="'+(p.slug||p.id)+'" class="theme-toggle">Delete</button>'
                + '</div></div>';
            list.appendChild(card);
        });
    }

    function updatePagination(){
        var info = 'Page ' + state.currentPage + ' of ' + state.totalPages;
        if (state.totalHomes > 0) {
            info += ' (' + state.totalHomes + ' total)';
        }
        document.getElementById('pageInfo').textContent = info;
        document.getElementById('firstPage').disabled = state.currentPage === 1;
        document.getElementById('prevPage').disabled = state.currentPage === 1;
        document.getElementById('nextPage').disabled = state.currentPage >= state.totalPages;
        document.getElementById('lastPage').disabled = state.currentPage >= state.totalPages;
    }

    function goToPage(page){
        if (page < 1) page = 1;
        if (page > state.totalPages) page = state.totalPages;
        state.currentPage = page;
        loadHomes(page);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.getElementById('firstPage').addEventListener('click', function(){ goToPage(1); });
    document.getElementById('prevPage').addEventListener('click', function(){ goToPage(state.currentPage - 1); });
    document.getElementById('nextPage').addEventListener('click', function(){ goToPage(state.currentPage + 1); });
    document.getElementById('lastPage').addEventListener('click', function(){ goToPage(state.totalPages); });

    document.getElementById('search').addEventListener('input', function(){
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function(){
            state.searchQuery = document.getElementById('search').value;
            state.currentPage = 1;
            loadHomes(1);
        }, 500);
    });

    function openModal(title){ 
        document.getElementById('dlgTitle').textContent = title; 
        document.getElementById('modal').style.display='flex'; 
    }
    function closeModal(){ 
        document.getElementById('modal').style.display='none'; 
    }

    function syncImageField(){ document.getElementById('f_imgs').value = imageSources.join('\n'); }
    
    function renderImageList(){
        var wrap = document.getElementById('imgPrevWrap');
        var cont = document.getElementById('imgPreview');
        cont.innerHTML = '';
        if (!imageSources.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        var ph = 'assets/img/placeholder.svg';
        imageSources.forEach(function(src, idx){
            var item = document.createElement('div');
            item.className = 'preview-item';
            var safe = src || ph;
            item.innerHTML = '<img alt="Image preview" loading="lazy" src="'+safe+'" onerror="this.onerror=null;this.src=\''+ph+'\';">' +
                '<button type="button" data-remove="'+idx+'">×</button>';
            cont.appendChild(item);
        });
    }

    function renderPortraitPreview() {
        portraitPreviewEl.innerHTML = '';
        var url = fPortraitEl.value.trim();
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Portrait Preview';
            img.style.maxWidth = '100px';
            img.style.maxHeight = '100px';
            img.style.objectFit = 'contain';
            img.style.borderRadius = '50%';
            img.style.border = '2px solid var(--accent)';
            
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() {
                fPortraitEl.value = '';
                renderPortraitPreview();
            };

            portraitPreviewEl.appendChild(img);
            portraitPreviewEl.appendChild(clearBtn);
        }
    }
    
    function loadPortraitFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image file'); return; }
        if (file.size > 5 * 1024 * 1024) { alert('File size exceeds 5MB'); return; }

        var fr = new FileReader();
        fr.onload = function(){
            fPortraitEl.value = fr.result;
            renderPortraitPreview();
        };
        fr.readAsDataURL(file);
    }

    function fillForm(p){
        document.getElementById('f_name').value = p.name||'';
        document.getElementById('f_slug').value = p.slug || p.id || '';
        fPortraitEl.value = p.portrait_url||'';
        document.getElementById('f_birth_date').value = p.birth_date || '';
        document.getElementById('f_death_date').value = p.death_date || '';
        
        renderPortraitPreview();
        document.getElementById('f_bio').value = p.biography||'';
        document.getElementById('f_addr').value = p.address||'';
        document.getElementById('f_lat').value = p.coordinates && p.coordinates.lat || '';
        document.getElementById('f_lng').value = p.coordinates && p.coordinates.lng || '';
        imageSources = (p.images||[]).map(function(i){ return i && i.path; }).filter(Boolean);
        syncImageField();
        document.getElementById('f_date').value = p.photo_date||'';
        document.getElementById('f_sources').value = (p.sources||[]).join('; ');
        document.getElementById('f_tags').value = (p.tags||[]).join(', ');
        document.getElementById('f_published').checked = (typeof p.published === 'boolean') ? p.published : true;
        renderImageList();
    }

    function slugify(text){
        return (text||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,'');
    }

    function readForm(existing){
        var p = existing || {};
        p.name = document.getElementById('f_name').value.trim();
        var slugInput = document.getElementById('f_slug').value.trim();
        if (!slugInput) slugInput = slugify(p.name);
        p.slug = slugInput || p.slug || p.id || '';
        p.portrait_url = fPortraitEl.value.trim() || null;
        p.birth_date = document.getElementById('f_birth_date').value || null;
        p.death_date = document.getElementById('f_death_date').value || null;

        p.biography = document.getElementById('f_bio').value.trim();
        p.address = document.getElementById('f_addr').value.trim();
        var lat = document.getElementById('f_lat').value.trim();
        var lng = document.getElementById('f_lng').value.trim();
        if (lat && lng) p.coordinates = { lat: parseFloat(lat), lng: parseFloat(lng) };
        var txtSources = document.getElementById('f_imgs').value.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
        imageSources = txtSources.slice();
        if (imageSources.length) {
            p.images = imageSources.map(function(src){ return { path: src, caption: '', alt: 'Facade of '+(p.name||'') }; });
        } else {
            p.images = [];
        }
        p.photo_date = document.getElementById('f_date').value.trim();
        var sources = document.getElementById('f_sources').value.trim();
        p.sources = sources ? sources.split(';').map(function(s){ return s.trim(); }).filter(Boolean) : [];
        var tags = document.getElementById('f_tags').value.trim();
        p.tags = tags ? tags.split(',').map(function(s){ return s.trim(); }).filter(Boolean) : [];
        if (!p.id) p.id = p.slug || slugify(p.name);
        var now = new Date().toISOString();
        if (!p.created_at) p.created_at = now;
        p.updated_at = now;
        p.published = !!document.getElementById('f_published').checked;
        return p;
    }

    function addNew(){
        document.getElementById('f_id').value = '';
        fillForm({ published: true });
        openModal('Add Home');
    }

    function editHome(id){
        fetch(API_URL + '/' + id)
            .then(function(res){ return res.json(); })
            .then(function(home){
                document.getElementById('f_id').value = home.id || home.slug;
                fillForm(home);
                openModal('Edit Home');
            })
            .catch(function(err){
                console.error('Error loading home:', err);
                alert('Error loading home');
            });
    }

    document.getElementById('addBtn').addEventListener('click', addNew);
    document.getElementById('cancelDlg').addEventListener('click', closeModal);
    document.getElementById('closeDlg').addEventListener('click', closeModal);

    function loadImageFile(file){
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        if (file.size > 10 * 1024 * 1024) { alert('Image exceeds 10MB'); return; }
        var fr = new FileReader();
        fr.onload = function(){
            imageSources.push(fr.result);
            syncImageField();
            renderImageList();
        };
        fr.readAsDataURL(file);
    }

    document.getElementById('imgDrop').addEventListener('dragover', function(e){ e.preventDefault(); });
    document.getElementById('imgDrop').addEventListener('drop', function(e){
        e.preventDefault();
        var files = (e.dataTransfer.files && Array.from(e.dataTransfer.files)) || [];
        files.forEach(loadImageFile);
    });
    document.getElementById('imgPick').addEventListener('click', function(){ document.getElementById('imgFile').click(); });
    document.getElementById('imgFile').addEventListener('change', function(e){ 
        var files = (e.target.files && Array.from(e.target.files)) || []; 
        files.forEach(loadImageFile); 
    });
    document.getElementById('imgPreview').addEventListener('click', function(e){
        var btn = e.target.closest && e.target.closest('button[data-remove]');
        if (!btn) return;
        var idx = parseInt(btn.getAttribute('data-remove'), 10);
        imageSources.splice(idx, 1);
        syncImageField();
        renderImageList();
    });
    document.getElementById('f_imgs').addEventListener('input', function(){
        imageSources = this.value.split(/\r?\n/).map(function(s){ return s.trim(); }).filter(Boolean);
        renderImageList();
    });

    document.getElementById('portraitDrop').addEventListener('dragover', function(e){ e.preventDefault(); });
    document.getElementById('portraitDrop').addEventListener('drop', function(e){
        e.preventDefault();
        var file = (e.dataTransfer.files && e.dataTransfer.files[0]) || null;
        if (file) loadPortraitFile(file);
    });
    document.getElementById('portraitPick').addEventListener('click', function(){ document.getElementById('portraitFile').click(); });
    document.getElementById('portraitFile').addEventListener('change', function(e){ 
        var file = (e.target.files && e.target.files[0]) || null;
        if (file) loadPortraitFile(file);
        e.target.value = '';
    });
    fPortraitEl.addEventListener('input', renderPortraitPreview);

    document.getElementById('objForm').addEventListener('submit', function(e){
        e.preventDefault();
        var homeId = document.getElementById('f_id').value;
        var homeData = readForm({});
        
        if (!homeId) {
            fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(homeData)
            })
            .then(function(res){ return res.json(); })
            .then(function(){
                closeModal();
                loadHomes(1);
                alert('Home created!');
            })
            .catch(function(err){ console.error(err); alert('Error creating home'); });
        } else {
            fetch(API_URL + '/' + homeId)
                .then(function(res){ return res.json(); })
                .then(function(existing){
                    var updated = readForm(existing);
                    return fetch(API_URL + '/' + homeId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(updated)
                    });
                })
                .then(function(res){ return res.json(); })
                .then(function(){
                    closeModal();
                    loadHomes(state.currentPage);
                    alert('Home updated!');
                })
                .catch(function(err){ console.error(err); alert('Error updating home'); });
        }
    });

    function loadPartners() {
        var search = (document.getElementById('partnerSearch').value || '').toLowerCase();
        
        fetch(PARTNERS_API + '?all=true')
            .then(function(res) { return res.json(); })
            .then(function(partners) {
                currentPartners = partners;
                
                if (search) {
                    partners = partners.filter(function(p) {
                        return p.name.toLowerCase().includes(search) ||
                               (p.description && p.description.toLowerCase().includes(search));
                    });
                }
                
                renderPartners(partners);
            })
            .catch(function(err) {
                console.error('Error loading partners:', err);
                alert('Error loading partners');
            });
    }
    
    function renderPartners(partners) {
        var list = document.getElementById('partnersList');
        list.innerHTML = '';
        
        if (partners.length === 0) {
            list.innerHTML = '<p style="text-align:center;padding:2rem;color:#999;">No partners found.</p>';
            return;
        }
        
        partners.forEach(function(p) {
            var card = document.createElement('div');
            card.className = 'thumb';
            var logo = p.logo_url || 'assets/img/placeholder.svg';
            
            card.innerHTML = '<img alt="' + p.name + '" loading="lazy" src="' + logo + '" style="object-fit:contain;background:#fff;padding:10px;">' +
                '<div class="meta"><strong>' + p.name + '</strong>' +
                '<div class="muted" style="margin-top:4px;font-size:0.9rem;">' + (p.description ? p.description.substring(0, 60) + '...' : 'No description') + '</div>' +
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button data-act="editPartner" data-id="' + p.id + '" class="theme-toggle">Edit</button>' +
                '<button data-act="togglePartner" data-id="' + p.id + '" class="theme-toggle">' + (p.published ? 'Unpublish' : 'Publish') + '</button>' +
                '<button data-act="deletePartner" data-id="' + p.id + '" class="theme-toggle">Delete</button>' +
                '</div></div>';
            list.appendChild(card);
        });
    }

    var partnerSearchTimeout;
    document.getElementById('partnerSearch').addEventListener('input', function() {
        clearTimeout(partnerSearchTimeout);
        partnerSearchTimeout = setTimeout(loadPartners, 300);
    });

    function openPartnerModal(title) {
        document.getElementById('partnerDlgTitle').textContent = title;
        document.getElementById('partnerModal').style.display = 'flex';
    }
    
    function closePartnerModal() {
        document.getElementById('partnerModal').style.display = 'none';
    }
    
    function fillPartnerForm(p) {
        document.getElementById('p_name').value = p.name || '';
        document.getElementById('p_desc').value = p.description || '';
        document.getElementById('p_logo').value = p.logo_url || '';
        document.getElementById('p_website').value = p.website || '';
        document.getElementById('p_instagram').value = p.instagram || '';
        document.getElementById('p_email').value = p.email || '';
        document.getElementById('p_order').value = p.display_order || 0;
        document.getElementById('p_published').checked = p.published !== false;
        renderLogoPreview();
    }
    
    function renderLogoPreview() {
        var preview = document.getElementById('logoPreview');
        var url = document.getElementById('p_logo').value.trim();
        preview.innerHTML = '';
        
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Logo Preview';
            img.style.maxWidth = '150px';
            img.style.maxHeight = '150px';
            img.style.objectFit = 'contain';
            img.style.background = '#fff';
            img.style.padding = '10px';
            img.style.borderRadius = '8px';
            
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() {
                document.getElementById('p_logo').value = '';
                renderLogoPreview();
            };
            
            preview.appendChild(img);
            preview.appendChild(clearBtn);
        }
    }
    
    function loadLogoFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        if (file.size > 5 * 1024 * 1024) { alert('Logo exceeds 5MB'); return; }
        
        var fr = new FileReader();
        fr.onload = function() {
            document.getElementById('p_logo').value = fr.result;
            renderLogoPreview();
        };
        fr.readAsDataURL(file);
    }
    
    document.getElementById('addPartnerBtn').addEventListener('click', function() {
        document.getElementById('p_id').value = '';
        fillPartnerForm({ published: true, display_order: 0 });
        openPartnerModal('Add Partner');
    });
    
    document.getElementById('closePartnerDlg').addEventListener('click', closePartnerModal);
    document.getElementById('cancelPartnerDlg').addEventListener('click', closePartnerModal);
    
    document.getElementById('p_logo').addEventListener('input', renderLogoPreview);
    
    document.getElementById('logoDrop').addEventListener('dragover', function(e) { e.preventDefault(); });
    document.getElementById('logoDrop').addEventListener('drop', function(e) {
        e.preventDefault();
        var file = (e.dataTransfer.files && e.dataTransfer.files[0]) || null;
        if (file) loadLogoFile(file);
    });
    
    document.getElementById('logoPick').addEventListener('click', function() {
        document.getElementById('logoFile').click();
    });
    
    document.getElementById('logoFile').addEventListener('change', function(e) {
        var file = (e.target.files && e.target.files[0]) || null;
        if (file) loadLogoFile(file);
        e.target.value = '';
    });
    
    document.getElementById('partnerForm').addEventListener('submit', function(e) {
        e.preventDefault();
        
        var partnerId = document.getElementById('p_id').value;
        var partnerData = {
            id: partnerId || undefined,
            name: document.getElementById('p_name').value.trim(),
            description: document.getElementById('p_desc').value.trim(),
            logo_url: document.getElementById('p_logo').value.trim() || null,
            website: document.getElementById('p_website').value.trim() || null,
            instagram: document.getElementById('p_instagram').value.trim() || null,
            email: document.getElementById('p_email').value.trim() || null,
            display_order: parseInt(document.getElementById('p_order').value) || 0,
            published: document.getElementById('p_published').checked
        };
        
        if (!partnerId) {
            fetch(PARTNERS_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(partnerData)
            })
            .then(function(res) { return res.json(); })
            .then(function() {
                closePartnerModal();
                loadPartners();
                alert('Partner created!');
            })
            .catch(function(err) {
                console.error(err);
                alert('Error creating partner');
            });
        } else {
            fetch(PARTNERS_API + '/' + partnerId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(partnerData)
            })
            .then(function(res) { return res.json(); })
            .then(function() {
                closePartnerModal();
                loadPartners();
                alert('Partner updated!');
            })
            .catch(function(err) {
                console.error(err);
                alert('Error updating partner');
            });
        }
    });

    function loadNews() {
        var search = (document.getElementById('newsSearch').value || '').toLowerCase();
        
        fetch(NEWS_API + '?all=true&limit=100')
            .then(function(res) { return res.json(); })
            .then(function(response) {
                var news = response.data || [];
                currentNews = news;
                
                if (search) {
                    news = news.filter(function(n) {
                        return n.title.toLowerCase().includes(search) ||
                               (n.excerpt && n.excerpt.toLowerCase().includes(search)) ||
                               (n.content && n.content.toLowerCase().includes(search));
                    });
                }
                
                renderNews(news);
            })
            .catch(function(err) {
                console.error('Error loading news:', err);
                alert('Error loading news');
            });
    }

    function renderNews(news) {
        var list = document.getElementById('newsList');
        list.innerHTML = '';
        
        if (news.length === 0) {
            list.innerHTML = '<p style="text-align:center;padding:2rem;color:#999;">No news articles found.</p>';
            return;
        }
        
        news.forEach(function(n) {
            var card = document.createElement('div');
            card.className = 'thumb';
            var cover = n.cover_image || 'assets/img/placeholder.svg';
            
            var publishedLabel = n.is_published ? 'Published' : 'Draft';
            var statusColor = n.is_published ? '#28a745' : '#ffc107';
            
            card.innerHTML = '<img alt="' + n.title + '" loading="lazy" src="' + cover + '" style="object-fit:cover;height:180px;">' +
                '<div class="meta"><strong>' + n.title + '</strong>' +
                '<div class="muted" style="margin-top:4px;font-size:0.85rem;">📅 ' + n.published_date + '</div>' +
                '<div style="margin-top:4px;font-size:0.85rem;color:' + statusColor + ';">● ' + publishedLabel + '</div>' +
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button data-act="editNews" data-id="' + n.id + '" class="theme-toggle">Edit</button>' +
                '<button data-act="toggleNews" data-id="' + n.id + '" class="theme-toggle">' + (n.is_published ? 'Unpublish' : 'Publish') + '</button>' +
                '<button data-act="deleteNews" data-id="' + n.id + '" class="theme-toggle">Delete</button>' +
                '</div></div>';
            list.appendChild(card);
        });
    }

    var newsSearchTimeout;
    document.getElementById('newsSearch').addEventListener('input', function() {
        clearTimeout(newsSearchTimeout);
        newsSearchTimeout = setTimeout(loadNews, 300);
    });

    function openNewsModal(title) {
        document.getElementById('newsDlgTitle').textContent = title;
        document.getElementById('newsModal').style.display = 'flex';
    }

    function closeNewsModal() {
        document.getElementById('newsModal').style.display = 'none';
    }

    function fillNewsForm(n) {
        document.getElementById('n_title').value = n.title || '';
        document.getElementById('n_slug').value = n.slug || '';
        document.getElementById('n_excerpt').value = n.excerpt || '';
        document.getElementById('n_content').value = n.content || '';
        document.getElementById('n_cover').value = n.cover_image || '';
        document.getElementById('n_date').value = n.published_date || new Date().toISOString().split('T')[0];
        document.getElementById('n_author').value = n.author || 'Екипът на Адресът на историята';
        document.getElementById('n_published').checked = n.is_published !== 0;
        renderNewsCoverPreview();
    }

    function renderNewsCoverPreview() {
        var preview = document.getElementById('newsCoverPreview');
        var url = document.getElementById('n_cover').value.trim();
        preview.innerHTML = '';
        
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Cover Preview';
            img.style.maxWidth = '200px';
            img.style.maxHeight = '150px';
            img.style.objectFit = 'cover';
            img.style.borderRadius = '8px';
            
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() {
                document.getElementById('n_cover').value = '';
                renderNewsCoverPreview();
            };
            
            preview.appendChild(img);
            preview.appendChild(clearBtn);
        }
    }

    function loadNewsCoverFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        if (file.size > 5 * 1024 * 1024) { alert('Image exceeds 5MB'); return; }
        
        var fr = new FileReader();
        fr.onload = function() {
            document.getElementById('n_cover').value = fr.result;
            renderNewsCoverPreview();
        };
        fr.readAsDataURL(file);
    }

    document.getElementById('addNewsBtn').addEventListener('click', function() {
        document.getElementById('n_id').value = '';
        fillNewsForm({ 
            is_published: 1,
            published_date: new Date().toISOString().split('T')[0],
            author: 'Екипът на Адресът на историята'
        });
        openNewsModal('Add News Article');
    });

    document.getElementById('closeNewsDlg').addEventListener('click', closeNewsModal);
    document.getElementById('cancelNewsDlg').addEventListener('click', closeNewsModal);

    document.getElementById('n_cover').addEventListener('input', renderNewsCoverPreview);

    document.getElementById('newsCoverDrop').addEventListener('dragover', function(e) { e.preventDefault(); });
    document.getElementById('newsCoverDrop').addEventListener('drop', function(e) {
        e.preventDefault();
        var file = (e.dataTransfer.files && e.dataTransfer.files[0]) || null;
        if (file) loadNewsCoverFile(file);
    });

    document.getElementById('newsCoverPick').addEventListener('click', function() {
        document.getElementById('newsCoverFile').click();
    });

    document.getElementById('newsCoverFile').addEventListener('change', function(e) {
        var file = (e.target.files && e.target.files[0]) || null;
        if (file) loadNewsCoverFile(file);
        e.target.value = '';
    });

    document.getElementById('n_title').addEventListener('input', function() {
        var slugField = document.getElementById('n_slug');
        if (!slugField.value) {
            slugField.value = slugify(this.value);
        }
    });

    document.getElementById('newsForm').addEventListener('submit', function(e) {
        e.preventDefault();
        
        var newsId = document.getElementById('n_id').value;
        var title = document.getElementById('n_title').value.trim();
        var slug = document.getElementById('n_slug').value.trim();
        
        if (!slug) {
            slug = slugify(title);
            document.getElementById('n_slug').value = slug;
        }
        
        var newsData = {
            title: title,
            slug: slug,
            excerpt: document.getElementById('n_excerpt').value.trim() || '',
            content: document.getElementById('n_content').value.trim(),
            cover_image: document.getElementById('n_cover').value.trim() || '',
            published_date: document.getElementById('n_date').value,
            author: document.getElementById('n_author').value.trim(),
            is_published: document.getElementById('n_published').checked ? 1 : 0
        };

        if (!newsData.title || !newsData.slug || !newsData.content) {
            alert('Title, slug, and content are required');
            return;
        }
        
        if (!newsId) {
            fetch(NEWS_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newsData)
            })
            .then(function(res) { return res.json(); })
            .then(function() {
                closeNewsModal();
                loadNews();
                alert('Article created!');
            })
            .catch(function(err) {
                console.error(err);
                alert('Error creating article: ' + (err.message || 'Unknown error'));
            });
        } else {
            fetch(NEWS_API + '/' + newsId, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(newsData)
            })
            .then(function(res) { return res.json(); })
            .then(function() {
                closeNewsModal();
                loadNews();
                alert('Article updated!');
            })
            .catch(function(err) {
                console.error(err);
                alert('Error updating article');
            });
        }
    });

    document.addEventListener('click', function(e){
        var act = e.target && e.target.getAttribute('data-act');
        if (!act) return;
        var id = e.target.getAttribute('data-id');
        if (!id) return;
        
        if (act === 'edit') {
            editHome(id);
        }
        
        if (act === 'toggle') {
            fetch(API_URL + '/' + id)
                .then(function(res){ return res.json(); })
                .then(function(home){
                    home.published = !home.published;
                    return fetch(API_URL + '/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(home)
                    });
                })
                .then(function(){ loadHomes(state.currentPage); })
                .catch(function(err){ console.error(err); alert('Error updating'); });
        }
        
        if (act === 'delete') {
            if (confirm('Delete this home?')) {
                fetch(API_URL + '/' + id, { method: 'DELETE' })
                    .then(function(){ loadHomes(state.currentPage); })
                    .catch(function(err){ console.error(err); alert('Error deleting'); });
            }
        }
        
        if (act === 'editPartner') {
            fetch(PARTNERS_API + '/' + id)
                .then(function(res) { return res.json(); })
                .then(function(partner) {
                    document.getElementById('p_id').value = partner.id;
                    fillPartnerForm(partner);
                    openPartnerModal('Edit Partner');
                })
                .catch(function(err) {
                    console.error(err);
                    alert('Error loading partner');
                });
        }
        
        if (act === 'togglePartner') {
            fetch(PARTNERS_API + '/' + id)
                .then(function(res) { return res.json(); })
                .then(function(partner) {
                    partner.published = !partner.published;
                    return fetch(PARTNERS_API + '/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(partner)
                    });
                })
                .then(function() { loadPartners(); })
                .catch(function(err) {
                    console.error(err);
                    alert('Error updating partner');
                });
        }
        
        if (act === 'deletePartner') {
            if (confirm('Delete this partner?')) {
                fetch(PARTNERS_API + '/' + id, { method: 'DELETE' })
                    .then(function() { loadPartners(); })
                    .catch(function(err) {
                        console.error(err);
                        alert('Error deleting partner');
                    });
            }
        }

        if (act === 'editNews') {
            fetch(NEWS_API + '/' + id + '?all=true')
                .then(function(res) {
                    if (!res.ok) {
                        return fetch(NEWS_API + '?all=true&limit=1000')
                            .then(function(res2) { return res2.json(); })
                            .then(function(response) {
                                var article = response.data.find(function(n) { return n.id == id; });
                                if (!article) throw new Error('Article not found');
                                return article;
                            });
                    }
                    return res.json();
                })
                .then(function(article) {
                    document.getElementById('n_id').value = article.id;
                    fillNewsForm(article);
                    openNewsModal('Edit News Article');
                })
                .catch(function(err) {
                    console.error(err);
                    alert('Error loading article');
                });
        }

        if (act === 'toggleNews') {
            fetch(NEWS_API + '?all=true&limit=1000')
                .then(function(res) { return res.json(); })
                .then(function(response) {
                    var article = response.data.find(function(n) { return n.id == id; });
                    if (!article) throw new Error('Article not found');
                    article.is_published = article.is_published ? 0 : 1;
                    return fetch(NEWS_API + '/' + id, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(article)
                    });
                })
                .then(function() { loadNews(); })
                .catch(function(err) {
                    console.error(err);
                    alert('Error updating article');
                });
        }

        if (act === 'deleteNews') {
            if (confirm('Delete this article?')) {
                fetch(NEWS_API + '/' + id, { method: 'DELETE' })
                    .then(function() { loadNews(); })
                    .catch(function(err) {
                        console.error(err);
                        alert('Error deleting article');
                    });
            }
        }
    });
    
    document.getElementById('year').textContent = new Date().getFullYear();
})();
