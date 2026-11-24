const FALLBACK_ICONS = {
  ai: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M12 3L4.5 20h3.6l1.7-4.1h4.4l1.7 4.1h3.6L12 3zm-1.1 9.8L12 9.6l1.1 3.2h-2.2z" fill="#4285F4"/><circle cx="18.2" cy="6.2" r="2.2" fill="#34A853"/></svg>`,
  claude: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><g stroke="#D97757" stroke-width="2.1" stroke-linecap="round"><line x1="12" y1="3" x2="12" y2="21"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="5.6" y1="5.6" x2="18.4" y2="18.4"/><line x1="18.4" y1="5.6" x2="5.6" y2="18.4"/><line x1="7.5" y1="3.8" x2="16.5" y2="20.2"/><line x1="20.2" y1="7.5" x2="3.8" y2="16.5"/></g></svg>`,
  chatgpt: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><circle cx="12" cy="12" r="8.2" stroke="#111111" stroke-width="2"/><path d="M9.5 8.8L6.5 12l3 3.2M14.5 8.8l3 3.2-3 3.2M12.9 7.8l-1.8 8.4" stroke="#111111" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  code: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5.5l-3 13" stroke="#007ACC" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="#1F2328"/><path d="M7.5 9.5L10.5 12L7.5 14.5" stroke="#4CC2FF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><line x1="12.5" y1="14.5" x2="16.5" y2="14.5" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round"/></svg>`,
  web: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="#181717" stroke-width="2"/><path d="M3.5 12h17M12 3.5c2.4 2.5 3.6 5.3 3.6 8.5s-1.2 6-3.6 8.5c-2.4-2.5-3.6-5.3-3.6-8.5s1.2-6 3.6-8.5z" stroke="#181717" stroke-width="1.8"/></svg>`,
  custom: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none"><rect x="4" y="4" width="16" height="16" rx="3" stroke="#111111" stroke-width="2"/><path d="M9 12h6M12 9v6" stroke="#111111" stroke-width="2" stroke-linecap="round"/></svg>`
};

let state = {
  config: { peekMode: true, items: [] },
  icons: {},
  extractedColors: {},
  runtime: {},
  drawerOpen: false,
  hoveredId: null,
  railHovered: false
};

const edgeRail = document.getElementById('edgeRail');
const tabList = document.getElementById('tabList');
const peekBtn = document.getElementById('peekBtn');
const configDrawer = document.getElementById('configDrawer');
const drawerList = document.getElementById('drawerList');
const toast = document.getElementById('toast');

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(showToast.t);
  showToast.t = setTimeout(() => toast.classList.remove('show'), 2200);
}

// ===== 根据真实软件图标动态提取高饱和品牌主色 =====
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return [h, s, l];
}

function extractColorFromIcon(dataUrl) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32;
      canvas.height = 32;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, 32, 32);
      const data = ctx.getImageData(0, 0, 32, 32).data;

      // 24 色相桶，按饱和度与适中明度加权
      const buckets = Array.from({ length: 24 }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3];
        if (a < 120) continue;
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const [h, s, l] = rgbToHsl(r, g, b);
        if (s < 0.22 || l < 0.14 || l > 0.86) continue;
        const idx = Math.min(23, Math.floor(h * 24));
        const weight = s * (1 - Math.abs(l - 0.52) * 1.2) * (a / 255);
        buckets[idx].w += weight;
        buckets[idx].r += r * weight;
        buckets[idx].g += g * weight;
        buckets[idx].b += b * weight;
      }

      let best = null;
      for (const bk of buckets) {
        if (bk.w > 0 && (!best || bk.w > best.w)) best = bk;
      }

      if (!best || best.w < 1.2) {
        // 纯黑白/极简灰图标兜底使用沉稳炭黑
        resolve('#27272A');
        return;
      }

      const rr = Math.round(best.r / best.w);
      const gg = Math.round(best.g / best.w);
      const bb = Math.round(best.b / best.w);
      const hex = '#' + [rr, gg, bb].map((v) => v.toString(16).padStart(2, '0')).join('');
      resolve(hex);
    };
    img.onerror = () => resolve('#27272A');
    img.src = dataUrl;
  });
}

async function refreshExtractedColors() {
  let updated = false;
  for (const [id, dataUrl] of Object.entries(state.icons || {})) {
    if (state.extractedColors[id]?.src === dataUrl) continue;
    const hex = await extractColorFromIcon(dataUrl);
    state.extractedColors[id] = { src: dataUrl, color: hex };
    updated = true;
  }
  if (updated) applyTabVisualStates();
}

function getEffectiveColor(item) {
  if (item.color && item.color !== 'auto') return item.color;
  return state.extractedColors[item.id]?.color || '#27272A';
}

// ===== 鼠标穿透 + 双屏防卡死悬停管理 =====
let lastIgnored = true;

