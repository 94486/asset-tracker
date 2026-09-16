// ============ 数码资产持有成本管理系统 前端 ============
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const icon = (n) => `<svg class="ic" aria-hidden="true"><use href="#ic-${n}"/></svg>`;

let allProducts = [];
let charts = {};
let sortKey = null;       // 当前排序字段
let sortDir = "asc";      // asc / desc
let expandedId = null;     // 当前展开的行 id

// ---------- 工具 ----------
function toast(msg, type = "", sticky = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("success", "error", "loading");
  if (type) t.classList.add(type);
  t.classList.add("show");
  clearTimeout(t._timer);
  if (!sticky) t._timer = setTimeout(() => t.classList.remove("show"), 2200);
}
function hideToast() { const t = $("#toast"); clearTimeout(t._timer); t.classList.remove("show"); }
// 按钮加载态：禁用 + spinner，防重复提交
async function withLoading(btn, fn) {
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = "1";
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add("loading");
  try { await fn(); }
  finally { btn.classList.remove("loading"); btn.disabled = wasDisabled; delete btn.dataset.busy; }
}
function fmt(n) {
  if (n === null || n === undefined || n === "") return "—";
  return "¥" + Number(n).toLocaleString("zh-CN", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function today() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
async function api(url, method = "GET", body = null) {
  const opt = { method, headers: { "Content-Type": "application/json" } };
  if (body) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  return r.json();
}
function esc(s) {
  return String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

// ---------- 通用对话框（替代原生 confirm / alert） ----------
let _dialogResolve = null;
function uiDialog({ title = "", message = "", actions = [] }) {
  return new Promise((resolve) => {
    _dialogResolve = resolve;
    const t = $("#dialog-title");
    t.textContent = title;
    t.style.display = title ? "" : "none";
    const m = $("#dialog-msg");
    m.innerHTML = message;
    m.style.display = message ? "" : "none";
    const box = $("#dialog-actions");
    box.innerHTML = "";
    actions.forEach((a) => {
      const b = document.createElement("button");
      b.className = "btn " + (a.kind || "ghost");
      b.textContent = a.label;
      b.onclick = () => closeDialog(a.value);
      box.appendChild(b);
    });
    $("#dialog-mask").classList.add("show");
    const focusBtn = box.querySelector(".btn.primary") || box.querySelector(".btn");
    if (focusBtn) setTimeout(() => focusBtn.focus(), 60);
  });
}
function closeDialog(value) {
  $("#dialog-mask").classList.remove("show");
  if (_dialogResolve) { _dialogResolve(value); _dialogResolve = null; }
}
// 确认框：确定返回 true，取消/关闭返回 false
function uiConfirm(title, message, okText = "确定") {
  return uiDialog({
    title, message,
    actions: [
      { label: "取消", value: false, kind: "ghost" },
      { label: okText, value: true, kind: "primary" },
    ],
  });
}
// 提示框：单按钮
function uiAlert(title, message) {
  return uiDialog({ title, message, actions: [{ label: "知道了", value: true, kind: "primary" }] });
}
$("#dialog-mask").addEventListener("click", (e) => { if (e.target.id === "dialog-mask") closeDialog(null); });

// ---------- 自定义字段 ----------
function renderCustoms(obj = {}) {
  const box = $("#custom-list");
  box.innerHTML = "";
  Object.entries(obj).forEach(([k, v]) => addCustomRow(k, v));
}
function addCustomRow(key = "", val = "") {
  const box = $("#custom-list");
  const div = document.createElement("div");
  div.className = "custom-item";
  div.innerHTML = `
    <input class="ck" placeholder="字段名" value="${esc(key)}">
    <input class="cv" placeholder="值" value="${esc(val)}">
    <button class="del" type="button" title="删除该字段" aria-label="删除该字段">${icon("close")}</button>`;
  div.querySelector(".del").onclick = () => div.remove();
  box.appendChild(div);
}
function collectCustoms() {
  const obj = {};
  $$("#custom-list .custom-item").forEach((it) => {
    const k = it.querySelector(".ck").value.trim();
    const v = it.querySelector(".cv").value.trim();
    if (k) obj[k] = v;
  });
  return obj;
}

// ---------- 表单 ----------
function resetForm() {
  $("#form-title").textContent = "录入新资产";
  $("#f-id").value = "";
  ["f-name", "f-brand", "f-category", "f-price", "f-config", "f-notes"].forEach((id) => ($("#" + id).value = ""));
  $("#f-pdate").value = today();
  renderCustoms({});
}
function fillForm(p) {
  $("#form-title").textContent = "编辑资产";
  $("#f-id").value = p.id;
  $("#f-name").value = p.name || "";
  $("#f-brand").value = p.brand || "";
  $("#f-category").value = p.category || "";
  $("#f-price").value = p.price ?? "";
  $("#f-pdate").value = p.purchase_date || "";
  $("#f-config").value = p.config || "";
  $("#f-notes").value = p.notes || "";
  renderCustoms(p.custom_fields || {});
}
function collectForm() {
  return {
    id: $("#f-id").value ? Number($("#f-id").value) : null,
    name: $("#f-name").value.trim(),
    brand: $("#f-brand").value.trim(),
    category: $("#f-category").value.trim(),
    price: $("#f-price").value,
    purchase_date: $("#f-pdate").value,
    config: $("#f-config").value.trim(),
    custom_fields: collectCustoms(),
    notes: $("#f-notes").value.trim(),
  };
}

// ---------- 抽屉 ----------
function openDrawer(mode = "create", p = null) {
  if (mode === "edit" && p) {
    fillForm(p);
  } else {
    resetForm();
  }
  $("#drawer-mask").classList.add("show");
  $("#drawer").classList.add("show");
  document.body.style.overflow = "hidden";
  setTimeout(() => $("#f-name").focus(), 350);
}
function closeDrawer() {
  $("#drawer-mask").classList.remove("show");
  $("#drawer").classList.remove("show");
  document.body.style.overflow = "";
}
$("#fab-add").onclick = () => openDrawer("create");
$("#drawer-close").onclick = closeDrawer;
$("#drawer-mask").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if ($("#dialog-mask").classList.contains("show")) closeDialog(null);
  else if ($("#modal-mask").classList.contains("show")) closeSellModal();
  else if ($("#drawer").classList.contains("show")) closeDrawer();
});

// ---------- 加载列表 ----------
async function loadProducts() {
  const res = await api("/api/products");
  allProducts = res.data || [];
  populateFilters();
  renderTable();
}
function statusText(s) {
  return { in_use: "使用中", sold: "已售出", damaged: "已损坏" }[s] || s;
}

// ---------- 品类图标映射（自由文本 → 图标名，未命中用通用 box） ----------
const CATEGORY_RULES = [
  ["cat-phone", ["手机", "phone", "iphone", "红米", "一加", "真我", "pixel"]],
  ["cat-tablet", ["平板", "pad", "ipad", "tablet", "matepad", "学习机"]],
  ["cat-laptop", ["笔记本", "laptop", "macbook", "thinkpad", "拯救者", "电脑", "轻薄本", "游戏本"]],
  ["cat-monitor", ["显示器", "monitor", "显示屏"]],
  ["cat-headphone", ["耳机", "headphone", "earphone", "earbud", "airpods", "耳夹", "头戴", "tws"]],
  ["cat-watch", ["手表", "watch", "手环", "band"]],
  ["cat-camera", ["相机", "camera", "单反", "微单", "gopro", "镜头"]],
  ["cat-keyboard", ["键盘", "keyboard"]],
  ["cat-mouse", ["鼠标", "mouse"]],
  ["cat-gamepad", ["游戏", "switch", "ps5", "ps4", "xbox", "掌机", "steam", "手柄", "gamepad"]],
  ["cat-tv", ["电视", "投影", "tv", "projector"]],
  ["cat-speaker", ["音箱", "音响", "喇叭", "speaker", "homepod"]],
  ["cat-battery", ["充电", "移动电源", "充电宝", "电源", "powerbank", "battery"]],
  ["cat-glasses", ["眼镜", "glass", "glasses"]],
];
function categoryIcon(cat) {
  const c = String(cat || "").toLowerCase();
  if (c) for (const [name, kws] of CATEGORY_RULES) if (kws.some((k) => c.includes(k.toLowerCase()))) return name;
  return "box";
}

// ---------- 盈亏单元格 ----------
function pnlCell(p) {
  if (p.profit_loss === null || p.profit_loss === undefined) {
    return `<span class="pnl pending" title="持有中，未结算">持有中</span>`;
  }
  const v = Number(p.profit_loss);
  if (v > 0) return `<span class="pnl profit num">+${fmt(v)}</span>`;
  if (v < 0) return `<span class="pnl loss num">−${fmt(Math.abs(v))}</span>`;
  return `<span class="pnl flat num">¥0</span>`;
}

// ---------- 筛选下拉动态填充 ----------
function populateFilters() {
  const brands = [...new Set(allProducts.map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const cats = [...new Set(allProducts.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const brandSel = $("#filter-brand");
  const catSel = $("#filter-category");
  const bv = brandSel.value, cv = catSel.value;
  brandSel.innerHTML = '<option value="">全部品牌</option>' + brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  catSel.innerHTML = '<option value="">全部分类</option>' + cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  brandSel.value = bv;
  catSel.value = cv;
}

// ---------- 排序 ----------
function sortList(list) {
  if (!sortKey) return list;
  return [...list].sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    // null / undefined 排到最后
    if (va === null || va === undefined) return 1;
    if (vb === null || vb === undefined) return -1;
    if (typeof va === "string") {
      const cmp = va.localeCompare(vb, "zh-CN");
      return sortDir === "asc" ? cmp : -cmp;
    }
    return sortDir === "asc" ? va - vb : vb - va;
  });
}
function updateSortArrows() {
  $$("#asset-table th.sortable").forEach((th) => {
    th.classList.remove("sorted");
    let arrow = th.querySelector(".sort-arrow");
    if (!arrow) {
      arrow = document.createElement("span");
      arrow.className = "sort-arrow";
      th.appendChild(arrow);
    }
    if (th.dataset.sort === sortKey) {
      th.classList.add("sorted");
      arrow.textContent = sortDir === "asc" ? "▲" : "▼";
    } else {
      arrow.textContent = "↕";
    }
  });
}

// ---------- 行展开详情内容 ----------
function renderDetailContent(p) {
  const customs = Object.entries(p.custom_fields || {});
  let html = `<div class="detail-content">`;

  // 基本信息网格
  html += `<div class="detail-grid">`;
  html += `<div class="detail-item"><span class="detail-label">分类</span><span class="detail-value">${esc(p.category) || "—"}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">配置</span><span class="detail-value">${esc(p.config) || "—"}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">购买时间</span><span class="detail-value num">${p.purchase_date || "—"}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">已持有</span><span class="detail-value num">${p.days_held} 天</span></div>`;
  if (p.status !== "in_use") {
    html += `<div class="detail-item"><span class="detail-label">处理日期</span><span class="detail-value num">${p.sale_date || "—"}</span></div>`;
    if (p.status === "sold") {
      html += `<div class="detail-item"><span class="detail-label">出售价格</span><span class="detail-value num">${fmt(p.sale_price)}</span></div>`;
    }
    html += `<div class="detail-item"><span class="detail-label">折旧金额</span><span class="detail-value num">${fmt(p.depreciation)}</span></div>`;
    html += `<div class="detail-item"><span class="detail-label">折旧率</span><span class="detail-value num">${p.depreciation_rate}%</span></div>`;
    html += `<div class="detail-item"><span class="detail-label">最终日均成本</span><span class="detail-value num">${fmt(p.final_holding_cost)}/天</span></div>`;
  }
  html += `</div>`;

  // 自定义字段
  if (customs.length) {
    html += `<div class="detail-section"><h4>自定义字段</h4><div class="detail-grid">`;
    customs.forEach(([k, v]) => {
      html += `<div class="detail-item"><span class="detail-label">${esc(k)}</span><span class="detail-value">${esc(v)}</span></div>`;
    });
    html += `</div></div>`;
  }

  // 备注
  if (p.notes) {
    html += `<div class="detail-section"><h4>备注</h4><p class="detail-notes">${esc(p.notes)}</p></div>`;
  }

  html += `</div>`;
  return html;
}

// ---------- 汇总行 ----------
function renderFooter(list) {
  const foot = $("#asset-foot");
  if (!list.length) { foot.innerHTML = ""; return; }
  const totalPrice = list.reduce((s, p) => s + (Number(p.price) || 0), 0);
  const inUse = list.filter((p) => p.status === "in_use");
  const dailyTotal = inUse.reduce((s, p) => s + (Number(p.daily_cost) || 0), 0);
  const settled = list.filter((p) => p.profit_loss !== null && p.profit_loss !== undefined);
  const pnlTotal = settled.reduce((s, p) => s + (Number(p.profit_loss) || 0), 0);
  const pnlCls = pnlTotal > 0 ? "pnl profit" : pnlTotal < 0 ? "pnl loss" : "pnl flat";
  const pnlTxt = pnlTotal > 0 ? "+" + fmt(pnlTotal) : pnlTotal < 0 ? "−" + fmt(Math.abs(pnlTotal)) : fmt(0);

  foot.innerHTML = `
    <tr>
      <td></td>
      <td colspan="2" class="sum-label">合计（${list.length} 件）</td>
      <td class="price num">${fmt(totalPrice)}</td>
      <td colspan="2"></td>
      <td class="daily num">${fmt(dailyTotal)}/天</td>
      <td class="${pnlCls} num">${pnlTxt}</td>
      <td colspan="2"></td>
    </tr>`;
}

// ---------- 空状态 ----------
function renderEmptyState(count, filtered) {
  const tip = $("#empty-tip");
  if (count) { tip.style.display = "none"; tip.innerHTML = ""; return; }
  tip.style.display = "flex";
  if (!allProducts.length) {
    tip.innerHTML = `<div class="empty-ic">${icon("box")}</div><h3>还没有任何资产</h3><p>开始记录你的第一件数码产品，系统会自动算清每天的持有成本。</p><button class="btn primary" id="empty-add">${icon("plus")}新增资产</button>`;
    tip.querySelector("#empty-add").onclick = () => openDrawer("create");
  } else {
    tip.innerHTML = `<div class="empty-ic">${icon("search")}</div><h3>没有匹配的资产</h3><p>当前搜索或筛选条件下没有结果，试着调整条件。</p><button class="btn ghost" id="empty-clear">${icon("close")}清除筛选</button>`;
    tip.querySelector("#empty-clear").onclick = clearFilters;
  }
}
function clearFilters() {
  $("#filter-kw").value = "";
  $("#filter-status").value = "";
  $("#filter-brand").value = "";
  $("#filter-category").value = "";
  renderTable();
}

// ---------- 渲染表格 ----------
function renderTable() {
  const kw = $("#filter-kw").value.trim().toLowerCase();
  const st = $("#filter-status").value;
  const br = $("#filter-brand").value;
  const cat = $("#filter-category").value;

  // 筛选
  let list = allProducts.filter((p) => {
    const okSt = !st || p.status === st;
    const okBr = !br || p.brand === br;
    const okCat = !cat || p.category === cat;
    const okKw = !kw || (p.name + p.brand + p.category + p.config).toLowerCase().includes(kw);
    return okSt && okBr && okCat && okKw;
  });

  // 排序
  list = sortList(list);

  // 渲染行
  const tbody = $("#asset-body");
  tbody.innerHTML = "";
  const filtered = !!(kw || st || br || cat);
  renderEmptyState(list.length, filtered);
  $("#asset-count").textContent = filtered
    ? `${list.length} / ${allProducts.length} 件`
    : `${allProducts.length} 件`;

  list.forEach((p) => {
    const isExpanded = expandedId === p.id;
    const tr = document.createElement("tr");
    if (isExpanded) tr.classList.add("expanded");
    tr.innerHTML = `
      <td class="col-expand"><button class="expand-btn" data-id="${p.id}" title="展开详情" aria-label="展开详情">${icon("chevron")}</button></td>
      <td><div class="cat-cell"><span class="cat-chip" title="品类：${esc(p.category) || "未分类"}">${icon(categoryIcon(p.category))}</span><div class="cell-name"><strong>${esc(p.name)}</strong>${p.config ? `<span class="cell-sub">${esc(p.config)}</span>` : ""}</div></div></td>
      <td>${esc(p.brand) || "—"}</td>
      <td class="price num">${fmt(p.price)}</td>
      <td class="num">${p.purchase_date || "—"}</td>
      <td class="num">${p.days_held} 天</td>
      <td class="daily daily-${p.status} num">${fmt(p.daily_cost)}/天</td>
      <td>${pnlCell(p)}</td>
      <td><span class="badge ${p.status}">${statusText(p.status)}</span></td>
      <td class="col-ops">
        <button class="op-btn" data-act="sell" data-id="${p.id}" data-status="${p.status}" title="${p.status === "in_use" ? "登记出售或损坏" : "恢复为使用中"}">${icon(p.status === "in_use" ? "sell" : "restore")}${p.status === "in_use" ? "处理" : "恢复"}</button>
        <button class="icon-btn" data-act="edit" data-id="${p.id}" title="编辑" aria-label="编辑">${icon("edit")}</button>
        <button class="icon-btn danger" data-act="del" data-id="${p.id}" title="删除" aria-label="删除">${icon("trash")}</button>
      </td>`;
    tbody.appendChild(tr);

    // 展开详情行
    if (isExpanded) {
      const detailTr = document.createElement("tr");
      detailTr.className = "detail-row";
      detailTr.innerHTML = `<td></td><td colspan="9">${renderDetailContent(p)}</td>`;
      tbody.appendChild(detailTr);
    }
  });

  renderFooter(list);
  updateSortArrows();
}

// ---------- 表格事件（展开 + 操作按钮） ----------
$("#asset-body").addEventListener("click", async (e) => {
  // 展开按钮
  const expandBtn = e.target.closest(".expand-btn");
  if (expandBtn) {
    const id = Number(expandBtn.dataset.id);
    expandedId = expandedId === id ? null : id;
    renderTable();
    return;
  }
  // 操作按钮
  const btn = e.target.closest(".op-btn, .icon-btn");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const p = allProducts.find((x) => x.id === id);
  if (act === "edit") {
    openDrawer("edit", p);
  } else if (act === "del") {
    const ok = await uiConfirm("删除资产", `确定删除「<strong>${esc(p.name)}</strong>」？此操作<span class="warn">不可恢复</span>。`, "删除");
    if (!ok) return;
    await withLoading(btn, async () => {
      await api(`/api/products/${id}`, "DELETE");
      if (expandedId === id) expandedId = null;
      toast("已删除", "success");
      await loadProducts();
    });
  } else if (act === "sell") {
    openSellModal(p);
  }
});

// ---------- 表头排序点击 ----------
$("#asset-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;
  if (sortKey === key) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortKey = key;
    sortDir = "asc";
  }
  renderTable();
});

// ---------- 出售/损坏弹窗 ----------
let sellTarget = null;
let sellStatus = "sold";   // 当前弹窗内选择的处理结果：sold / damaged
function setSellStatus(s) {
  sellStatus = s;
  $$("#m-status .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.status === s));
  $("#m-price-wrap").style.display = s === "sold" ? "block" : "none";
}
function openSellModal(p) {
  sellTarget = p;
  $("#m-id").value = p.id;
  $("#m-price").value = "";
  const confirmBtn = $("#modal-confirm");
  if (p.status === "in_use") {
    $("#modal-title").textContent = `登记处理 · ${p.name}`;
    confirmBtn.textContent = "确认登记";
    confirmBtn.dataset.mode = "process";
    confirmBtn.className = "btn primary";
    $("#m-date").value = today();
    $("#m-status-wrap").style.display = "block";
    $("#m-date-wrap").style.display = "block";
    setSellStatus("sold");
  } else {
    $("#modal-title").textContent = `恢复为使用中 · ${p.name}`;
    confirmBtn.textContent = "恢复为使用中";
    confirmBtn.dataset.mode = "restore";
    confirmBtn.className = "btn primary";
    $("#m-status-wrap").style.display = "none";
    $("#m-date-wrap").style.display = "none";
    $("#m-price-wrap").style.display = "none";
  }
  $("#modal-mask").classList.add("show");
}
function closeSellModal() {
  $("#modal-mask").classList.remove("show");
  sellTarget = null;
}
$$("#m-status .seg-btn").forEach((b) => { b.onclick = () => setSellStatus(b.dataset.status); });
$("#modal-cancel").onclick = closeSellModal;
$("#modal-mask").addEventListener("click", (e) => { if (e.target.id === "modal-mask") closeSellModal(); });
$("#modal-confirm").onclick = () => {
  const btn = $("#modal-confirm");
  const mode = btn.dataset.mode;
  const id = Number($("#m-id").value);
  if (mode !== "restore") {
    const rawPrice = $("#m-price").value;
    if (sellStatus === "sold" && (rawPrice === "" || isNaN(Number(rawPrice)))) {
      toast("请填写出售价格", "error"); return;
    }
  }
  withLoading(btn, async () => {
    if (mode === "restore") {
      await api(`/api/products/${id}/sell`, "POST", { status: "in_use" });
      toast("已恢复为使用中", "success");
    } else {
      await api(`/api/products/${id}/sell`, "POST", {
        status: sellStatus,
        sale_date: $("#m-date").value || today(),
        sale_price: sellStatus === "sold" ? Number($("#m-price").value || 0) : null,
      });
      toast(sellStatus === "sold" ? "已登记出售" : "已登记损坏", "success");
    }
    closeSellModal();
    await loadProducts();
  });
};

// ---------- 保存 ----------
$("#btn-save").onclick = () => {
  const btn = $("#btn-save");
  const data = collectForm();
  if (!data.name) return toast("请填写名称", "error");
  if (data.price === "" || isNaN(data.price)) return toast("请填写有效价格", "error");
  if (!data.purchase_date) return toast("请选择购买时间", "error");
  const id = data.id;
  delete data.id;
  withLoading(btn, async () => {
    if (id) {
      await api(`/api/products/${id}`, "PUT", data);
      toast("已更新", "success");
    } else {
      await api("/api/products", "POST", data);
      toast("已保存", "success");
    }
    closeDrawer();
    await loadProducts();
  });
};
$("#btn-reset").onclick = resetForm;
$("#add-custom").onclick = () => addCustomRow();

// ---------- 筛选事件（搜索防抖） ----------
let _kwTimer = null;
$("#filter-kw").oninput = () => { clearTimeout(_kwTimer); _kwTimer = setTimeout(renderTable, 160); };
$("#filter-status").onchange = renderTable;
$("#filter-brand").onchange = renderTable;
$("#filter-category").onchange = renderTable;

// ---------- Tab 切换 ----------
function activateTab(name) {
  $$(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  $$(".page").forEach((p) => p.classList.remove("active"));
  $("#tab-" + name).classList.add("active");
  if (name === "report") loadReport();
}
$$(".tab").forEach((t) => { t.onclick = () => activateTab(t.dataset.tab); });

// ---------- 键盘快捷键 ----------
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  if (typing) return;
  if ($("#drawer").classList.contains("show") || $("#modal-mask").classList.contains("show") || $("#dialog-mask").classList.contains("show")) return;
  if (e.key === "n" || e.key === "N") { e.preventDefault(); openDrawer("create"); }
  else if (e.key === "/") { e.preventDefault(); activateTab("assets"); $("#filter-kw").focus(); }
});

// ---------- 统计卡片（报表页总览） ----------
function renderStats(containerId, s) {
  const box = $("#" + containerId);
  if (!box) return;
  const pnl = Number(s.total_pnl || 0);
  const sale = Number(s.total_sale || 0);
  const settledCount = (s.profit_count || 0) + (s.loss_count || 0);

  box.innerHTML = `
    <div class="stat"><div class="num">${fmt(s.held_value)}</div><div class="lbl">持有资产总额（使用中 ${s.in_use_count} 件，不含已售/损坏）</div></div>
    <div class="stat o"><div class="num">${fmt(s.total_invested)}</div><div class="lbl">总投入（历史累计，不含已删除）</div></div>
    <div class="stat dual">
      <div class="dual-row">
        <div class="dual-item">
          <div class="dual-label">售出回血</div>
          <div class="dual-num g">${fmt(sale)}</div>
        </div>
        <div class="dual-divider"></div>
        <div class="dual-item">
          <div class="dual-label">最终损失</div>
          <div class="dual-num r">${pnl < 0 ? "−" + fmt(Math.abs(pnl)) : fmt(pnl)}</div>
        </div>
      </div>
      <div class="lbl">已结算 ${settledCount} 件</div>
    </div>
    <div class="stat"><div class="num">${s.total_count}</div><div class="lbl">资产总数（使用中 ${s.in_use_count} · 售出 ${s.sold_count} · 损坏 ${s.damaged_count}）</div></div>
    <div class="stat g"><div class="num">${fmt(s.current_daily_total)}</div><div class="lbl">当前每日持有成本合计（仅使用中）</div></div>`;
}

// ---------- 报表 ----------
const palette = ["#5b8cff", "#8f5bff", "#3ddc97", "#f5b942", "#ff8c42", "#ff6b6b", "#4fd1c5", "#7c9cff"];
function getChart(id) {
  if (!charts[id]) charts[id] = echarts.init($("#" + id));
  return charts[id];
}

// ---------- 趣味排行榜 ----------
function renderFunRank() {
  const box = $("#fun-row");
  if (!allProducts.length) {
    box.innerHTML = `<div class="fun-card empty"><div class="fun-icon">📊</div><div class="fun-title">还没有数据</div><div class="fun-name">录入资产后解锁趣味排行</div></div>`;
    return;
  }

  // 败家之王：投入最高
  const bigSpender = [...allProducts].sort((a, b) => b.price - a.price)[0];
  // 最强钉子户：持有天数最长
  const hoarder = [...allProducts].sort((a, b) => b.days_held - a.days_held)[0];
  // 跳水冠军：折旧率最高（已结算）
  const settled = allProducts.filter((p) => p.depreciation_rate !== null && p.depreciation_rate !== undefined);
  const diver = settled.length ? [...settled].sort((a, b) => b.depreciation_rate - a.depreciation_rate)[0] : null;
  // 性价比之王：使用中且价格>=200，每日成本最低
  const valueCandidates = allProducts.filter((p) => p.status === "in_use" && p.price >= 200);
  const valueKing = valueCandidates.length ? [...valueCandidates].sort((a, b) => a.daily_cost - b.daily_cost)[0] : null;

  // 年度败家王：投入最多的年份
  const yearMap = {};
  allProducts.forEach((p) => {
    if (p.purchase_date) {
      const y = p.purchase_date.substring(0, 4);
      yearMap[y] = (yearMap[y] || 0) + (Number(p.price) || 0);
    }
  });
  const yearEntries = Object.entries(yearMap).sort((a, b) => b[1] - a[1]);
  const yearKing = yearEntries.length ? { name: yearEntries[0][0] + "年", _total: yearEntries[0][1] } : null;

  // 最保值产品：已结算产品中折旧率最低
  const bestProduct = settled.length ? [...settled].sort((a, b) => (a.depreciation_rate || 0) - (b.depreciation_rate || 0))[0] : null;

  // 最新入手：购买日期最近
  const newest = [...allProducts].sort((a, b) => (b.purchase_date || "").localeCompare(a.purchase_date || ""))[0];

  const cards = [
    { icon: "💰", title: "败家之王", p: bigSpender, val: `入手价 ${fmt(bigSpender.price)}` },
    { icon: "🏠", title: "最强钉子户", p: hoarder, val: `已陪伴 ${hoarder.days_held} 天` },
    { icon: "📉", title: "跳水冠军", p: diver, val: diver ? `折旧率 ${diver.depreciation_rate}%` : "虚位以待" },
    { icon: "✨", title: "性价比之王", p: valueKing, val: valueKing ? `仅 ${fmt(valueKing.daily_cost)}/天` : "虚位以待" },
    { icon: "📅", title: "年度败家王", p: yearKing, val: yearKing ? `共投入 ${fmt(yearKing._total)}` : "虚位以待" },
    { icon: "🛡️", title: "最保值产品", p: bestProduct, val: bestProduct ? `折旧率仅 ${bestProduct.depreciation_rate}%` : "虚位以待" },
    { icon: "🔥", title: "最新入手", p: newest, val: newest ? `${newest.purchase_date} 入手` : "虚位以待" },
  ];

  box.innerHTML = cards.map((c) => {
    if (!c.p) {
      return `<div class="fun-card empty"><div class="fun-icon">${c.icon}</div><div class="fun-title">${c.title}</div><div class="fun-name">${c.val}</div></div>`;
    }
    return `<div class="fun-card">
      <div class="fun-icon">${c.icon}</div>
      <div class="fun-title">${c.title}</div>
      <div class="fun-name">${esc(c.p.name)}</div>
      <div class="fun-value">${c.val}</div>
    </div>`;
  }).join("");
}

// ---------- 月度投入数据 ----------
function getMonthlyData() {
  const map = {};
  allProducts.forEach((p) => {
    if (!p.purchase_date) return;
    const ym = p.purchase_date.substring(0, 7); // YYYY-MM
    map[ym] = (map[ym] || 0) + (Number(p.price) || 0);
  });
  const months = Object.keys(map).sort();
  return { months, values: months.map((m) => Math.round(map[m] * 100) / 100) };
}

// ---------- 加载报表 ----------
async function loadReport() {
  const [sum, dep] = await Promise.all([api("/api/report/summary"), api("/api/report/depreciation")]);
  const s = sum.data;

  // 统计卡片（总览）
  renderStats("stat-row", s);

  // 智能洞察
  renderInsights(s);

  // 趣味排行榜
  renderFunRank();

  // 每日成本排名
  const daily = dep.data.daily_rank.slice(0, 12);
  getChart("chart-daily").setOption({
    grid: { left: 90, right: 30, top: 20, bottom: 30 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    xAxis: { type: "value", axisLabel: { color: "#9aa5bf" }, splitLine: { lineStyle: { color: "#2a3554" } } },
    yAxis: { type: "category", data: daily.map((d) => d.name).reverse(), axisLabel: { color: "#eef2fa" } },
    series: [{
      type: "bar", data: daily.map((d) => d.daily_cost).reverse(), barWidth: 16,
      itemStyle: { borderRadius: 8, color: (p) => daily[daily.length - 1 - p.dataIndex].status === "in_use" ? "#3ddc97" : "#f5b942" },
      label: { show: true, position: "right", color: "#9aa5bf", formatter: "¥{c}/天" },
    }],
  });

  // 折旧排行
  const dpr = dep.data.dep_rank.slice(0, 12);
  getChart("chart-dep").setOption({
    grid: { left: 90, right: 50, top: 20, bottom: 30 },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" }, formatter: (ps) => {
      const i = ps[0].dataIndex; const d = dpr[dpr.length - 1 - i];
      return `${d.name}<br/>折旧：${fmt(d.depreciation)}<br/>折旧率：${d.rate}%<br/>最终持有成本：${fmt(d.final_cost)}/天`;
    }},
    xAxis: { type: "value", axisLabel: { color: "#9aa5bf" }, splitLine: { lineStyle: { color: "#2a3554" } } },
    yAxis: { type: "category", data: dpr.map((d) => d.name).reverse(), axisLabel: { color: "#eef2fa" } },
    series: [{ type: "bar", data: dpr.map((d) => d.depreciation).reverse(), barWidth: 16,
      itemStyle: { borderRadius: 8, color: "#ff6b6b" },
      label: { show: true, position: "right", color: "#9aa5bf", formatter: "¥{c}" } }],
  });

  // 品牌分布
  getChart("chart-brand").setOption({
    tooltip: { trigger: "item", formatter: "{b}: ¥{c} ({d}%)" },
    legend: { bottom: 0, textStyle: { color: "#9aa5bf" } },
    color: palette,
    series: [{ type: "pie", radius: ["40%", "68%"], center: ["50%", "45%"],
      data: s.brand_dist, label: { color: "#eef2fa" }, itemStyle: { borderColor: "#1a2234", borderWidth: 2 } }],
  });

  // 分类分布
  const catData = (s.cat_dist || []).map((c) => ({ name: c.name, value: c.value }));
  getChart("chart-category").setOption({
    tooltip: { trigger: "item", formatter: "{b}: {c} 件 ({d}%)" },
    legend: { bottom: 0, textStyle: { color: "#9aa5bf" } },
    color: palette,
    series: [{ type: "pie", radius: ["40%", "68%"], center: ["50%", "45%"], roseType: "radius",
      data: catData, label: { color: "#eef2fa" }, itemStyle: { borderColor: "#1a2234", borderWidth: 2 } }],
  });

  // 月度投入趋势
  const monthly = getMonthlyData();
  getChart("chart-monthly").setOption({
    grid: { left: 60, right: 20, top: 30, bottom: 40 },
    tooltip: { trigger: "axis", formatter: (ps) => `${ps[0].name}<br/>投入：${fmt(ps[0].value)}` },
    xAxis: { type: "category", data: monthly.months, axisLabel: { color: "#9aa5bf", rotate: 30 } },
    yAxis: { type: "value", axisLabel: { color: "#9aa5bf" }, splitLine: { lineStyle: { color: "#2a3554" } } },
    series: [{ type: "bar", data: monthly.values, barWidth: "50%",
      itemStyle: { borderRadius: [6, 6, 0, 0], color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
        colorStops: [{ offset: 0, color: "#5b8cff" }, { offset: 1, color: "#8f5bff" }] } },
      label: { show: true, position: "top", color: "#9aa5bf", formatter: "¥{c}" } }],
  });

  // 资产画像散点图：X=持有天数 Y=每日成本 大小=价格 颜色=状态
  const scatterData = allProducts.map((p) => ({
    name: p.name,
    value: [p.days_held, p.daily_cost, p.price],
    status: p.status,
    itemStyle: {
      color: p.status === "in_use" ? "#3ddc97" : p.status === "sold" ? "#f5b942" : "#ff6b6b",
    },
  }));
  getChart("chart-scatter").setOption({
    grid: { left: 60, right: 30, top: 30, bottom: 40 },
    tooltip: { formatter: (p) => `${p.data.name}<br/>持有：${p.value[0]} 天<br/>日均成本：${fmt(p.value[1])}/天<br/>购入价：${fmt(p.value[2])}` },
    xAxis: { name: "持有天数", nameTextStyle: { color: "#9aa5bf" }, axisLabel: { color: "#9aa5bf" }, splitLine: { lineStyle: { color: "#2a3554" } } },
    yAxis: { name: "每日成本", nameTextStyle: { color: "#9aa5bf" }, axisLabel: { color: "#9aa5bf" }, splitLine: { lineStyle: { color: "#2a3554" } } },
    series: [{
      type: "scatter", data: scatterData,
      symbolSize: (val) => Math.max(10, Math.min(40, Math.sqrt(val[2]) * 1.5)),
      itemStyle: { opacity: 0.75, borderColor: "#fff", borderWidth: 1 },
      emphasis: { itemStyle: { opacity: 1, shadowBlur: 10, shadowColor: "rgba(91,140,255,.5)" } },
    }],
  });
}
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

