(() => {
  const tbody = document.getElementById('tbody');
  const empty = document.getElementById('empty');
  const searchInput = document.getElementById('search');
  const statusText = document.getElementById('status-text');
  const btnRefresh = document.getElementById('btn-refresh');
  const groupSelect = document.getElementById('group-select');
  const modal = document.getElementById('modal');
  const modalHostname = document.getElementById('modal-hostname');
  const editUsername = document.getElementById('edit-username');
  const editSite = document.getElementById('edit-site');
  const modalClose = document.getElementById('modal-close');
  const modalCancel = document.getElementById('modal-cancel');
  const modalSave = document.getElementById('modal-save');

  let devices = [];
  let groupList = [];
  let groupCounts = {};
  let filter = 'all';       // all | domain | pos
  let groupFilter = '';    // site name or ''
  let sortKey = 'last_seen';
  let sortDir = 'desc';
  let search = '';
  let editingId = null;

  // ---- Helpers ----
  function formatTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const now = new Date();
    const diff = (now - d) / 1000;
    if (diff < 60) return 'Just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleString(undefined, {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    });
  }

  function statusClass(iso) {
    if (!iso) return 'status-offline';
    const diff = (Date.now() - new Date(iso)) / 1000;
    if (diff < 180) return 'status-online';
    if (diff < 900) return 'status-stale';
    return 'status-offline';
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ---- Group drop-down ----
  function renderGroupSelect() {
    // Include sites that exist on devices but aren't in the standard list
    const extras = [...new Set(devices.map(d => d.site).filter(Boolean))]
      .filter(s => !groupList.includes(s));
    const names = [...groupList, ...extras];

    // A selected group that no longer exists falls back to "All groups"
    if (groupFilter && !names.includes(groupFilter)) groupFilter = '';

    groupSelect.innerHTML = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All groups';
    groupSelect.appendChild(all);
    for (const name of names) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      groupSelect.appendChild(opt);
    }
    groupSelect.value = groupFilter;
  }

  // ---- Table ----
  function getFiltered() {
    let list = devices;

    if (filter === 'domain' || filter === 'pos') {
      list = list.filter(d => d.type === filter);
    }
    if (groupFilter) {
      list = list.filter(d => d.site === groupFilter);
    }

    if (search) {
      const q = search.toLowerCase();
      list = list.filter(d =>
        (d.hostname || '').toLowerCase().includes(q) ||
        (d.ip || '').toLowerCase().includes(q) ||
        (d.mac || '').toLowerCase().includes(q) ||
        (d.username || '').toLowerCase().includes(q) ||
        (d.site || '').toLowerCase().includes(q)
      );
    }

    list = [...list].sort((a, b) => {
      let va = a[sortKey] ?? '';
      let vb = b[sortKey] ?? '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }

  function render() {
    const list = getFiltered();

    document.getElementById('badge-all').textContent = devices.length;
    document.getElementById('badge-domain').textContent =
      devices.filter(d => d.type === 'domain').length;
    document.getElementById('badge-pos').textContent =
      devices.filter(d => d.type === 'pos').length;

    renderGroupSelect();

    document.querySelectorAll('th[data-sort]').forEach(th => {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.sort === sortKey) {
        th.classList.add(sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
      }
    });

    if (list.length === 0) {
      tbody.innerHTML = '';
      empty.hidden = false;
      return;
    }

    empty.hidden = true;
    tbody.innerHTML = list.map(d => `
      <tr data-id="${d.id}">
        <td>
          <span class="status-dot ${statusClass(d.last_seen)}" title="${statusClass(d.last_seen).replace('status-','')}"></span>
          <span class="hostname">${escapeHtml(d.hostname)}</span>
        </td>
        <td class="mono">${escapeHtml(d.ip || '—')}</td>
        <td>${escapeHtml(d.username || '—')}</td>
        <td>${d.site ? `<span class="site-pill">${escapeHtml(d.site)}</span>` : '—'}</td>
        <td class="mono">${escapeHtml(d.mac || '—')}</td>
        <td><span class="type-pill type-${d.type}">${d.type}</span></td>
        <td title="${escapeHtml(d.last_seen || '')}">${formatTime(d.last_seen)}</td>
        <td class="col-actions">
          <button class="btn-icon" data-edit="${d.id}" title="Edit user / site">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>
            </svg>
          </button>
          <button class="btn-icon danger" data-delete="${d.id}" title="Remove device">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 6h18M8 6V4h8v2M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/>
            </svg>
          </button>
        </td>
      </tr>
    `).join('');
  }

  // ---- Data ----
  async function loadDevices() {
    try {
      statusText.textContent = 'Loading…';
      const [devRes, statsRes] = await Promise.all([
        fetch('/api/devices'),
        fetch('/api/stats')
      ]);
      const data = await devRes.json();
      const stats = await statsRes.json();

      if (!data.ok) throw new Error(data.error || 'Failed to load');

      devices = data.devices || [];
      if (stats.ok) {
        groupList = stats.groupList || [];
        groupCounts = stats.groups || {};
      }
      populateSiteSelect();
      render();
      statusText.textContent = `Updated ${new Date().toLocaleTimeString()} · ${devices.length} device${devices.length !== 1 ? 's' : ''}`;
    } catch (err) {
      statusText.textContent = 'Error: ' + err.message;
      console.error(err);
    }
  }

  function populateSiteSelect() {
    const current = editSite.value;
    editSite.innerHTML = '<option value="">— None —</option>';
    for (const name of groupList) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      editSite.appendChild(opt);
    }
    // Allow free-text sites that already exist in data but not in canonical list
    const extras = [...new Set(devices.map(d => d.site).filter(Boolean))]
      .filter(s => !groupList.includes(s));
    for (const name of extras) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name + ' (custom)';
      editSite.appendChild(opt);
    }
    if (current) editSite.value = current;
  }

  async function deleteDevice(id) {
    if (!confirm('Remove this device from the dashboard?')) return;
    try {
      const res = await fetch(`/api/devices/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);
      devices = devices.filter(d => d.id !== id);
      render();
    } catch (err) {
      alert('Delete failed: ' + err.message);
    }
  }

  function openEdit(id) {
    const d = devices.find(x => x.id === id);
    if (!d) return;
    editingId = id;
    modalHostname.textContent = d.hostname;
    editUsername.value = d.username || '';
    populateSiteSelect();
    editSite.value = d.site || '';
    modal.hidden = false;
    editUsername.focus();
  }

  function closeModal() {
    modal.hidden = true;
    editingId = null;
  }

  async function saveEdit() {
    if (editingId == null) return;
    try {
      const res = await fetch(`/api/devices/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: editUsername.value.trim() || null,
          site: editSite.value || null
        })
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      // Update local copy
      const idx = devices.findIndex(d => d.id === editingId);
      if (idx >= 0) devices[idx] = data.device;
      closeModal();
      render();
    } catch (err) {
      alert('Save failed: ' + err.message);
    }
  }

  // ---- Events ----
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      filter = tab.dataset.filter;
      render();
    });
  });

  groupSelect.addEventListener('change', () => {
    groupFilter = groupSelect.value;
    render();
  });

  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = key === 'last_seen' ? 'desc' : 'asc';
      }
      render();
    });
  });

  searchInput.addEventListener('input', () => {
    search = searchInput.value.trim();
    render();
  });

  btnRefresh.addEventListener('click', () => loadDevices());

  tbody.addEventListener('click', e => {
    const editBtn = e.target.closest('[data-edit]');
    if (editBtn) {
      openEdit(parseInt(editBtn.dataset.edit, 10));
      return;
    }
    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) deleteDevice(parseInt(delBtn.dataset.delete, 10));
  });

  modalClose.addEventListener('click', closeModal);
  modalCancel.addEventListener('click', closeModal);
  modalSave.addEventListener('click', saveEdit);
  modal.addEventListener('click', e => {
    if (e.target === modal) closeModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !modal.hidden) closeModal();
  });

  // ---- Init ----
  loadDevices();
  setInterval(loadDevices, 15000);
})();