function clearAllHover() {
  if (!state.railHovered && !state.hoveredId) return;
  state.railHovered = false;
  state.hoveredId = null;
  edgeRail.classList.remove('rail-hovered');
  document.querySelectorAll('.edge-tab.is-hovered').forEach((el) => el.classList.remove('is-hovered'));
}

window.addEventListener('mousemove', (e) => {
  const el = document.elementFromPoint(e.clientX, e.clientY);
  const isOverInteractive = Boolean(el && el.closest('.interactive'));
  const shouldIgnore = !isOverInteractive;
  if (shouldIgnore !== lastIgnored) {
    lastIgnored = shouldIgnore;
    window.docklet.setMouseIgnore(shouldIgnore);
  }

  const overRail = Boolean(el && el.closest('#edgeRail'));
  const tabEl = el ? el.closest('.edge-tab') : null;
  const nextHoverId = tabEl ? tabEl.dataset.id : null;

  if (overRail !== state.railHovered) {
    state.railHovered = overRail;
    edgeRail.classList.toggle('rail-hovered', overRail);
  }

  if (nextHoverId !== state.hoveredId) {
    state.hoveredId = nextHoverId;
    document.querySelectorAll('.edge-tab').forEach((node) => {
      node.classList.toggle('is-hovered', node.dataset.id === nextHoverId);
    });
  }
});

// 鼠标离开窗口或被主进程系统级光标守卫判定跨入右屏时，瞬间清空悬停
document.addEventListener('mouseleave', clearAllHover);
window.addEventListener('blur', clearAllHover);
window.docklet.onCursorLeave(() => {
  lastIgnored = true;
  clearAllHover();
});

// 右键菜单支持随时切换贴边与配置
edgeRail.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  window.docklet.showContextMenu();
});

