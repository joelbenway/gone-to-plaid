// Copyright (c) Joel Benway
// SPDX-License-Identifier: MIT

// ==========================================================================
// gone-to-plaid-sync Dashboard Controller
// ==========================================================================

const state = {
  quota: null,
  items: [],
  mappings: [],
  actualAccounts: [],
  history: [],
  targetDeleteItem: null,
};

// UI Elements
const el = {
  actualStatusPill: document.getElementById('actual-status-pill'),
  actualStatusText: document.getElementById('actual-status-text'),
  envBadge: document.getElementById('env-badge'),
  btnSyncAll: document.getElementById('btn-sync-all'),
  quotaUsed: document.getElementById('quota-used'),
  quotaMax: document.getElementById('quota-max'),
  quotaBarFill: document.getElementById('quota-bar-fill'),
  quotaRemainingText: document.getElementById('quota-remaining-text'),
  btnConnectInstitution: document.getElementById('btn-connect-institution'),
  quotaLockoutNotice: document.getElementById('quota-lockout-notice'),
  itemCountBadge: document.getElementById('item-count-badge'),
  institutionsContainer: document.getElementById('institutions-container'),
  mappingsTableBody: document.getElementById('mappings-table-body'),
  btnSaveMappings: document.getElementById('btn-save-mappings'),
  historyTableBody: document.getElementById('history-table-body'),
  btnRefreshHistory: document.getElementById('btn-refresh-history'),
  modalUnlink: document.getElementById('modal-unlink'),
  unlinkTargetName: document.getElementById('unlink-target-name'),
  unlinkConfirmInput: document.getElementById('unlink-confirm-input'),
  btnCancelUnlink: document.getElementById('btn-cancel-unlink'),
  btnConfirmUnlink: document.getElementById('btn-confirm-unlink'),
  toastContainer: document.getElementById('toast-container'),
};