// ---------- 智能洞察 ----------
function renderInsights(s) {
  const box = $("#insight-box");
  if (!box) return;
  if (!allProducts.length) { box.innerHTML = ""; return; }

  const items = [];
  const inUse = allProducts.filter((p) => p.status === "in_use");
  const settled = allProducts.filter((p) => p.profit_loss !== null && p.profit_loss !== undefined);

  // ① 年化持有开销（在用）
  if (inUse.length) {
    const yearly = Math.round((Number(s.current_daily_total) || 0) * 365);
    if (yearly > 0) items.push(`按当前 <strong>${inUse.length}</strong> 件在用资产的每日成本推算，一年持有开销约 <span class="warn">${fmt(yearly)}</span>。`);
    // ② 每日成本最高单品
    const top = [...inUse].sort((a, b) => (b.daily_cost || 0) - (a.daily_cost || 0))[0];
    if (top && top.daily_cost > 0) items.push(`「<strong>${esc(top.name)}</strong>」是当下最烧钱的在用资产，每天 <span class="warn">${fmt(top.daily_cost)}</span>（已持有 ${top.days_held} 天）。`);
  }

  // ③ 高折旧预警
  const steep = settled.filter((p) => (p.depreciation_rate || 0) >= 60);
  if (steep.length) {
    const worst = [...steep].sort((a, b) => (b.depreciation_rate || 0) - (a.depreciation_rate || 0))[0];
    items.push(`有 <strong>${steep.length}</strong> 件已结算资产折旧率超过 60%，最惨的「<strong>${esc(worst.name)}</strong>」折旧率 <span class="warn">${worst.depreciation_rate}%</span>。`);
  }

  // ④ 保值/盈利亮点
  const winners = settled.filter((p) => (p.profit_loss || 0) >= 0);
  if (winners.length) {
    const best = [...winners].sort((a, b) => (b.profit_loss || 0) - (a.profit_loss || 0))[0];
    items.push(`保值亮点：「<strong>${esc(best.name)}</strong>」结算后 <span class="good">${best.profit_loss > 0 ? "+" : ""}${fmt(best.profit_loss)}</span>，${best.profit_loss > 0 ? "卖出即盈利" : "几乎零损耗"}。`);
  }

  // ⑤ 数据完整度
  const missing = allProducts.filter((p) => !p.brand || !p.category).length;
  if (missing) items.push(`还有 <strong>${missing}</strong> 件资产未填品牌或分类，补齐后「品牌/分类分布」图表会更准确。`);

  if (!items.length) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="insight-card">
      <h3>${icon("bulb")}智能洞察</h3>
      <ul class="insight-list">${items.map((t) => `<li>${t}</li>`).join("")}</ul>
    </div>`;
}

// ---------- 数据导入导出 ----------
function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

$("#btn-export-json").onclick = () => {
  const ts = new Date().toISOString().slice(0, 10);
  downloadFile(`/api/export?format=json&_=${Date.now()}`, `asset_tracker_${ts}.json`);
};

$("#btn-export-csv").onclick = () => {
  const ts = new Date().toISOString().slice(0, 10);
  downloadFile(`/api/export?format=csv&_=${Date.now()}`, `asset_tracker_${ts}.csv`);
};

$("#btn-import").onclick = () => $("#import-file").click();

$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const importMode = await uiDialog({
    title: "选择导入模式",
    message: `已选择文件「<strong>${esc(file.name)}</strong>」。请确认导入方式：`,
    actions: [
      { label: "取消", value: null, kind: "ghost" },
      { label: "覆盖导入", value: "replace", kind: "danger" },
      { label: "追加导入", value: "append", kind: "primary" },
    ],
  });
  e.target.value = "";
  if (!importMode) return;
  if (importMode === "replace") {
    const ok = await uiConfirm("确认覆盖导入", "覆盖导入会<span class=\"warn\">清空现有全部数据</span>后再导入，建议先导出备份。确定继续？", "继续覆盖");
    if (!ok) return;
  }

  const formData = new FormData();
  formData.append("file", file);
  formData.append("mode", importMode);

  toast("正在导入…", "loading", true);
  try {
    const res = await fetch("/api/import", { method: "POST", body: formData });
    const data = await res.json();
    hideToast();
    if (data.ok) {
      await uiDialog({
        title: "导入完成",
        message: `共 <strong>${data.total}</strong> 条，成功导入 <strong>${data.inserted}</strong> 条，跳过 ${data.skipped} 条<br/>模式：${importMode === "append" ? "追加" : "覆盖"}`,
        actions: [{ label: "知道了", value: true, kind: "primary" }],
      });
      loadProducts();
      if (document.querySelector('#tab-report').classList.contains('active')) {
        loadReport();
      }
    } else {
      await uiAlert("导入失败", data.msg || "未知错误");
    }
  } catch (err) {
    hideToast();
    await uiAlert("导入出错", esc(err.message));
  }
});

// ---------- 初始化 ----------
resetForm();
loadProducts();