function getStatusLabel(item, rt) {
  if (item.statusText) return item.statusText;
  if (item.aiStatus === 'thinking') return 'AI 思考中';
  if (item.aiStatus === 'done') return '任务完成';
  if (item.aiStatus === 'attention') return '等待确认';
  if (rt?.active) return '活跃置顶';
  if (rt?.running) return '运行中';
  if (!item.target) return '待绑定路径';
  if (/^https?:\/\//i.test(item.target)) return '网页直达';
  return '点击启动';
}

function applyTabVisualStates() {
  const { config, runtime } = state;
  (config.items || []).forEach((item) => {
    const btn = tabList.querySelector(`.edge-tab[data-id="${CSS.escape(item.id)}"]`);
    if (!btn) return;
    const rt = runtime[item.id] || {};
    const runState = rt.active ? 'active' : (rt.running ? 'running' : 'idle');
    btn.classList.toggle('active', Boolean(rt.active));
    btn.dataset.run = runState;
    if (item.aiStatus) btn.dataset.ai = item.aiStatus;
    else delete btn.dataset.ai;
    btn.style.setProperty('--brand-color', getEffectiveColor(item));
    const stateEl = btn.querySelector('.tab-state');
    if (stateEl) stateEl.textContent = getStatusLabel(item, rt);
  });
}

function renderRail() {
  const { config, icons, runtime } = state;
  edgeRail.classList.toggle('peek-mode', Boolean(config.peekMode));
  edgeRail.classList.toggle('drawer-open', state.drawerOpen);
  peekBtn.textContent = config.peekMode ? '贴边：开' : '贴边：关';

  tabList.innerHTML = '';
  (config.items || []).forEach((item) => {
    const rt = runtime[item.id] || {};
    const runState = rt.active ? 'active' : (rt.running ? 'running' : 'idle');
    const btn = document.createElement('button');
    btn.className = 'edge-tab'
      + (rt.active ? ' active' : '')
      + (state.hoveredId === item.id ? ' is-hovered' : '');
    btn.dataset.id = item.id;
    btn.dataset.run = runState;
    if (item.aiStatus) btn.dataset.ai = item.aiStatus;
    btn.style.setProperty('--brand-color', getEffectiveColor(item));

    const iconHtml = icons[item.id]
      ? `<img src="${icons[item.id]}" alt="${item.name}">`
      : (FALLBACK_ICONS[item.iconKey] || FALLBACK_ICONS.custom);

    btn.innerHTML = `
      <span class="color-spine"></span>
      <span class="tab-icon-wrap">
        ${iconHtml}
        <span class="run-dot" title="运行状态"></span>
      </span>
      <span class="tab-meta">
        <span class="tab-name">${item.name}</span>
        <span class="tab-state">${getStatusLabel(item, rt)}</span>
      </span>
    `;

    btn.addEventListener('click', async () => {
      const res = await window.docklet.activateItem(item.id);
      if (res.action === 'focused') {
        showToast(`已置顶 ${item.name}`);
      } else if (res.action === 'launched' || res.action === 'launched_url' || res.action === 'launched_cmd') {
        showToast(`正在启动 ${item.name}...`);
      } else if (res.action === 'missing_target') {
        showToast(res.message);
        setDrawerOpen(true);
      } else if (res.action === 'error') {
        showToast(`启动失败：${res.message}`);
      }
    });

    tabList.appendChild(btn);
  });
}

function renderDrawer() {
  drawerList.innerHTML = '';
  (state.config.items || []).forEach((item, idx) => {
    const effectiveColor = getEffectiveColor(item);
    const card = document.createElement('div');
    card.className = 'edit-card';
    card.innerHTML = `
      <div class="edit-row">
        <input class="color-pick" type="color" value="${effectiveColor}" title="色条颜色（默认自动取自图标）">
        <input class="edit-input name-inp" value="${item.name}" placeholder="软件名称">
        <button class="tiny-btn auto-btn" title="恢复图标自动取色">自</button>
        <button class="tiny-btn danger del-btn" title="删除">删</button>
      </div>
      <div class="edit-row">
        <input class="edit-input mono target-inp" value="${item.target || ''}" placeholder="程序路径或网址">
        <button class="tiny-btn pick-btn" title="选择文件">选</button>
      </div>
    `;

    const colorInp = card.querySelector('.color-pick');
    const nameInp = card.querySelector('.name-inp');
    const targetInp = card.querySelector('.target-inp');

    const commit = (useAutoColor = false) => {
      const next = structuredClone(state.config.items);
      next[idx].color = useAutoColor ? 'auto' : colorInp.value;
      next[idx].name = nameInp.value.trim() || next[idx].name;
      next[idx].target = targetInp.value.trim();
      window.docklet.saveItems(next);
    };

    colorInp.addEventListener('change', () => commit(false));
    nameInp.addEventListener('blur', () => commit(item.color === 'auto'));
    targetInp.addEventListener('blur', () => commit(item.color === 'auto'));

    card.querySelector('.auto-btn').addEventListener('click', () => {
      commit(true);
      showToast(`已恢复 ${item.name} 图标自动取色`);
    });

    card.querySelector('.pick-btn').addEventListener('click', async () => {
      const filePath = await window.docklet.pickFile();
      if (!filePath) return;
      targetInp.value = filePath;
      const next = structuredClone(state.config.items);
      next[idx].target = filePath;
      next[idx].iconPath = filePath;
      next[idx].color = 'auto';
      window.docklet.saveItems(next);
      showToast(`已绑定 ${item.name} 路径与图标`);
    });

    card.querySelector('.del-btn').addEventListener('click', () => {
      const next = state.config.items.filter((_, i) => i !== idx);
      window.docklet.saveItems(next);
    });

    drawerList.appendChild(card);
  });
}

function setDrawerOpen(open) {
  state.drawerOpen = open;
  configDrawer.classList.toggle('open', open);
  edgeRail.classList.toggle('drawer-open', open);
  configDrawer.setAttribute('aria-hidden', String(!open));
  if (open) renderDrawer();
}

peekBtn.addEventListener('click', async () => {
  const nextPeek = await window.docklet.togglePeek();
  showToast(nextPeek ? '贴边半隐藏已开启（Alt+Space 切换）' : '已固定展开色卡轨');
});

document.getElementById('openDrawerBtn').addEventListener('click', () => setDrawerOpen(!state.drawerOpen));
document.getElementById('closeDrawerBtn').addEventListener('click', () => setDrawerOpen(false));
window.docklet.onOpenDrawer(() => setDrawerOpen(true));

document.getElementById('autoScanBtn').addEventListener('click', async () => {
  showToast('正在扫描本机软件路径...');
  const res = await window.docklet.autoDiscover();
  if (res.count > 0) showToast(`自动识别并绑定了 ${res.count} 个软件路径`);
  else showToast('全部路径均已就绪');
});

document.getElementById('addItemBtn').addEventListener('click', () => {
  const next = structuredClone(state.config.items || []);
  const id = 'app-' + Date.now().toString(36);
  next.push({
    id,
    name: '新工具',
    target: '',
    iconPath: '',
    processHints: [],
    color: 'auto',
    iconKey: 'custom',
    aiStatus: null,
    statusText: null
  });
  window.docklet.saveItems(next);
  setDrawerOpen(true);
});

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length === 0) return;
  const next = structuredClone(state.config.items || []);
  files.forEach((f) => {
    const filePath = f.path;
    if (!filePath) return;
    const baseName = f.name.replace(/\.(exe|lnk|bat|cmd)$/i, '');
    next.push({
      id: baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + Date.now().toString(36).slice(-3),
      name: baseName,
      target: filePath,
      iconPath: filePath,
      processHints: [baseName.toLowerCase()],
      color: 'auto',
      iconKey: 'custom',
      aiStatus: null,
      statusText: null
    });
  });
  window.docklet.saveItems(next);
  showToast(`已拖入添加 ${files.length} 个入口`);
});

window.docklet.onConfig(async (payload) => {
  state.config = payload.config;
  state.icons = payload.icons || {};
  renderRail();
  await refreshExtractedColors();
  if (state.drawerOpen) renderDrawer();
});

window.docklet.onRuntime((runtime) => {
  state.runtime = runtime || {};
  applyTabVisualStates();
});
