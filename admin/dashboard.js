(function(){
    // Content management runs on the user-account RBAC. Access requires a logged-in
    // ADMIN or OWNER session (HttpOnly cookie) — there is no separate admin password.
    //   admin → addresses + watermark
    //   owner → everything (+ news, team, partners, IP blacklist)
    // Same-origin fetches send the auth cookie automatically, so the CRUD calls below
    // need no token plumbing.
    var ROLE_RANK = { user: 0, moderator: 1, admin: 2, owner: 3 };
    function rank(r) { return ROLE_RANK[r] || 0; }
    var currentRole = 'admin';
    function isOwner() { return rank(currentRole) >= ROLE_RANK.owner; }

    function showAdminPanel(role, name) {
        currentRole = role || 'admin';
        document.getElementById('adminContent').style.display = 'block';

        var hour = new Date().getHours();
        var greeting = hour < 12 ? 'Добро утро' : hour < 18 ? 'Добър ден' : 'Добър вечер';
        var greetingEl = document.getElementById('adminGreeting');
        if (greetingEl && name) greetingEl.textContent = greeting + ', ' + name + ' 👋';
        var roleLbl = isOwner() ? 'Собственик' : 'Администратор';
        var roleEl = document.getElementById('adminRoleTag');
        if (roleEl) roleEl.textContent = roleLbl;
        var av = document.getElementById('acctAvatar'); if (av) av.textContent = (String(name || '?').trim().charAt(0) || '?').toUpperCase();
        var an = document.getElementById('acctName'); if (an) an.textContent = name || 'Профил';
        var ar = document.getElementById('acctRole'); if (ar) ar.textContent = 'Роля: ' + roleLbl;

        // Owner-only tabs; addresses + watermark stay available to admins.
        ['tabPartners', 'tabNews', 'tabTeam', 'tabIp'].forEach(function(id) {
            var el = document.getElementById(id); if (el) el.style.display = isOwner() ? '' : 'none';
        });

        loadHomes(1);
    }

    function logout() {
        fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
            .then(function(){ location.href = '/login.html'; })
            .catch(function(){ location.href = '/login.html'; });
    }

    window.addEventListener('DOMContentLoaded', function() {
        fetch('/api/auth/me', { credentials: 'include' })
            .then(function(r) { if (!r.ok) throw 'auth'; return r.json(); })
            .then(function(me) {
                if (rank(me.role) < ROLE_RANK.admin) {
                    document.body.innerHTML = '<div style="max-width:480px;margin:4rem auto;text-align:center;font-family:system-ui,sans-serif;color:#ddd"><h2>🔒 Нямате достъп</h2><p>Този панел е само за администратори и собственици.</p><a href="/index.html" style="color:#cd853f">Към началната страница</a></div>';
                    return;
                }
                // Staff 2FA is mandatory; if not yet enrolled, send them to enrol first.
                if (me.totp_required && !me.totp_enabled) { location.href = '/profile.html#twofa'; return; }
                showAdminPanel(me.role, me.display_name || me.email);
            })
            .catch(function() { location.href = '/login.html'; });
    });

    window.logout = logout;

    // ── Account avatar dropdown ──
    (function(){
        var btn = document.getElementById('acctBtn'), menu = document.getElementById('acctMenu');
        if (!btn || !menu) return;
        btn.addEventListener('click', function(e){
            e.stopPropagation();
            if (menu.hasAttribute('hidden')) { menu.removeAttribute('hidden'); btn.setAttribute('aria-expanded', 'true'); }
            else { menu.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
        });
        document.addEventListener('click', function(e){
            if (!menu.hasAttribute('hidden') && !e.target.closest('.acct')) { menu.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); }
        });
        document.addEventListener('keydown', function(e){ if (e.key === 'Escape') { menu.setAttribute('hidden', ''); btn.setAttribute('aria-expanded', 'false'); } });
    })();

    // ── R2 Upload Helper ──────────────────────────────────────────
    // watermark=true  → applies © photographer watermark (home gallery, news)
    // watermark=false → uploads clean (portrait, logo, team photo)
async function uploadToR2(file, homeSlug, watermark, photographer) {
    const formData = new FormData();
    formData.append('image', file);
    formData.append('homeSlug', homeSlug || 'img');
    formData.append('watermark', watermark ? 'true' : 'false');
    if (photographer) formData.append('photographer', photographer);

    const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData
    });

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error || `Upload failed (${response.status})`);
    }

    const data = await response.json();
    return data; // { url, thumb, filename }
}

    function getPhotographer() {
        return (document.getElementById('photographerName') || {}).value || '';
    }
    function getWatermark() {
        var el = document.getElementById('applyWatermark');
        return el ? el.checked : true;   // default on
    }

    function setUploadStatus(msg) {
        var el = document.getElementById('uploadStatus');
        if (el) el.textContent = msg;
    }

    // ── API base URLs ─────────────────────────────────────────────
    var apiBase = window.location.origin;
    var API_URL = apiBase + '/api/homes';
    var PARTNERS_API = apiBase + '/api/partners';
    var NEWS_API = apiBase + '/api/news';
    var TEAM_API = apiBase + '/api/team';

    var state = {
        currentPage: 1,
        totalPages: 1,
        totalHomes: 0,
        currentHomes: [],
        searchQuery: ''
    };
    var currentPartners = [];
    var currentNews = [];
    var currentTeam = [];
    var searchTimeout;
    var imageSources = [];
    var imageThumbs = {};   // maps full image URL -> thumbnail URL

    // ── Related-places picker ──────────────────────────────────────────────────
    var relatedSelected = [];   // [{id,name,category}] - this home's outgoing related links
    var CATLBL = { home: 'Дом', monument: 'Паметник', events: 'Събитие' };
    var relSearchTimer, relInit = false;

    function renderRelChips() {
        var box = document.getElementById('f_rel_chips');
        if (!box) return;
        box.innerHTML = '';
        relatedSelected.forEach(function(r) {
            var chip = document.createElement('span'); chip.className = 'rel-chip';
            var nm = document.createElement('b'); nm.textContent = r.name || r.id;
            var cat = document.createElement('span'); cat.className = 'rel-cat'; cat.textContent = CATLBL[r.category] || '';
            var x = document.createElement('button'); x.type = 'button'; x.innerHTML = '&times;'; x.title = 'Премахни';
            x.addEventListener('click', function() { relatedSelected = relatedSelected.filter(function(s){ return s.id !== r.id; }); renderRelChips(); });
            chip.appendChild(nm); if (cat.textContent) chip.appendChild(cat); chip.appendChild(x);
            box.appendChild(chip);
        });
    }
    function relAdd(item) {
        if (relatedSelected.some(function(s){ return s.id === item.id; })) return;
        if (relatedSelected.length >= 12) { alert('Максимум 12 свързани обекта.'); return; }
        relatedSelected.push({ id: item.id, name: item.name, category: item.category });
        renderRelChips();
    }
    function initRelatedPicker() {
        if (relInit) return; relInit = true;
        var input = document.getElementById('f_rel_search');
        var results = document.getElementById('f_rel_results');
        if (!input || !results) return;
        input.addEventListener('input', function() {
            clearTimeout(relSearchTimer);
            var q = input.value.trim();
            if (q.length < 2) { results.innerHTML = ''; return; }
            relSearchTimer = setTimeout(function() {
                fetch(API_URL + '?all=true&limit=8&search=' + encodeURIComponent(q))
                    .then(function(r){ return r.json(); })
                    .then(function(resp) {
                        var list = (resp && resp.data) || resp || [];
                        var curId = (document.getElementById('f_id') || {}).value || '';
                        var curSlug = document.getElementById('f_slug').value;
                        results.innerHTML = '';
                        var shown = list.filter(function(h){ return h.id !== curId && h.slug !== curSlug; }).slice(0, 8);
                        if (!shown.length) { results.innerHTML = '<div class="rel-result-empty">Няма резултати</div>'; return; }
                        shown.forEach(function(h) {
                            var added = relatedSelected.some(function(s){ return s.id === h.id; });
                            var row = document.createElement('div'); row.className = 'rel-result' + (added ? ' added' : '');
                            var nm = document.createElement('span'); nm.textContent = h.name;
                            var cat = document.createElement('span'); cat.className = 'rel-cat'; cat.textContent = CATLBL[h.category] || '';
                            row.appendChild(nm); row.appendChild(cat);
                            if (!added) row.addEventListener('click', function() { relAdd(h); input.value = ''; results.innerHTML = ''; input.focus(); });
                            results.appendChild(row);
                        });
                    })
                    .catch(function(){ results.innerHTML = '<div class="rel-result-empty">Грешка при търсене</div>'; });
            }, 250);
        });
        document.addEventListener('click', function(e) { if (!e.target.closest('.rel-search-wrap')) results.innerHTML = ''; });
    }
    var portraitPreviewEl = document.getElementById('portraitPreview');
    var fPortraitEl = document.getElementById('f_portrait');

    // ── Tab switching ─────────────────────────────────────────────
    document.getElementById('tabHomes').addEventListener('click', function() {
        showSection('homesSection'); setActiveTab('tabHomes');
    });
    document.getElementById('tabPartners').addEventListener('click', function() {
        showSection('partnersSection'); setActiveTab('tabPartners'); loadPartners();
    });
    document.getElementById('tabNews').addEventListener('click', function() {
        showSection('newsSection'); setActiveTab('tabNews'); loadNews();
    });
    document.getElementById('tabTeam').addEventListener('click', function() {
        showSection('teamSection'); setActiveTab('tabTeam'); loadTeam();
    });
    document.getElementById('tabWatermark').addEventListener('click', function() {
        showSection('watermarkSection'); setActiveTab('tabWatermark'); loadWatermarkSettings();
    });
    document.getElementById('tabIp').addEventListener('click', function() {
        showSection('ipSection'); setActiveTab('tabIp'); loadIpBlacklist();
    });

    function showSection(id) {
        ['homesSection','partnersSection','newsSection','teamSection','watermarkSection','ipSection'].forEach(function(s) {
            var el = document.getElementById(s); if (el) el.style.display = s === id ? '' : 'none';
        });
    }
    function setActiveTab(id) {
        ['tabHomes','tabPartners','tabNews','tabTeam','tabWatermark','tabIp'].forEach(function(t) {
            var el = document.getElementById(t); if (el) el.classList.toggle('active', t === id);
        });
    }

    // ── Watermark configurator ────────────────────────────────────
    var WM_URL = apiBase + '/api/admin/settings/watermark';
    var wmLoaded = false, wmPreviewTimer, wmPreviewUrl = null;
    function wmCollect() {
        return {
            text:     document.getElementById('wm_text').value,
            font_pct: parseFloat(document.getElementById('wm_font').value),
            opacity:  parseFloat(document.getElementById('wm_op').value),
            gravity:  document.getElementById('wm_gravity').value,
        };
    }
    function wmSyncLabels() {
        document.getElementById('wm_font_val').textContent = parseFloat(document.getElementById('wm_font').value).toFixed(2);
        document.getElementById('wm_op_val').textContent   = parseFloat(document.getElementById('wm_op').value).toFixed(2);
    }
    function refreshWmPreview() {
        var box = document.querySelector('.wm-preview'); if (box) box.classList.add('loading');
        var body = wmCollect(); body.creator = 'Иван Петров';
        fetch(WM_URL + '/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function(r) { if (!r.ok) throw new Error(); return r.blob(); })
            .then(function(blob) {
                if (wmPreviewUrl) URL.revokeObjectURL(wmPreviewUrl);
                wmPreviewUrl = URL.createObjectURL(blob);
                document.getElementById('wmPreviewImg').src = wmPreviewUrl;
            })
            .catch(function(){})
            .then(function(){ if (box) box.classList.remove('loading'); });
    }
    function scheduleWmPreview() { clearTimeout(wmPreviewTimer); wmPreviewTimer = setTimeout(refreshWmPreview, 350); }
    function loadWatermarkSettings() {
        if (wmLoaded) return; wmLoaded = true;
        fetch(WM_URL).then(function(r){ return r.ok ? r.json() : null; }).then(function(s) {
            if (s) {
                document.getElementById('wm_text').value = s.text || '';
                document.getElementById('wm_font').value = s.font_pct;
                document.getElementById('wm_op').value = s.opacity;
                document.getElementById('wm_gravity').value = s.gravity || 'bottom-left';
            }
            wmSyncLabels();
            refreshWmPreview();
        }).catch(function(){ wmSyncLabels(); });
        // live updates
        ['wm_text','wm_font','wm_op','wm_gravity'].forEach(function(id) {
            document.getElementById(id).addEventListener('input', function(){ wmSyncLabels(); scheduleWmPreview(); });
        });
        document.getElementById('wmSaveBtn').addEventListener('click', function() {
            var btn = this, st = document.getElementById('wmStatus');
            btn.disabled = true; st.className = 'drive-status'; st.textContent = 'Запазване…';
            fetch(WM_URL, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(wmCollect()) })
                .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
                .then(function(res){
                    if (res.ok) { st.className = 'drive-status ok'; st.textContent = '✓ Запазено. Прилага се при следващите качвания и Drive импорт.'; }
                    else { st.className = 'drive-status err'; st.textContent = (res.d && res.d.error) || 'Грешка при запазване.'; }
                })
                .catch(function(){ st.className = 'drive-status err'; st.textContent = 'Грешка при свързване.'; })
                .then(function(){ btn.disabled = false; });
        });
    }

    // ── Homes ─────────────────────────────────────────────────────
    function loadHomes(page) {
        page = page || state.currentPage;
        var url = API_URL + '?all=true&page=' + page + '&limit=6';
        if (state.searchQuery) url += '&search=' + encodeURIComponent(state.searchQuery);
        fetch(url)
            .then(function(res) { if (!res.ok) throw new Error('Server error'); return res.json(); })
            .then(function(response) {
                var homes = response.data || response;
                var pagination = response.pagination || { page: 1, totalPages: Math.max(1, Math.ceil(homes.length / 6)), total: homes.length };
                state.currentHomes = homes;
                state.currentPage = pagination.page;
                state.totalPages = pagination.totalPages;
                state.totalHomes = pagination.total;
                renderList();
                updatePagination();
            })
            .catch(function(err) { console.error('Error loading homes:', err); alert('Error loading data'); });
    }

    var CATEGORY_LABELS = {
        home:     '🏠 Дом / Личност',
        monument: '🏛️ Паметно място',
        events:   '📅 Събитие'
    };
    function categoryLabel(cat) { return CATEGORY_LABELS[cat] || CATEGORY_LABELS.home; }

    function renderList() {
        var list = document.getElementById('list');
        list.innerHTML = '';
        if (state.currentHomes.length === 0) {
            list.innerHTML = '<p style="text-align:center;padding:2rem;color:#999;">No homes found.</p>';
            return;
        }
        state.currentHomes.forEach(function(p) {
            var card = document.createElement('div');
            card.className = 'thumb';
            var img = (p.images && p.images[0]) ? p.images[0].path : '';
            card.innerHTML = '<img alt="" loading="lazy" src="' + img + '" onerror="this.style.display=\'none\'">' +
                '<div class="meta"><strong>' + (p.name || '(no name)') + '</strong>' +
                '<div class="muted" style="margin-top:2px;font-size:0.8rem;color:var(--accent-strong);">' + categoryLabel(p.category || 'home') + '</div>' +
                '<div class="muted">' + (p.address || '') + '</div>' +
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">' +
                '<button data-act="edit" data-id="' + (p.slug || p.id) + '" class="theme-toggle">Edit</button>' +
                '<button data-act="toggle" data-id="' + (p.slug || p.id) + '" class="theme-toggle">' + (p.published ? 'Unpublish' : 'Publish') + '</button>' +
                '<button data-act="delete" data-id="' + (p.slug || p.id) + '" class="theme-toggle">Delete</button>' +
                '</div></div>';
            list.appendChild(card);
        });
    }

    function updatePagination() {
        var info = 'Page ' + state.currentPage + ' of ' + state.totalPages;
        if (state.totalHomes > 0) info += ' (' + state.totalHomes + ' total)';
        document.getElementById('pageInfo').textContent = info;
        document.getElementById('firstPage').disabled = state.currentPage === 1;
        document.getElementById('prevPage').disabled = state.currentPage === 1;
        document.getElementById('nextPage').disabled = state.currentPage >= state.totalPages;
        document.getElementById('lastPage').disabled = state.currentPage >= state.totalPages;
    }

    function goToPage(page) {
        if (page < 1) page = 1;
        if (page > state.totalPages) page = state.totalPages;
        state.currentPage = page;
        loadHomes(page);
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    document.getElementById('firstPage').addEventListener('click', function() { goToPage(1); });
    document.getElementById('prevPage').addEventListener('click', function() { goToPage(state.currentPage - 1); });
    document.getElementById('nextPage').addEventListener('click', function() { goToPage(state.currentPage + 1); });
    document.getElementById('lastPage').addEventListener('click', function() { goToPage(state.totalPages); });

    document.getElementById('search').addEventListener('input', function() {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(function() {
            state.searchQuery = document.getElementById('search').value;
            state.currentPage = 1;
            loadHomes(1);
        }, 500);
    });

    function openModal(title) { document.getElementById('dlgTitle').textContent = title; document.getElementById('modal').style.display = 'flex'; }
    function closeModal() { document.getElementById('modal').style.display = 'none'; }

    function syncImageField() { document.getElementById('f_imgs').value = imageSources.join('\n'); }

    function renderImageList() {
        var wrap = document.getElementById('imgPrevWrap');
        var cont = document.getElementById('imgPreview');
        cont.innerHTML = '';
        if (!imageSources.length) { wrap.style.display = 'none'; return; }
        wrap.style.display = '';
        var ph = '/assets/img/placeholder.svg';
        imageSources.forEach(function(src, idx) {
            var item = document.createElement('div');
            item.className = 'preview-item';
            var safe = src || ph;
            item.innerHTML = '<img alt="Image preview" loading="lazy" src="' + safe + '" onerror="this.onerror=null;this.src=\'' + ph + '\';">' +
                '<button type="button" data-remove="' + idx + '">×</button>';
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
            img.style.cssText = 'max-width:100px;max-height:100px;object-fit:contain;border-radius:50%;border:2px solid var(--accent)';
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() { fPortraitEl.value = ''; renderPortraitPreview(); };
            portraitPreviewEl.appendChild(img);
            portraitPreviewEl.appendChild(clearBtn);
        }
    }

    // Portrait upload - no watermark
    async function loadPortraitFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image file'); return; }
        const homeSlug = document.getElementById('f_slug').value.trim() || 'portrait';
        try {
            setUploadStatus('Uploading portrait...');
            const url = (await uploadToR2(file, homeSlug)).url;
            fPortraitEl.value = url;
            renderPortraitPreview();
            setUploadStatus('✓ Portrait uploaded');
        } catch (err) {
            alert('Portrait upload failed: ' + err.message);
            setUploadStatus('');
        }
    }

    function fillForm(p) {
        document.getElementById('f_name').value = p.name || '';
        document.getElementById('f_slug').value = p.slug || p.id || '';
        document.getElementById('f_category').value = p.category || 'home';
        fPortraitEl.value = p.portrait_url || '';
        var dStart = (p.date_start != null ? p.date_start : p.birth_date) || '';
        var dEnd   = (p.date_end   != null ? p.date_end   : p.death_date) || '';
        document.getElementById('f_birth_date').value = dStart;
        document.getElementById('f_death_date').value = dEnd;
        document.getElementById('f_date_label').value = p.date_label || '';
        document.getElementById('f_date_type').value = dEnd ? 'two' : (dStart ? 'one' : 'none');
        syncDateType();
        renderPortraitPreview();
        document.getElementById('f_bio').value = p.biography || '';
        document.getElementById('f_addr').value = p.address || '';
        document.getElementById('f_lat').value = p.coordinates && p.coordinates.lat || '';
        document.getElementById('f_lng').value = p.coordinates && p.coordinates.lng || '';
        imageSources = (p.images || []).map(function(i) { return i && i.path; }).filter(Boolean);
        // Preserve known thumbnails so editing/re-saving doesn't lose them
        imageThumbs = {};
        (p.images || []).forEach(function(i) { if (i && i.path && i.thumb) imageThumbs[i.path] = i.thumb; });
        syncImageField();
        document.getElementById('f_date').value = p.photo_date || '';
        document.getElementById('f_sources').value = (p.sources || []).join('; ');
        document.getElementById('f_tags').value = (p.tags || []).join(', ');
        // Related places: prefill this home's outgoing links and reset the search box.
        initRelatedPicker();
        relatedSelected = (p.related_edit || []).map(function(r){ return { id: r.id, name: r.name, category: r.category }; });
        renderRelChips();
        var relS = document.getElementById('f_rel_search'); if (relS) relS.value = '';
        var relR = document.getElementById('f_rel_results'); if (relR) relR.innerHTML = '';
        document.getElementById('f_published').checked = (typeof p.published === 'boolean') ? p.published : true;
        // Clear photographer field and status when opening a form
        var pEl = document.getElementById('photographerName');
        if (pEl) pEl.value = '';
        setUploadStatus('');
        renderImageList();
    }

    function slugify(text) {
        return (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }

    function readForm(existing) {
        var p = existing || {};
        p.name = document.getElementById('f_name').value.trim();
        var slugInput = document.getElementById('f_slug').value.trim();
        if (!slugInput) slugInput = slugify(p.name);
        p.slug = slugInput || p.slug || p.id || '';
        p.category = document.getElementById('f_category').value || 'home';
        p.portrait_url = fPortraitEl.value.trim() || null;
        // Flexible dates: type selects how many dates apply; label describes them.
        var dType = document.getElementById('f_date_type').value;
        var s = document.getElementById('f_birth_date').value || null;
        var e = document.getElementById('f_death_date').value || null;
        p.date_start = (dType === 'none') ? null : s;
        p.date_end   = (dType === 'two')  ? e : null;
        p.date_label = (dType === 'none') ? null : (document.getElementById('f_date_label').value.trim() || null);
        p.birth_date = p.date_start;   // legacy aliases (server also reads these)
        p.death_date = p.date_end;
        p.biography = document.getElementById('f_bio').value.trim();
        p.address = document.getElementById('f_addr').value.trim();
        var lat = document.getElementById('f_lat').value.trim();
        var lng = document.getElementById('f_lng').value.trim();
        if (lat && lng) p.coordinates = { lat: parseFloat(lat), lng: parseFloat(lng) };
        var txtSources = document.getElementById('f_imgs').value.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
        imageSources = txtSources.slice();
        p.images = imageSources.length
            ? imageSources.map(function(src) {
                var img = { path: src, caption: '', alt: 'Facade of ' + (p.name || '') };
                if (imageThumbs[src]) img.thumb = imageThumbs[src];
                return img;
            })
            : [];
        p.photo_date = document.getElementById('f_date').value.trim();
        var sources = document.getElementById('f_sources').value.trim();
        p.sources = sources ? sources.split(';').map(function(s) { return s.trim(); }).filter(Boolean) : [];
        var tags = document.getElementById('f_tags').value.trim();
        p.tags = tags ? tags.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];
        if (!p.id) p.id = p.slug || slugify(p.name);
        var now = new Date().toISOString();
        if (!p.created_at) p.created_at = now;
        p.updated_at = now;
        p.published = !!document.getElementById('f_published').checked;
        p.related_ids = relatedSelected.map(function(r){ return r.id; });   // self-ref M2M links
        return p;
    }

    function addNew() {
        document.getElementById('f_id').value = '';
        fillForm({ published: true });
        openModal('Add Home');
    }

    function editHome(id) {
        fetch(API_URL + '/' + id)
            .then(function(res) { return res.json(); })
            .then(function(home) {
                document.getElementById('f_id').value = home.id || home.slug;
                fillForm(home);
                openModal('Edit Home');
            })
            .catch(function(err) { console.error('Error loading home:', err); alert('Error loading home'); });
    }

    document.getElementById('addBtn').addEventListener('click', addNew);
    document.getElementById('cancelDlg').addEventListener('click', closeModal);
    document.getElementById('closeDlg').addEventListener('click', closeModal);

    // ── Flexible dates: show/hide inputs by type, label preset chips ──
    function syncDateType() {
        var t = document.getElementById('f_date_type').value;
        document.getElementById('f_date_label_wrap').style.display = (t === 'none') ? 'none' : '';
        document.getElementById('f_date_start_wrap').style.display = (t === 'none') ? 'none' : '';
        document.getElementById('f_date_end_wrap').style.display   = (t === 'two')  ? '' : 'none';
        document.getElementById('f_date_start_lbl').textContent    = (t === 'two')  ? 'Начална дата' : 'Дата';
    }
    document.getElementById('f_date_type').addEventListener('change', syncDateType);
    document.getElementById('datePresets').addEventListener('click', function(e) {
        var b = e.target.closest('button[data-dl]'); if (!b) return;
        document.getElementById('f_date_label').value = b.getAttribute('data-dl');
    });

    // Gallery images upload - watermark applied
    async function loadImageFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        const homeSlug = document.getElementById('f_slug').value.trim() || 'img';
        const photographer = getPhotographer();
        try {
            setUploadStatus('Uploading...');
            const data = await uploadToR2(file, homeSlug, getWatermark(), photographer);   // gallery → watermark per toggle
            imageSources.push(data.url);
            if (data.thumb) imageThumbs[data.url] = data.thumb;
            syncImageField();
            renderImageList();
            setUploadStatus('✓ ' + imageSources.length + ' image(s) ready');
        } catch (err) {
            alert('Upload failed: ' + err.message);
            setUploadStatus('');
        }
    }

    document.getElementById('imgDrop').addEventListener('dragover', function(e) { e.preventDefault(); });
    document.getElementById('imgDrop').addEventListener('drop', function(e) {
        e.preventDefault();
        var files = Array.from(e.dataTransfer.files || []);
        files.forEach(loadImageFile);
    });
    document.getElementById('imgPick').addEventListener('click', function() { document.getElementById('imgFile').click(); });
    document.getElementById('imgFile').addEventListener('change', function(e) {
        var files = Array.from(e.target.files || []);
        files.forEach(loadImageFile);
        e.target.value = '';
    });
    document.getElementById('imgPreview').addEventListener('click', function(e) {
        var btn = e.target.closest && e.target.closest('button[data-remove]');
        if (!btn) return;
        var idx = parseInt(btn.getAttribute('data-remove'), 10);
        imageSources.splice(idx, 1);
        syncImageField();
        renderImageList();
    });
    document.getElementById('f_imgs').addEventListener('input', function() {
        imageSources = this.value.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
        renderImageList();
    });

    // ── Google Drive folder import → adds processed R2 images to the gallery ──
    function driveStatus(msg, cls) {
        var el = document.getElementById('driveStatus');
        if (el) { el.textContent = msg || ''; el.className = 'drive-status' + (cls ? ' ' + cls : ''); }
    }
    document.getElementById('driveSyncBtn').addEventListener('click', function() {
        var btn = this;
        var url = (document.getElementById('driveUrl').value || '').trim();
        if (!url) { driveStatus('Поставете линк към Google Drive папка.', 'err'); return; }
        btn.disabled = true;
        driveStatus('Импортиране… това може да отнеме минута за по-големи папки.');
        fetch('/api/admin/drive-sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folderUrl: url, watermark: getWatermark(), photographer: getPhotographer() })
        })
        .then(function(res) { return res.json().catch(function() { return {}; }).then(function(d) { return { ok: res.ok, d: d }; }); })
        .then(function(r) {
            btn.disabled = false;
            if (!r.ok) { driveStatus(r.d.error || 'Грешка при импорт.', 'err'); return; }
            (r.d.urls || []).forEach(function(it) {
                if (it && it.url) { imageSources.push(it.url); if (it.thumb) imageThumbs[it.url] = it.thumb; }
            });
            syncImageField(); renderImageList();
            var msg = '✓ Добавени ' + (r.d.count || 0) + ' от ' + (r.d.total || 0) + ' снимки.';
            if (r.d.capped) msg += ' (Папката е голяма - импортирани са първите ' + (r.d.count || 0) + '. Стартирайте отново за още.)';
            if (r.d.errors && r.d.errors.length) msg += ' Пропуснати: ' + r.d.errors.length + '.';
            driveStatus(msg, 'ok');
        })
        .catch(function() { btn.disabled = false; driveStatus('Грешка при свързване.', 'err'); });
    });

    document.getElementById('portraitDrop').addEventListener('dragover', function(e) { e.preventDefault(); });
    document.getElementById('portraitDrop').addEventListener('drop', function(e) {
        e.preventDefault();
        var file = (e.dataTransfer.files && e.dataTransfer.files[0]) || null;
        if (file) loadPortraitFile(file);
    });
    document.getElementById('portraitPick').addEventListener('click', function() { document.getElementById('portraitFile').click(); });
    document.getElementById('portraitFile').addEventListener('change', function(e) {
        var file = (e.target.files && e.target.files[0]) || null;
        if (file) loadPortraitFile(file);
        e.target.value = '';
    });
    fPortraitEl.addEventListener('input', renderPortraitPreview);

    document.getElementById('objForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var homeId = document.getElementById('f_id').value;
        var homeData = readForm({});
        if (!homeId) {
            fetch(API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(homeData)
            })
            .then(function(res) { return res.json(); })
            .then(function() { closeModal(); loadHomes(1); alert('Home created!'); })
            .catch(function(err) { console.error(err); alert('Error creating home'); });
        } else {
            fetch(API_URL + '/' + homeId)
                .then(function(res) { return res.json(); })
                .then(function(existing) {
                    var updated = readForm(existing);
                    return fetch(API_URL + '/' + homeId, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(updated)
                    });
                })
                .then(function(res) { return res.json(); })
                .then(function() { closeModal(); loadHomes(state.currentPage); alert('Home updated!'); })
                .catch(function(err) { console.error(err); alert('Error updating home'); });
        }
    });

    // ── Partners ──────────────────────────────────────────────────
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
            .catch(function(err) { console.error('Error loading partners:', err); alert('Error loading partners'); });
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
            var logo = p.logo_url || '/assets/img/placeholder.svg';
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

    function openPartnerModal(title) { document.getElementById('partnerDlgTitle').textContent = title; document.getElementById('partnerModal').style.display = 'flex'; }
    function closePartnerModal() { document.getElementById('partnerModal').style.display = 'none'; }

    function renderLogoPreview() {
        var preview = document.getElementById('logoPreview');
        var url = document.getElementById('p_logo').value.trim();
        preview.innerHTML = '';
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Logo Preview';
            img.style.cssText = 'max-width:150px;max-height:150px;object-fit:contain;background:#fff;padding:10px;border-radius:8px;';
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() { document.getElementById('p_logo').value = ''; renderLogoPreview(); };
            preview.appendChild(img);
            preview.appendChild(clearBtn);
        }
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

    // Logo upload - no watermark
    async function loadLogoFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        try {
            const url = (await uploadToR2(file, 'logo')).url;
            document.getElementById('p_logo').value = url;
            renderLogoPreview();
        } catch (err) {
            alert('Logo upload failed: ' + err.message);
        }
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
    document.getElementById('logoPick').addEventListener('click', function() { document.getElementById('logoFile').click(); });
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
        var method = partnerId ? 'PUT' : 'POST';
        var url = partnerId ? PARTNERS_API + '/' + partnerId : PARTNERS_API;
        fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(partnerData) })
            .then(function(res) { return res.json(); })
            .then(function() { closePartnerModal(); loadPartners(); alert(partnerId ? 'Partner updated!' : 'Partner created!'); })
            .catch(function(err) { console.error(err); alert('Error saving partner'); });
    });

    // ── News ──────────────────────────────────────────────────────
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
                            (n.excerpt && n.excerpt.toLowerCase().includes(search));
                    });
                }
                renderNews(news);
            })
            .catch(function(err) { console.error('Error loading news:', err); alert('Error loading news'); });
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
            var cover = n.cover_image || '/assets/img/placeholder.svg';
            var statusColor = n.is_published ? '#28a745' : '#ffc107';
            card.innerHTML = '<img alt="' + n.title + '" loading="lazy" src="' + cover + '" style="object-fit:cover;height:180px;">' +
                '<div class="meta"><strong>' + n.title + '</strong>' +
                '<div class="muted" style="margin-top:4px;font-size:0.85rem;">📅 ' + n.published_date + '</div>' +
                '<div style="margin-top:4px;font-size:0.85rem;color:' + statusColor + ';">● ' + (n.is_published ? 'Published' : 'Draft') + '</div>' +
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

    function openNewsModal(title) { document.getElementById('newsDlgTitle').textContent = title; document.getElementById('newsModal').style.display = 'flex'; }
    function closeNewsModal() { document.getElementById('newsModal').style.display = 'none'; }

    function renderNewsCoverPreview() {
        var preview = document.getElementById('newsCoverPreview');
        var url = document.getElementById('n_cover').value.trim();
        preview.innerHTML = '';
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Cover Preview';
            img.style.cssText = 'max-width:200px;max-height:150px;object-fit:cover;border-radius:8px;';
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() { document.getElementById('n_cover').value = ''; renderNewsCoverPreview(); };
            preview.appendChild(img);
            preview.appendChild(clearBtn);
        }
    }

    function fillNewsForm(n) {
        document.getElementById('n_title').value = n.title || '';
        document.getElementById('n_slug').value = n.slug || '';
        document.getElementById('n_excerpt').value = n.excerpt || '';
        document.getElementById('n_content').value = n.content || '';
        document.getElementById('n_cover').value = n.cover_image || '';
        document.getElementById('n_link').value = n.link || '';
        document.getElementById('n_date').value = n.published_date || new Date().toISOString().split('T')[0];
        document.getElementById('n_author').value = n.author || 'Екипът на Адресът на историята';
        document.getElementById('n_published').checked = n.is_published !== 0;
        renderNewsCoverPreview();
    }

    // News cover upload - watermark applied
    async function loadNewsCoverFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        try {
            const url = (await uploadToR2(file, 'news', true)).url;   // news cover → site watermark
            document.getElementById('n_cover').value = url;
            renderNewsCoverPreview();
        } catch (err) {
            alert('Cover upload failed: ' + err.message);
        }
    }

    document.getElementById('addNewsBtn').addEventListener('click', function() {
        document.getElementById('n_id').value = '';
        fillNewsForm({ is_published: 1, published_date: new Date().toISOString().split('T')[0], author: 'Екипът на Адресът на историята' });
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
    document.getElementById('newsCoverPick').addEventListener('click', function() { document.getElementById('newsCoverFile').click(); });
    document.getElementById('newsCoverFile').addEventListener('change', function(e) {
        var file = (e.target.files && e.target.files[0]) || null;
        if (file) loadNewsCoverFile(file);
        e.target.value = '';
    });
    document.getElementById('n_title').addEventListener('input', function() {
        var slugField = document.getElementById('n_slug');
        if (!slugField.value) slugField.value = slugify(this.value);
    });

    document.getElementById('newsForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var newsId = document.getElementById('n_id').value;
        var title = document.getElementById('n_title').value.trim();
        var slug = document.getElementById('n_slug').value.trim() || slugify(title);
        document.getElementById('n_slug').value = slug;
        var newsData = {
            title: title, slug: slug,
            excerpt: document.getElementById('n_excerpt').value.trim() || '',
            content: document.getElementById('n_content').value.trim(),
            cover_image: document.getElementById('n_cover').value.trim() || '',
            link: document.getElementById('n_link').value.trim() || '',
            published_date: document.getElementById('n_date').value,
            author: document.getElementById('n_author').value.trim(),
            is_published: document.getElementById('n_published').checked ? 1 : 0
        };
        if (!newsData.title || !newsData.slug || !newsData.content) { alert('Title, slug, and content are required'); return; }
        var method = newsId ? 'PUT' : 'POST';
        var url = newsId ? NEWS_API + '/' + newsId : NEWS_API;
        fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newsData) })
            .then(function(res) { return res.json(); })
            .then(function() { closeNewsModal(); loadNews(); alert(newsId ? 'Article updated!' : 'Article created!'); })
            .catch(function(err) { console.error(err); alert('Error saving article: ' + (err.message || '')); });
    });

    // ── Team ──────────────────────────────────────────────────────
    function loadTeam() {
        var search = (document.getElementById('teamSearch').value || '').toLowerCase();
        fetch(TEAM_API + '?all=true')
            .then(function(res) { return res.json(); })
            .then(function(team) {
                currentTeam = team;
                if (search) {
                    team = team.filter(function(t) {
                        return t.name.toLowerCase().includes(search) ||
                            (t.role && t.role.toLowerCase().includes(search));
                    });
                }
                renderTeam(team);
            })
            .catch(function(err) { console.error('Error loading team:', err); alert('Error loading team'); });
    }

    function renderTeam(team) {
        var list = document.getElementById('teamList');
        list.innerHTML = '';
        if (team.length === 0) {
            list.innerHTML = '<p style="text-align:center;padding:2rem;color:#999;">No team members found.</p>';
            return;
        }
        team.forEach(function(t) {
            var card = document.createElement('div');
            card.className = 'thumb';
            var photo = t.photo || '/assets/img/placeholder.svg';
            var statusColor = t.is_published ? '#28a745' : '#6c757d';
            card.innerHTML = '<img alt="' + t.name + '" loading="lazy" src="' + photo + '" style="object-fit:cover;height:180px;border-radius:50%;width:180px;margin:0 auto;display:block;">' +
                '<div class="meta" style="text-align:center;"><strong>' + t.name + '</strong>' +
                '<div class="muted" style="margin-top:4px;font-size:0.9rem;color:var(--accent-strong);">' + (t.role || 'Member') + '</div>' +
                '<div style="margin-top:4px;font-size:0.85rem;color:' + statusColor + ';">● ' + (t.is_published ? 'Published' : 'Hidden') + '</div>' +
                '<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">' +
                '<button data-act="editTeam" data-id="' + t.id + '" class="theme-toggle">Edit</button>' +
                '<button data-act="toggleTeam" data-id="' + t.id + '" class="theme-toggle">' + (t.is_published ? 'Hide' : 'Publish') + '</button>' +
                '<button data-act="deleteTeam" data-id="' + t.id + '" class="theme-toggle">Delete</button>' +
                '</div></div>';
            list.appendChild(card);
        });
    }

    var teamSearchTimeout;
    document.getElementById('teamSearch').addEventListener('input', function() {
        clearTimeout(teamSearchTimeout);
        teamSearchTimeout = setTimeout(loadTeam, 300);
    });

    function openTeamModal(title) { document.getElementById('teamDlgTitle').textContent = title; document.getElementById('teamModal').style.display = 'flex'; }
    function closeTeamModal() { document.getElementById('teamModal').style.display = 'none'; }

    function renderTeamPhotoPreview() {
        var preview = document.getElementById('teamPhotoPreview');
        var url = document.getElementById('t_photo').value.trim();
        preview.innerHTML = '';
        if (url) {
            var img = document.createElement('img');
            img.src = url;
            img.alt = 'Photo Preview';
            img.style.cssText = 'max-width:120px;max-height:120px;object-fit:cover;border-radius:50%;border:3px solid var(--accent-strong);';
            var clearBtn = document.createElement('button');
            clearBtn.textContent = '× Clear';
            clearBtn.className = 'theme-toggle';
            clearBtn.style.marginLeft = '10px';
            clearBtn.onclick = function() { document.getElementById('t_photo').value = ''; renderTeamPhotoPreview(); };
            preview.appendChild(img);
            preview.appendChild(clearBtn);
        }
    }

    function fillTeamForm(t) {
        document.getElementById('t_name').value = t.name || '';
        document.getElementById('t_role').value = t.role || '';
        document.getElementById('t_bio').value = t.bio || '';
        document.getElementById('t_photo').value = t.photo || '';
        document.getElementById('t_order').value = t.display_order || 0;
        document.getElementById('t_published').checked = t.is_published !== 0;
        renderTeamPhotoPreview();
    }

    // Team photo upload - no watermark
    async function loadTeamPhotoFile(file) {
        if (!file) return;
        if (!/^image\//.test(file.type)) { alert('Please select an image'); return; }
        try {
            const url = (await uploadToR2(file, 'team')).url;
            document.getElementById('t_photo').value = url;
            renderTeamPhotoPreview();
        } catch (err) {
            alert('Photo upload failed: ' + err.message);
        }
    }

    document.getElementById('addTeamBtn').addEventListener('click', function() {
        document.getElementById('t_id').value = '';
        fillTeamForm({ is_published: 1, display_order: 0 });
        openTeamModal('Add Team Member');
    });
    document.getElementById('closeTeamDlg').addEventListener('click', closeTeamModal);
    document.getElementById('cancelTeamDlg').addEventListener('click', closeTeamModal);
    document.getElementById('t_photo').addEventListener('input', renderTeamPhotoPreview);
    document.getElementById('teamPhotoDrop').addEventListener('dragover', function(e) { e.preventDefault(); });
    document.getElementById('teamPhotoDrop').addEventListener('drop', function(e) {
        e.preventDefault();
        var file = (e.dataTransfer.files && e.dataTransfer.files[0]) || null;
        if (file) loadTeamPhotoFile(file);
    });
    document.getElementById('teamPhotoPick').addEventListener('click', function() { document.getElementById('teamPhotoFile').click(); });
    document.getElementById('teamPhotoFile').addEventListener('change', function(e) {
        var file = (e.target.files && e.target.files[0]) || null;
        if (file) loadTeamPhotoFile(file);
        e.target.value = '';
    });

    document.getElementById('teamForm').addEventListener('submit', function(e) {
        e.preventDefault();
        var teamId = document.getElementById('t_id').value;
        var teamData = {
            name: document.getElementById('t_name').value.trim(),
            role: document.getElementById('t_role').value.trim() || '',
            bio: document.getElementById('t_bio').value.trim() || '',
            photo: document.getElementById('t_photo').value.trim() || '',
            display_order: parseInt(document.getElementById('t_order').value) || 0,
            is_published: document.getElementById('t_published').checked ? 1 : 0
        };
        if (!teamData.name) { alert('Name is required'); return; }
        var method = teamId ? 'PUT' : 'POST';
        var url = teamId ? TEAM_API + '/' + teamId : TEAM_API;
        fetch(url, { method: method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(teamData) })
            .then(function(res) { return res.json(); })
            .then(function() { closeTeamModal(); loadTeam(); alert(teamId ? 'Team member updated!' : 'Team member added!'); })
            .catch(function(err) { console.error(err); alert('Error saving team member'); });
    });

    // ── Unified click handler ─────────────────────────────────────
    document.addEventListener('click', function(e) {
        var act = e.target && e.target.getAttribute('data-act');
        if (!act) return;
        var id = e.target.getAttribute('data-id');
        if (!id) return;

        if (act === 'edit') { editHome(id); }
        if (act === 'toggle') {
            fetch(API_URL + '/' + id).then(function(r) { return r.json(); }).then(function(home) {
                home.published = !home.published;
                return fetch(API_URL + '/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(home) });
            }).then(function() { loadHomes(state.currentPage); }).catch(function(err) { console.error(err); alert('Error updating'); });
        }
        if (act === 'delete') {
            if (confirm('Delete this home?')) {
                fetch(API_URL + '/' + id, { method: 'DELETE' }).then(function() { loadHomes(state.currentPage); }).catch(function(err) { console.error(err); alert('Error deleting'); });
            }
        }
        if (act === 'editPartner') {
            fetch(PARTNERS_API + '/' + id).then(function(r) { return r.json(); }).then(function(partner) {
                document.getElementById('p_id').value = partner.id;
                fillPartnerForm(partner);
                openPartnerModal('Edit Partner');
            }).catch(function(err) { console.error(err); alert('Error loading partner'); });
        }
        if (act === 'togglePartner') {
            fetch(PARTNERS_API + '/' + id).then(function(r) { return r.json(); }).then(function(p) {
                p.published = !p.published;
                return fetch(PARTNERS_API + '/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
            }).then(function() { loadPartners(); }).catch(function(err) { console.error(err); alert('Error updating partner'); });
        }
        if (act === 'deletePartner') {
            if (confirm('Delete this partner?')) {
                fetch(PARTNERS_API + '/' + id, { method: 'DELETE' }).then(function() { loadPartners(); }).catch(function(err) { console.error(err); alert('Error deleting partner'); });
            }
        }
        if (act === 'editNews') {
            fetch(NEWS_API + '?all=true&limit=1000').then(function(r) { return r.json(); }).then(function(response) {
                var article = (response.data || []).find(function(n) { return n.id == id; });
                if (!article) throw new Error('Article not found');
                document.getElementById('n_id').value = article.id;
                fillNewsForm(article);
                openNewsModal('Edit News Article');
            }).catch(function(err) { console.error(err); alert('Error loading article'); });
        }
        if (act === 'toggleNews') {
            fetch(NEWS_API + '?all=true&limit=1000').then(function(r) { return r.json(); }).then(function(response) {
                var article = (response.data || []).find(function(n) { return n.id == id; });
                if (!article) throw new Error('Article not found');
                article.is_published = article.is_published ? 0 : 1;
                return fetch(NEWS_API + '/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(article) });
            }).then(function() { loadNews(); }).catch(function(err) { console.error(err); alert('Error updating article'); });
        }
        if (act === 'deleteNews') {
            if (confirm('Delete this article?')) {
                fetch(NEWS_API + '/' + id, { method: 'DELETE' }).then(function() { loadNews(); }).catch(function(err) { console.error(err); alert('Error deleting article'); });
            }
        }
        if (act === 'editTeam') {
            fetch(TEAM_API + '/' + id).then(function(r) { return r.json(); }).then(function(member) {
                document.getElementById('t_id').value = member.id;
                fillTeamForm(member);
                openTeamModal('Edit Team Member');
            }).catch(function(err) { console.error(err); alert('Error loading team member'); });
        }
        if (act === 'toggleTeam') {
            fetch(TEAM_API + '/' + id).then(function(r) { return r.json(); }).then(function(member) {
                member.is_published = member.is_published ? 0 : 1;
                return fetch(TEAM_API + '/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(member) });
            }).then(function() { loadTeam(); }).catch(function(err) { console.error(err); alert('Error updating team member'); });
        }
        if (act === 'deleteTeam') {
            if (confirm('Delete this team member?')) {
                fetch(TEAM_API + '/' + id, { method: 'DELETE' }).then(function() { loadTeam(); }).catch(function(err) { console.error(err); alert('Error deleting team member'); });
            }
        }
    });

    // ── IP blacklist (owner only) ─────────────────────────────────
    var IP_API = apiBase + '/api/admin/ip-blacklist';
    function ipStatus(msg, cls) {
        var el = document.getElementById('ipStatus');
        if (el) { el.textContent = msg || ''; el.className = 'drive-status' + (cls ? ' ' + cls : ''); }
    }
    function loadIpBlacklist() {
        var list = document.getElementById('ipList');
        if (!list) return;
        list.innerHTML = '<p style="color:#999;padding:1rem">Зареждане…</p>';
        fetch(IP_API).then(function(r){ if (!r.ok) throw new Error(); return r.json(); })
            .then(renderIpList)
            .catch(function(){ list.innerHTML = '<p style="color:#c66;padding:1rem">Грешка при зареждане.</p>'; });
    }
    function renderIpList(rows) {
        var list = document.getElementById('ipList');
        list.innerHTML = '';
        if (!rows.length) { list.innerHTML = '<p style="color:#999;padding:1rem">Няма блокирани IP адреси.</p>'; return; }
        rows.forEach(function(r) {
            var row = document.createElement('div'); row.className = 'ip-row';
            var info = document.createElement('div'); info.className = 'ip-info';
            var ip = document.createElement('div'); ip.className = 'ip-addr'; ip.textContent = r.ip;
            var meta = document.createElement('div'); meta.className = 'ip-meta';
            meta.textContent = (r.reason ? r.reason + ' · ' : '') + 'от ' + (r.created_by || '—') + ' · ' + String(r.created_at || '').slice(0, 10);
            info.appendChild(ip); info.appendChild(meta);
            var del = document.createElement('button'); del.className = 'theme-toggle'; del.textContent = '× Премахни';
            del.addEventListener('click', function() {
                if (!confirm('Да премахна блокирането на ' + r.ip + '?')) return;
                fetch(IP_API + '/' + encodeURIComponent(r.ip), { method: 'DELETE' })
                    .then(function(res){ if (!res.ok) throw new Error(); loadIpBlacklist(); })
                    .catch(function(){ alert('Грешка при премахване.'); });
            });
            row.appendChild(info); row.appendChild(del);
            list.appendChild(row);
        });
    }
    var ipForm = document.getElementById('ipForm');
    if (ipForm) ipForm.addEventListener('submit', function(e) {
        e.preventDefault();
        var ip = document.getElementById('ip_addr').value.trim();
        var reason = document.getElementById('ip_reason').value.trim();
        if (!ip) { ipStatus('Въведете IP адрес.', 'err'); return; }
        ipStatus('Добавяне…');
        fetch(IP_API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ip: ip, reason: reason }) })
            .then(function(res){ return res.json().catch(function(){ return {}; }).then(function(d){ return { ok: res.ok, d: d }; }); })
            .then(function(r){
                if (!r.ok) { ipStatus((r.d && r.d.error) || 'Грешка при добавяне.', 'err'); return; }
                document.getElementById('ip_addr').value = ''; document.getElementById('ip_reason').value = '';
                ipStatus('✓ IP адресът е блокиран.', 'ok'); loadIpBlacklist();
            })
            .catch(function(){ ipStatus('Грешка при свързване.', 'err'); });
    });

    document.getElementById('year').textContent = new Date().getFullYear();

})();