// --- Toast System ---
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${message}</span>`;
  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// --- Data Fetching ---
async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const data = await res.json();

    state.quota = data.quota;
    state.items = data.items || [];

    renderQuota(data.quota);
    renderActualStatus(data.actual);
    renderEnv(data.server?.environment);
    renderInstitutions(state.items);
  } catch (err) {
    console.error('Failed to load status:', err);
    showToast('Failed to connect to gone-to-plaid-sync daemon', 'error');
  }
}

async function fetchActualAccounts() {
  try {
    const res = await fetch('/api/actual/accounts');
    if (!res.ok) return;
    const data = await res.json();
    state.actualAccounts = data.accounts || [];
    renderMappings();
  } catch (err) {
    console.warn('Could not fetch Actual accounts:', err);
  }
}

async function fetchMappings() {
  try {
    const res = await fetch('/api/mappings');
    const data = await res.json();
    state.mappings = data.mappings || [];
    renderMappings();
  } catch (err) {
    console.error('Failed to load mappings:', err);
  }
}

async function fetchHistory() {
  try {
    const res = await fetch('/api/history');
    const data = await res.json();
    state.history = data.history || [];
    renderHistory(state.history);
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

// --- Render Functions ---
function renderQuota(quota) {
  if (!quota) return;

  el.quotaUsed.textContent = quota.used;
  el.quotaMax.textContent = quota.max;
  el.quotaRemainingText.textContent = `${quota.remaining} lifetime slots remaining`;

  const fill = el.quotaBarFill;
  fill.style.width = `${quota.percentage}%`;
  fill.className = 'quota-bar-fill';

  if (quota.isLocked) {
    fill.classList.add('danger');
    el.btnConnectInstitution.disabled = true;
    el.btnConnectInstitution.style.opacity = '0.5';
    el.btnConnectInstitution.style.cursor = 'not-allowed';
    el.quotaLockoutNotice.classList.remove('hidden');
  } else if (quota.isWarning) {
    fill.classList.add('warning');
    el.btnConnectInstitution.disabled = false;
    el.btnConnectInstitution.style.opacity = '1';
    el.quotaLockoutNotice.classList.add('hidden');
  } else {
    el.btnConnectInstitution.disabled = false;
    el.btnConnectInstitution.style.opacity = '1';
    el.quotaLockoutNotice.classList.add('hidden');
  }
}

function renderActualStatus(actual) {
  if (!actual) return;

  if (actual.connected) {
    el.actualStatusPill.className = 'status-pill status-connected';
    el.actualStatusText.textContent = 'Actual Budget: Connected';
  } else if (!actual.configured) {
    el.actualStatusPill.className = 'status-pill status-disconnected';
    el.actualStatusText.textContent = 'Actual: Unconfigured';
  } else {
    el.actualStatusPill.className = 'status-pill status-disconnected';
    el.actualStatusText.textContent = 'Actual: Disconnected';
  }
}

function renderEnv(env) {
  const isProd = env === 'production';
  el.envBadge.textContent = (env || 'SANDBOX').toUpperCase();
  el.envBadge.className = isProd ? 'env-pill production' : 'env-pill';
}

function renderInstitutions(items) {
  el.itemCountBadge.textContent = `${items.length} item${items.length === 1 ? '' : 's'}`;

  if (items.length === 0) {
    el.institutionsContainer.innerHTML = `
      <div class="empty-state">
        <p>No financial institutions connected yet.</p>
        <p class="empty-state-sub">Click "Connect New Institution" above to link a bank account.</p>
      </div>
    `;
    return;
  }

  el.institutionsContainer.innerHTML = items
    .map((item) => {
      const isLoginRequired = item.status === 'login_required';
      const statusLabel = isLoginRequired ? 'Login Required' : item.status;
      const lastSync = item.last_sync_time
        ? new Date(item.last_sync_time).toLocaleString()
        : 'Never synced';

      return `
        <div class="institution-card">
          <div class="card-top">
            <div>
              <h4 class="card-title">${escapeHtml(item.institution_name)}</h4>
              <span class="card-id">${escapeHtml(item.institution_id)}</span>
            </div>
            <span class="badge-status badge-${item.status}">${statusLabel}</span>
          </div>

          <div class="card-meta">
            <span>Accounts: <strong>${item.enabled_mappings_count} of ${item.mappings_count} active</strong></span>
            <span>Last Sync: <strong>${lastSync}</strong></span>
            ${item.error_code ? `<span style="color: var(--accent-amber);">Code: ${escapeHtml(item.error_code)}</span>` : ''}
          </div>

          <div class="card-actions">
            <div class="card-actions-left">
              ${
                isLoginRequired
                  ? `<button class="btn btn-amber btn-sm" onclick="handleRepairItem('${item.item_id}')">
                      Repair Connection
                    </button>`
                  : `<button class="btn btn-secondary btn-sm" onclick="handleSyncItem('${item.item_id}')">
                      Sync Now
                    </button>`
              }
            </div>
            <button class="btn-text" style="color: var(--accent-rose);" onclick="handleOpenUnlinkModal('${item.item_id}', '${escapeAttr(item.institution_name)}')">
              Unlink...
            </button>
          </div>
        </div>
      `;
    })
    .join('');
}

function renderMappings() {
  if (state.mappings.length === 0) {
    el.mappingsTableBody.innerHTML = `
      <tr>
        <td colspan="6" class="table-empty">No accounts discovered yet. Connect an institution to begin mapping.</td>
      </tr>
    `;
    return;
  }

  // Create lookup for item names
  const itemMap = new Map(state.items.map((i) => [i.item_id, i.institution_name]));

  // Build Actual account select options
  const actualAccountOptions = [
    '<option value="">-- Do Not Sync --</option>',
    ...state.actualAccounts.map(
      (a) => `<option value="${a.id}">${escapeHtml(a.name)} ${a.offbudget ? '(Off-Budget)' : ''}</option>`
    ),
  ].join('');

  el.mappingsTableBody.innerHTML = state.mappings
    .map((m, idx) => {
      const instName = itemMap.get(m.item_id) || m.item_id;
      const maskStr = m.account_mask ? `(••••${escapeHtml(m.account_mask)})` : '';
      const typeStr = escapeHtml(m.account_type || 'account');

      return `
        <tr data-mapping-idx="${idx}">
          <td>
            <label class="switch">
              <input type="checkbox" class="mapping-toggle" ${m.sync_enabled ? 'checked' : ''} onchange="handleMappingToggle(${idx}, this.checked)">
              <span class="slider"></span>
            </label>
          </td>
          <td><strong>${escapeHtml(instName)}</strong></td>
          <td>${escapeHtml(m.account_name)}</td>
          <td><span class="code-span">${typeStr} ${maskStr}</span></td>
          <td>
            <select class="select-input mapping-select" onchange="handleMappingSelect(${idx}, this.value)">
              ${actualAccountOptions}
            </select>
          </td>
          <td>
            ${
              m.actual_account_id
                ? '<span style="color: var(--accent-emerald); font-weight: 600;">Mapped</span>'
                : '<span style="color: var(--text-muted);">Unmapped</span>'
            }
          </td>
        </tr>
      `;
    })
    .join('');

  // Set the selected values in the dropdowns
  const selects = el.mappingsTableBody.querySelectorAll('.mapping-select');
  selects.forEach((select, idx) => {
    select.value = state.mappings[idx].actual_account_id || '';
  });
}

function renderHistory(history) {
  if (history.length === 0) {
    el.historyTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="table-empty">No sync logs recorded yet.</td>
      </tr>
    `;
    return;
  }

  el.historyTableBody.innerHTML = history
    .map((h) => {
      const time = new Date(h.timestamp).toLocaleString();
      const statusBadge =
        h.status === 'success'
          ? '<span class="badge-status badge-healthy">Success</span>'
          : '<span class="badge-status badge-error">Error</span>';

      return `
        <tr>
          <td>${time}</td>
          <td>${escapeHtml(h.institution_name || h.item_id)}</td>
          <td>${statusBadge}</td>
          <td style="color: var(--accent-emerald);">+${h.added_count}</td>
          <td style="color: var(--accent-amber);">~${h.modified_count}</td>
          <td style="color: var(--text-muted);">${h.removed_count > 0 ? `-${h.removed_count}` : '0'}</td>
          <td style="font-size: 0.75rem; color: var(--text-secondary); max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${h.error_message ? `<span style="color: var(--accent-rose);">${escapeHtml(h.error_message)}</span>` : 'OK'}
          </td>
        </tr>
      `;
    })
    .join('');
}

