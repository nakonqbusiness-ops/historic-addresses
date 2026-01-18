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
    });

    document.getElementById('authPassword').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') checkAuth();
    });

    window.logout = logout;
    window.checkAuth = checkAuth;

    var apiBase = window.location.origin;
    var API_URL = apiBase + '/api/homes';
    var PARTNERS_API = apiBase + '/api/partners';
    var state = { 
        currentPage: 1,
        totalPages: 1,
        totalHomes: 0,
        currentHomes: [],
        searchQuery: ''
    };
    var currentPartners = [];
    var searchTimeout;
    var imageSources = [];
    var portraitPreviewEl = document.getElementById('portraitPreview');
    var fPortraitEl = document.getElementById('f_portrait');

    // ========== TAB SWITCHING ==========
    document.getElementById('tabHomes').addEventListener('click', function() {
        document.getElementById('homesSection').style.display = '';
        document.getElementById('partnersSection').style.display = 'none';
        this.classList.add('active');
        document.getElementById('tabPartners').classList.remove('active');
    });
    
    document.getElementById('tabPartners').addEventListener('click', function() {
        document.getElementById('homesSection').style.display = 'none';
        document.getElementById('partnersSection').style.display = '';
        this.classList.add('active');
        document.getElementById('tabHomes').classList.remove('active');
        loadPartners();
    });

    // ========== HOMES MANAGEMENT ==========
    
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

    // ========== HOMES MODAL ==========
    
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
        
        // ADDED LINES FOR DATES
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
        
        // ADDED LINES FOR DATES
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

    // ========== PARTNERS MANAGEMENT ==========
    
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

    // ========== PARTNERS MODAL ==========
    
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

    // ========== ACTION HANDLERS ==========
    
    document.addEventListener('click', function(e){
        var act = e.target && e.target.getAttribute('data-act');
        if (!act) return;
        var id = e.target.getAttribute('data-id');
        if (!id) return;
        
        // HOMES ACTIONS
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
        
        // PARTNERS ACTIONS
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
    });
    
    document.getElementById('year').textContent = new Date().getFullYear();
})();
