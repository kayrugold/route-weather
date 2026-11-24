(() => {
  const MANIFEST_URL_KEY = 'route-weather-offline-manifest-url';
  const DEFAULT_MANIFEST_URL = 'https://maps.routeweather.pages.dev/offline-maps/manifest.json';

  let catalog = null;
  const activeProgress = new Map();

  function el(id) {
    return document.getElementById(id);
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
    if (bytes >= 1024 ** 3) return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
    return (bytes / (1024 ** 2)).toFixed(1) + ' MB';
  }

  function escHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function getManifestUrl() {
    try {
      return localStorage.getItem(MANIFEST_URL_KEY) || DEFAULT_MANIFEST_URL;
    } catch {
      return DEFAULT_MANIFEST_URL;
    }
  }

  function renderDialog() {
    const offline = window.routeWeatherOffline;
    const summaryEl = el('offlineSummary');
    const modeSel = el('offlineModeSelect');
    const profileSel = el('offlineProfileSelect');
    const truckWarn = el('offlineTruckWarning');
    const installedEl = el('offlineInstalledList');
    const catalogEl = el('offlineCatalogList');
    if (!offline || !summaryEl) return;

    const st = offline.getStatus();
    const mode = offline.getMode();
    const profile = offline.getProfile();

    if (modeSel) modeSel.value = mode;
    if (profileSel) profileSel.value = profile;
    if (truckWarn) truckWarn.hidden = profile !== 'truck';

    if (!st.available) {
      summaryEl.innerHTML = 'Offline engine runs inside the <strong>Route Weather Android app</strong>. Browser mode uses online services.';
    } else {
      const readyParts = [
        st.hasTiles ? 'Maps ready' : 'No maps',
        st.hasRouting ? 'Routing ready' : 'No routing',
        st.hasSearch ? 'Search ready' : 'No search',
      ];
      summaryEl.innerHTML =
        `<strong>${readyParts.join(' · ')}</strong><br>` +
        `Installed: <strong>${formatBytes(st.installedBytes)}</strong> · ` +
        `Free storage: <strong>${formatBytes(st.availableBytes)}</strong>` +
        (st.tileCount || st.routingCount || st.searchCount
          ? ` (${st.tileCount} map, ${st.routingCount} route, ${st.searchCount} search files)`
          : '');
    }

    if (installedEl) {
      const pkgs = Array.isArray(st.packages) ? st.packages : [];
      if (!pkgs.length) {
        installedEl.innerHTML = st.hasTiles || st.hasRouting || st.hasSearch
          ? '<p class="help">Sideloaded offline map files detected on device storage and ready to use.</p>'
          : '<p class="help">No downloadable packages installed yet. Download a region below or sideload the Northern California test package via USB.</p>';
      } else {
        installedEl.innerHTML = pkgs.map(pkg => `
          <div class="offline-pkg-row">
            <div>
              <strong>${escHtml(pkg.name || pkg.id)}</strong><br>
              <small>v${escHtml(pkg.version || '1')} · ${formatBytes(pkg.installedBytes || 0)}</small>
            </div>
            <button type="button" data-offline-delete="${escHtml(pkg.id)}">Delete</button>
          </div>
        `).join('');
        installedEl.querySelectorAll('[data-offline-delete]').forEach(btn => {
          btn.onclick = () => {
            const id = btn.getAttribute('data-offline-delete');
            if (!id) return;
            offline.deletePackage(id);
            renderDialog();
          };
        });
      }
    }

    if (catalogEl) {
      const pkgs = catalog?.packages || [];
      if (!pkgs.length) {
        catalogEl.innerHTML = '<p class="help">Tap <strong>Check catalog</strong> to fetch available state and Lower 48 packages from Cloudflare R2 once your bucket is live.</p>';
      } else {
        catalogEl.innerHTML = pkgs.map(pkg => {
          const prog = activeProgress.get(pkg.id);
          const pct = prog && prog.totalBytes > 0
            ? Math.min(100, Math.round((prog.downloadedBytes / prog.totalBytes) * 100))
            : 0;
          const isDownloading = prog && (prog.state === 'downloading' || prog.state === 'verifying');
          return `
            <div class="offline-pkg-row">
              <div style="flex:1;min-width:0">
                <strong>${escHtml(pkg.name || pkg.id)}</strong><br>
                <small>${formatBytes(pkg.downloadSizeBytes || pkg.installedSizeBytes || 0)} · v${escHtml(pkg.version || '')}</small>
                ${prog ? `<div class="offline-prog-msg">${escHtml(prog.message || prog.state)}${prog.totalBytes > 0 ? ` (${pct}%)` : ''}</div>` : ''}
                ${isDownloading ? `<progress max="100" value="${pct}" style="width:100%"></progress>` : ''}
              </div>
              <div style="display:flex;gap:6px;flex-shrink:0">
                ${isDownloading
                  ? `<button type="button" data-offline-pause="${escHtml(pkg.id)}">Pause</button>`
                  : `<button type="button" class="primary" data-offline-download="${escHtml(pkg.id)}">Download</button>`}
              </div>
            </div>
          `;
        }).join('');

        catalogEl.querySelectorAll('[data-offline-download]').forEach(btn => {
          btn.onclick = () => {
            const id = btn.getAttribute('data-offline-download');
            const pkg = pkgs.find(p => p.id === id);
            if (!pkg) return;
            try {
              offline.downloadPackage(pkg);
            } catch (err) {
              activeProgress.set(id, { state: 'error', downloadedBytes: 0, totalBytes: 0, message: err.message });
              renderDialog();
            }
          };
        });
        catalogEl.querySelectorAll('[data-offline-pause]').forEach(btn => {
          btn.onclick = () => offline.pauseDownload(btn.getAttribute('data-offline-pause'));
        });
      }
    }
  }

  async function refreshCatalog() {
    const statusEl = el('offlineCatalogStatus');
    const urlInput = el('offlineManifestUrl');
    const url = (urlInput?.value || getManifestUrl()).trim();
    if (!/^https:\/\//i.test(url)) {
      if (statusEl) statusEl.textContent = 'Manifest URL must start with https://';
      return;
    }
    try { localStorage.setItem(MANIFEST_URL_KEY, url); } catch {}
    if (statusEl) statusEl.textContent = 'Checking offline map catalog…';
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw Error('Catalog server returned HTTP ' + res.status);
      catalog = await res.json();
      if (statusEl) statusEl.textContent = `Loaded ${(catalog.packages || []).length} package(s) · release ${catalog.releaseVersion || ''}`;
    } catch (err) {
      if (statusEl) statusEl.textContent = 'Catalog unavailable (' + (err.message || 'offline') + '). Sideloaded maps still work offline.';
    }
    renderDialog();
  }

  function bindUi() {
    const openBtn = el('openOfflineMaps');
    const dialog = el('offlineMapsDialog');
    if (!openBtn || !dialog) return;

    const urlInput = el('offlineManifestUrl');
    if (urlInput) urlInput.value = getManifestUrl();

    openBtn.onclick = () => {
      if (typeof window.closeSurfaces === 'function') window.closeSurfaces();
      window.AndroidRoute?.offlineReload?.();
      renderDialog();
      dialog.showModal();
    };

    el('offlineModeSelect')?.addEventListener('change', event => {
      window.routeWeatherOffline?.setMode(event.target.value);
      if (typeof window.refreshDownloadedMap === 'function') window.refreshDownloadedMap();
      renderDialog();
    });

    el('offlineProfileSelect')?.addEventListener('change', event => {
      window.routeWeatherOffline?.setProfile(event.target.value);
      renderDialog();
    });

    el('offlineReloadBtn')?.addEventListener('click', () => {
      window.AndroidRoute?.offlineReload?.();
      if (typeof window.refreshDownloadedMap === 'function') window.refreshDownloadedMap();
      renderDialog();
    });

    el('offlineCheckCatalogBtn')?.addEventListener('click', refreshCatalog);

    window.routeWeatherOffline?.onEvent(ev => {
      if (ev.type === 'progress' && ev.packageId) {
        activeProgress.set(ev.packageId, ev);
      }
      if (dialog.open) renderDialog();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindUi);
  } else {
    bindUi();
  }
})();