// --- User Interaction Handlers ---
function handleMappingToggle(idx, enabled) {
  state.mappings[idx].sync_enabled = enabled ? 1 : 0;
}

function handleMappingSelect(idx, actualAccountId) {
  state.mappings[idx].actual_account_id = actualAccountId;
  if (actualAccountId && !state.mappings[idx].sync_enabled) {
    state.mappings[idx].sync_enabled = 1;
  }
  renderMappings();
}

async function saveMappings() {
  try {
    el.btnSaveMappings.disabled = true;
    el.btnSaveMappings.textContent = 'Saving...';

    const res = await fetch('/api/mappings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mappings: state.mappings }),
    });

    if (!res.ok) throw new Error('Save failed');
    showToast('Account mappings saved successfully', 'success');
  } catch (err) {
    showToast(`Error saving mappings: ${err.message}`, 'error');
  } finally {
    el.btnSaveMappings.disabled = false;
    el.btnSaveMappings.textContent = 'Save All Mappings';
  }
}

// Plaid Link Launcher (Enforces Update Mode if itemId is given)
async function launchPlaidLink(existingItemId = null) {
  const isUpdateMode = Boolean(existingItemId);

  try {
    showToast(isUpdateMode ? 'Launching Link in Update Mode...' : 'Requesting Link token...', 'info');

    const res = await fetch('/api/plaid/link-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(existingItemId ? { itemId: existingItemId } : {}),
    });

    const data = await res.json();
    if (data.error) {
      showToast(data.error, 'error');
      return;
    }

    if (!window.Plaid) {
      showToast('Plaid Link client library not loaded. Check internet connection.', 'error');
      return;
    }

    const handler = window.Plaid.create({
      token: data.linkToken,
      onSuccess: async (publicToken, metadata) => {
        if (isUpdateMode) {
          // Re-authenticated on existing item without burning a slot!
          showToast(`Successfully refreshed credentials for ${metadata.institution?.name || 'institution'}!`, 'success');
          await fetchStatus();
          await fetchMappings();
        } else {
          // Exchange token for new institution
          try {
            showToast('Exchanging token with Plaid...', 'info');
            const exRes = await fetch('/api/plaid/exchange-token', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                publicToken,
                institutionId: metadata.institution?.institution_id,
                institutionName: metadata.institution?.name,
              }),
            });

            const exData = await exRes.json();
            if (exData.error) {
              showToast(exData.error, 'error');
              return;
            }

            showToast(`Connected ${metadata.institution?.name}! New accounts ready for mapping.`, 'success');
            await fetchStatus();
            await fetchMappings();
          } catch (e) {
            showToast(`Token exchange failed: ${e.message}`, 'error');
          }
        }
      },
      onExit: (err, metadata) => {
        if (err) {
          console.warn('Plaid Link exited with error:', err);
        }
      },
    });

    handler.open();
  } catch (err) {
    showToast(`Error initializing Plaid Link: ${err.message}`, 'error');
  }
}

// Global Sync Trigger
async function triggerSyncAll() {
  const btn = el.btnSyncAll;
  btn.disabled = true;
  const originalText = btn.innerHTML;
  btn.innerHTML = '<span>Syncing...</span>';

  try {
    const res = await fetch('/api/sync', { method: 'POST' });
    const data = await res.json();

    if (data.error) {
      showToast(`Sync failed: ${data.error}`, 'error');
    } else {
      let totalAdded = 0;
      let totalModified = 0;
      let errors = 0;

      for (const r of data.results || []) {
        if (r.status === 'error') errors++;
        totalAdded += r.addedCount || 0;
        totalModified += r.modifiedCount || 0;
      }

      if (errors > 0) {
        showToast(`Sync completed with ${errors} warning(s). Added ${totalAdded} txs.`, 'info');
      } else {
        showToast(`Sync complete! Added ${totalAdded} transactions, modified ${totalModified}.`, 'success');
      }
    }
  } catch (err) {
    showToast(`Sync request failed: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalText;
    await fetchStatus();
    await fetchHistory();
  }
}

// Individual Sync Trigger
async function handleSyncItem(itemId) {
  showToast('Starting sync for institution...', 'info');
  try {
    const res = await fetch(`/api/sync/${itemId}`, { method: 'POST' });
    const data = await res.json();
    if (data.error) {
      showToast(`Sync error: ${data.error}`, 'error');
    } else {
      showToast(`Synced ${data.result?.institutionName}: +${data.result?.addedCount} added`, 'success');
    }
  } catch (err) {
    showToast(`Sync failed: ${err.message}`, 'error');
  } finally {
    await fetchStatus();
    await fetchHistory();
  }
}

// Repair Connection (strictly in update mode)
function handleRepairItem(itemId) {
  launchPlaidLink(itemId);
}

// Destructive Unlink Modal Management
function handleOpenUnlinkModal(itemId, institutionName) {
  state.targetDeleteItem = { itemId, institutionName };
  el.unlinkTargetName.textContent = institutionName;
  el.unlinkConfirmInput.value = '';
  el.btnConfirmUnlink.disabled = true;
  el.modalUnlink.classList.remove('hidden');
}

function handleCloseUnlinkModal() {
  state.targetDeleteItem = null;
  el.modalUnlink.classList.add('hidden');
}

async function handleConfirmUnlink() {
  if (!state.targetDeleteItem) return;
  const { itemId } = state.targetDeleteItem;
  const confirmation = el.unlinkConfirmInput.value.trim();

  try {
    el.btnConfirmUnlink.disabled = true;
    el.btnConfirmUnlink.textContent = 'Unlinking...';

    const res = await fetch(`/api/items/${itemId}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation }),
    });

    const data = await res.json();
    if (data.error) {
      showToast(data.error, 'error');
    } else {
      showToast('Item unlinked. Trial quota slot was permanently consumed.', 'info');
      handleCloseUnlinkModal();
      await fetchStatus();
      await fetchMappings();
    }
  } catch (err) {
    showToast(`Unlink failed: ${err.message}`, 'error');
  } finally {
    el.btnConfirmUnlink.disabled = false;
    el.btnConfirmUnlink.textContent = 'Permanently Burn Slot & Unlink';
  }
}

// Utility Helpers
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(str) {
  if (!str) return '';
  return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// Event Bindings
el.btnConnectInstitution.addEventListener('click', () => launchPlaidLink(null));
el.btnSyncAll.addEventListener('click', triggerSyncAll);
el.btnSaveMappings.addEventListener('click', saveMappings);
el.btnRefreshHistory.addEventListener('click', fetchHistory);

el.btnCancelUnlink.addEventListener('click', handleCloseUnlinkModal);
el.btnConfirmUnlink.addEventListener('click', handleConfirmUnlink);

el.unlinkConfirmInput.addEventListener('input', (e) => {
  const val = e.target.value.trim().toUpperCase();
  const target = state.targetDeleteItem?.institutionName?.trim().toUpperCase();
  const match = val === target || val === 'IRREVERSIBLE QUOTA LOSS';
  el.btnConfirmUnlink.disabled = !match;
});

// Expose handlers for inline HTML callbacks
window.handleSyncItem = handleSyncItem;
window.handleRepairItem = handleRepairItem;
window.handleOpenUnlinkModal = handleOpenUnlinkModal;
window.handleMappingToggle = handleMappingToggle;
window.handleMappingSelect = handleMappingSelect;

// Initialize Dashboard
(async function init() {
  await fetchStatus();
  await fetchActualAccounts();
  await fetchMappings();
  await fetchHistory();

  // Auto-refresh status and history every 30 seconds
  setInterval(async () => {
    await fetchStatus();
    await fetchHistory();
  }, 30000);
})();
