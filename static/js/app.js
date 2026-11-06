// ================= 数码资产持有成本管理系统 · 前端 =================
"use strict";


// ---------------- 全局状态 ----------------
const state = {
  products: [],
  chartScope: [],          // 报表时间范围过滤后的记录
  sortKey: "purchase_date",
  sortDir: "desc",
  expandedId: null,
  loading: true,
  range: "all",
  deleting: null,          // 待撤销删除的记录
  page: 1,                 // 当前页码（1 起）
  pageSize: 50,            // 每页条数
  pendingFilter: null,     // 待恢复的品牌/分类（要等下拉选项就绪）
  selected: new Set(),     // 批量操作选中的 id
  // 预购 / 待售清单
  wish: [],                // 预购记录
  wishBoard: null,         // 预购看板数据
  wishSort: { key: "target_price", dir: "desc" },
  following: [],           // 待售记录（products 中 status=for_sale 的子集）
  fsBoard: null,           // 待售看板数据
  fsSort: { key: "days_listed", dir: "desc" },
};

// 每页条数可选项：小数据集不分页，大数据集才分
const PAGE_SIZES = [50, 100, 200];
const PAGE_SIZE_KEY = "at_page_size";

const charts = Object.create(null);
const STATUS_TEXT = { in_use: "使用中", for_sale: "待售", sold: "已售出", damaged: "已损坏" };
const WISH_TEXT = { watching: "观望中", ready: "待下手", converted: "已转化", dropped: "已放弃" };
const PRIO_TEXT = { high: "很想要", normal: "一般", low: "观望" };

// ---------------- toast ----------------
let toastTimer = null;
function toast(msg, type = "", { sticky = false, action = null, duration = 2400 } = {}) {
  const el = $("#toast");
  $("#toast-msg").textContent = msg;
  el.classList.remove("success", "error", "loading");
  if (type) el.classList.add(type);
  el.classList.add("show");
  clearTimeout(toastTimer);

  const btn = $("#toast-action");
  if (action) {
    btn.hidden = false;
    btn.textContent = action.label;
    btn.onclick = () => { hideToast(); action.onClick(); };
  } else {
    btn.hidden = true;
    btn.onclick = null;
  }
  if (!sticky) toastTimer = setTimeout(hideToast, duration);
}
function hideToast() {
  clearTimeout(toastTimer);
  $("#toast").classList.remove("show");
}

// ---------------- 通用对话框 ----------------
let dialogResolve = null;
function uiDialog({ title = "", message = "", actions = [], danger = false }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    const t = $("#dialog-title");
    t.textContent = title;
    t.hidden = !title;
    const m = $("#dialog-msg");
    m.innerHTML = message;
    m.hidden = !message;
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
    pushFocusTrap($("#dialog-mask"));
    const focus = box.querySelector(".btn.danger") || box.querySelector(".btn.primary") || box.querySelector(".btn");
    if (focus) setTimeout(() => focus.focus(), 40);
  });
}
function closeDialog(value) {
  $("#dialog-mask").classList.remove("show");
  popFocusTrap();
  if (dialogResolve) { const r = dialogResolve; dialogResolve = null; r(value); }
}
function uiConfirm(title, message, okText = "确定", danger = false) {
  return uiDialog({
    title, message,
    actions: [
      { label: "取消", value: false, kind: "ghost" },
      { label: okText, value: true, kind: danger ? "danger" : "primary" },
    ],
  });
}
function uiAlert(title, message) {
  return uiDialog({ title, message, actions: [{ label: "知道了", value: true, kind: "primary" }] });
}
$("#dialog-mask").addEventListener("click", (e) => { if (e.target.id === "dialog-mask") closeDialog(null); });

// ---------------- 按钮加载态 ----------------
async function withLoading(btn, fn) {
  if (!btn || btn.dataset.busy) return;
  btn.dataset.busy = "1";
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add("loading");
  try { return await fn(); }
  finally {
    btn.classList.remove("loading");
    btn.disabled = wasDisabled;
    delete btn.dataset.busy;
  }
}

// ---------------- 表格内就地改价 ----------------
// 两个清单的高频动作都是"这个价我再想想"：挂单价试高试低、心理价一点点下移。
// 为此开整个编辑抽屉太重，所以金额单元格点一下直接变成输入框。
// 回车保存、Esc 取消、失焦保存（失焦只在值真的变了时才提交，避免顺手点别处也发请求）。
let _cellEdit = null;   // 当前正在编辑的单元格，同时只允许一个

function startCellEdit(td) {
  if (_cellEdit || td.classList.contains("locked")) return;
  const kind = td.dataset.edit;              // "wish" | "ask"
  const tr = td.closest("tr");
  const id = Number(kind === "wish" ? tr.dataset.wid : tr.dataset.id);
  const raw = td.textContent.replace(/[^\d.\-]/g, "").trim();
  const prev = raw === "" ? "" : raw;

  const input = document.createElement("input");
  input.type = "number";
  input.step = "0.01";
  input.min = "0";
  input.className = "cell-input";
  input.value = prev;
  input.setAttribute("aria-label", kind === "wish" ? "心理价" : "挂单价");

  td.classList.add("editing");
  td.textContent = "";
  td.appendChild(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit) => {
    if (done) return;
    done = true;
    _cellEdit = null;
    const value = commit ? input.value.trim() : null;
    const unchanged = value === null || value === "" || Math.abs(Number(value) - Number(prev || 0)) < 0.005;

    // 先收掉输入框，无论成功失败都要把单元格恢复成可读状态
    td.classList.remove("editing");
    td.textContent = prev === "" ? "—" : fmt(Number(prev));

    if (!commit || unchanged) return;
    if (value !== "" && (isNaN(Number(value)) || Number(value) < 0)) {
      toast("价格得是 0 或正数", "error");
      return;
    }

    td.classList.add("saving");
    try {
      const url = kind === "wish" ? `/api/wishlist/${id}/price` : `/api/products/${id}/ask`;
      const body = kind === "wish"
        ? { target_price: Number(value) }
        : { list_price: Number(value) };
      await api(url, "PATCH", body);
      // 重新拉一次，让 KPI / 看板 / 合计同步——改价会影响盈亏和预算口径
      if (kind === "wish") await loadWish({ silent: true });
      else { await loadProducts({ silent: true }); await loadForsale({ silent: true }); }
      toast("价格已更新", "success");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      td.classList.remove("saving");
    }
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
  });
  input.addEventListener("blur", () => finish(true));
  _cellEdit = { id, kind };
}

// ---------------- 品类图标 ----------------
const CATEGORY_RULES = [
  ["cat-phone", ["手机", "phone", "iphone", "红米", "一加", "真我", "pixel", "荣耀", "mate"]],
  ["cat-tablet", ["平板", "pad", "ipad", "tablet", "matepad", "学习机"]],
  ["cat-laptop", ["笔记本", "laptop", "macbook", "thinkpad", "拯救者", "轻薄本", "游戏本", "电脑"]],
  ["cat-monitor", ["显示器", "monitor", "显示屏", "屏幕"]],
  ["cat-headphone", ["耳机", "headphone", "earphone", "earbud", "airpods", "耳夹", "头戴", "tws", "降噪"]],
  ["cat-watch", ["手表", "watch", "手环", "band", "穿戴"]],
  ["cat-camera", ["相机", "camera", "单反", "微单", "gopro", "镜头"]],
  ["cat-keyboard", ["键盘", "keyboard"]],
  ["cat-mouse", ["鼠标", "mouse"]],
  ["cat-gamepad", ["游戏机", "switch", "ps5", "ps4", "xbox", "掌机", "steam", "手柄", "gamepad"]],
  ["cat-tv", ["电视", "投影", "tv", "projector"]],
  ["cat-speaker", ["音箱", "音响", "喇叭", "speaker", "homepod"]],
  ["cat-battery", ["充电", "移动电源", "充电宝", "电源", "powerbank", "battery"]],
  ["cat-glasses", ["眼镜", "glasses", "glass"]],
  ["cat-nas", ["nas", "群晖", "飞牛", "威联通", "存储"]],
  ["cat-chip", ["主板", "cpu", "显卡", "内存", "硬盘", "ssd", "芯片"]],
];
function categoryIcon(cat) {
  const c = String(cat || "").toLowerCase().trim();
  if (c) for (const [name, kws] of CATEGORY_RULES) if (kws.some((k) => c.includes(k))) return name;
  return "box";
}

// ---------------- 自定义字段行 ----------------
function renderCustoms(obj = {}) {
  const box = $("#custom-list");
  box.innerHTML = "";
  Object.entries(obj).forEach(([k, v]) => addCustomRow(k, v));
  syncCustomHint();
}
function addCustomRow(key = "", val = "") {
  const box = $("#custom-list");
  const div = document.createElement("div");
  div.className = "custom-item";
  div.innerHTML = `
    <input class="ck" placeholder="字段名" value="${esc(key)}" maxlength="40" aria-label="自定义字段名">
    <input class="cv" placeholder="值" value="${esc(val)}" maxlength="200" aria-label="自定义字段值">
    <button class="del" type="button" title="删除该字段" aria-label="删除该字段">${icon("close")}</button>`;
  div.querySelector(".del").onclick = () => { div.remove(); syncCustomHint(); };
  box.appendChild(div);
  syncCustomHint();
  return div;
}
function syncCustomHint() {
  const n = $$("#custom-list .custom-item").length;
  const hint = $("#custom-hint");
  if (hint) hint.hidden = n > 0;
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

// ---------------- 表单 ----------------
function resetForm() {
  $("#form-title").textContent = "录入新资产";
  $("#form-sub").textContent = "填写名称、价格与购买日期，成本会实时算出";
  $("#f-id").value = "";
  ["f-name", "f-brand", "f-category", "f-price", "f-config", "f-notes"].forEach((id) => {
    const el = $("#" + id); el.value = ""; el.classList.remove("invalid");
  });
  $("#f-pdate").value = today();
  renderCustoms({});
  updateCostPreview();
}
function fillForm(p) {
  $("#form-title").textContent = "编辑资产";
  $("#form-sub").textContent = p.name || "";
  $("#f-id").value = p.id;
  $("#f-name").value = p.name || "";
  $("#f-brand").value = p.brand || "";
  $("#f-category").value = p.category || "";
  $("#f-price").value = p.price ?? "";
  $("#f-pdate").value = p.purchase_date || "";
  $("#f-config").value = p.config || "";
  $("#f-notes").value = p.notes || "";
  ["f-name", "f-price", "f-pdate"].forEach((id) => $("#" + id).classList.remove("invalid"));
  renderCustoms(p.custom_fields || {});
  updateCostPreview();
}
function collectForm() {
  const idVal = $("#f-id").value;
  return {
    id: idVal ? Number(idVal) : null,
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
// 实时成本预览
function updateCostPreview() {
  const price = Number($("#f-price").value);
  const pdate = $("#f-pdate").value;
  const dailyEl = $("#cp-daily"), daysEl = $("#cp-days"), yearEl = $("#cp-year");
  if (!pdate || !(price > 0)) {
    dailyEl.textContent = "—"; daysEl.textContent = "—"; yearEl.textContent = "—";
    return;
  }
  const days = daysBetween(pdate, today());
  const daily = price / days;
  daysEl.textContent = fmtNum(days);
  dailyEl.textContent = fmt(daily, { decimals: 2 }) + "/天";
  yearEl.textContent = fmt(daily * 365);
}

// ---------------- 抽屉 ----------------
function openDrawer(mode = "create", p = null) {
  if (mode === "edit" && p) fillForm(p); else resetForm();
  $("#drawer-mask").classList.add("show");
  $("#drawer").classList.add("show");
  document.body.style.overflow = "hidden";
  pushFocusTrap($("#drawer"));
  setTimeout(() => $("#f-name").focus(), 300);
}
function closeDrawer() {
  $("#drawer-mask").classList.remove("show");
  $("#drawer").classList.remove("show");
  document.body.style.overflow = "";
  popFocusTrap();
}

// ---------------- 数据加载 ----------------
function showSkeleton() {
  const n = 6;
  $("#asset-body").innerHTML = Array.from({ length: n }, () => `
    <tr class="skeleton-row">
      <td></td>
      <td><div class="sk" style="width:72%"></div><div class="sk" style="width:44%;margin-top:6px;height:8px"></div></td>
      <td><div class="sk" style="width:52%"></div></td>
      <td><div class="sk" style="width:60%;margin-left:auto"></div></td>
      <td><div class="sk" style="width:70%;margin-left:auto"></div></td>
      <td><div class="sk" style="width:44%;margin-left:auto"></div></td>
      <td><div class="sk" style="width:64%;margin-left:auto"></div></td>
      <td><div class="sk" style="width:50%;margin-left:auto"></div></td>
      <td><div class="sk" style="width:44%"></div></td>
      <td><div class="sk" style="width:80%;margin-left:auto"></div></td>
    </tr>`).join("");
  $("#asset-foot").innerHTML = "";
  $("#empty-tip").hidden = true;
}

async function loadProducts({ silent = false } = {}) {
  if (!silent) { state.loading = true; showSkeleton(); }
  try {
    const res = await api("/api/products");
    state.products = res.data || [];
    state.loading = false;
    // 待售清单是 products 的子集，主数据刷新时一并同步，避免两个页签口径不一致
    state.following = state.products.filter((p) => p.status === "for_sale");
    syncFilterOptions();
    renderTable();
    renderKpi();
    if ($("#tab-report").classList.contains("active")) loadReport();
    if ($("#tab-forsale").classList.contains("active")) loadForsale();
    else renderForsaleTable();
  } catch (e) {
    state.loading = false;
    $("#asset-body").innerHTML = "";
    $("#empty-tip").hidden = false;
    // renderEmptyState 在有数据时会残留 inline display:none，必须显式打开，
    // 否则失败重试面板永远不可见
    $("#empty-tip").style.display = "flex";
    $("#empty-tip").innerHTML = `
      <div class="empty-ic">${icon("close")}</div>
      <h3>数据加载失败</h3>
      <p>${esc(e.message)}</p>
      <button class="btn ghost" id="empty-retry">重新加载</button>`;
    $("#empty-retry").onclick = () => loadProducts();
    toast(e.message, "error");
  }
}

// ---------------- 筛选下拉 ----------------
function syncFilterOptions() {
  const brands = [...new Set(state.products.map((p) => p.brand).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
  const cats = [...new Set(state.products.map((p) => p.category).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));

  const brandSel = $("#filter-brand"), catSel = $("#filter-category");
  const bv = brandSel.value, cv = catSel.value;
  brandSel.innerHTML = '<option value="">全部品牌</option>' +
    brands.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join("");
  catSel.innerHTML = '<option value="">全部分类</option>' +
    cats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join("");
  if (brands.includes(bv)) brandSel.value = bv;
  if (cats.includes(cv)) catSel.value = cv;

  // 首次加载时把持久化的品牌 / 分类筛选恢复回来（此时选项才存在）
  if (state.pendingFilter) {
    const pf = state.pendingFilter;
    state.pendingFilter = null;
    if (pf.brand && brands.includes(pf.brand)) brandSel.value = pf.brand;
    if (pf.cat && cats.includes(pf.cat)) catSel.value = pf.cat;
  }

  // 表单里的品牌/分类联想
  $("#brand-options").innerHTML = brands.map((b) => `<option value="${esc(b)}">`).join("");
  $("#category-options").innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join("");

  // chips 计数
  const count = { all: state.products.length, in_use: 0, for_sale: 0, sold: 0, damaged: 0 };
  state.products.forEach((p) => { if (count[p.status] !== undefined) count[p.status]++; });
  $$("#status-chips .chip").forEach((chip) => {
    const n = chip.querySelector(".chip-n");
    if (n) n.textContent = count[n.dataset.c] ?? 0;
  });

  // 待售页签角标
  updateTabBadges();
}

// ---------------- KPI 条 ----------------
function renderKpi() {
  const all = state.products;
  const holding = all.filter((p) => isHolding(p));
  const settled = all.filter((p) => p.profit_loss !== null && p.profit_loss !== undefined);
  const heldValue = holding.reduce((s, p) => s + (Number(p.price) || 0), 0);
  const dailyTotal = holding.reduce((s, p) => s + (Number(p.daily_cost) || 0), 0);
  const pnl = settled.reduce((s, p) => s + (Number(p.profit_loss) || 0), 0);
  const nForSale = all.filter((p) => p.status === "for_sale").length;

  const strip = $("#kpi-strip");
  if (!all.length) { strip.innerHTML = ""; strip.hidden = true; return; }
  strip.hidden = false;
  strip.innerHTML = `
    <div class="kpi kpi-click" data-filter="in_use" role="button" tabindex="0" title="点击在列表中只看使用中的资产">
      <span class="kpi-label">${icon("wallet")}持有资产总额</span>
      <strong class="kpi-value">${fmt(heldValue)}</strong>
      <span class="kpi-sub">${holding.length} 件在持${nForSale ? ` · 含待售 ${nForSale}` : ""}</span>
    </div>
    <div class="kpi kpi-click" data-goto="report" role="button" tabindex="0" title="点击查看报表分析">
      <span class="kpi-label">${icon("activity")}每日持有成本</span>
      <strong class="kpi-value a">${fmt(dailyTotal, { decimals: 2 })}</strong>
      <span class="kpi-sub">年化约 ${fmt(dailyTotal * 365)}</span>
    </div>
    <div class="kpi kpi-click" data-filter="" role="button" tabindex="0" title="点击查看全部资产">
      <span class="kpi-label">${icon("trend-up")}累计投入</span>
      <strong class="kpi-value">${fmt(all.reduce((s, p) => s + (Number(p.price) || 0), 0))}</strong>
      <span class="kpi-sub">共 ${all.length} 件 · 历史合计</span>
    </div>
    <div class="kpi kpi-click" data-filter="sold" role="button" tabindex="0" title="点击在列表中只看已售出的资产">
      <span class="kpi-label">${icon(pnl >= 0 ? "trend-up" : "trend-down")}已结算盈亏</span>
      <strong class="kpi-value ${pnl > 0 ? "g" : pnl < 0 ? "r" : ""}">${fmtPnl(pnl)}</strong>
      <span class="kpi-sub">已处理 ${settled.length} 件</span>
    </div>`;
}

// KPI 卡点击联动：data-filter 切状态筛选，data-goto 跳页签
function kpiAction(card) {
  if (card.dataset.filter !== undefined && card.dataset.filter !== null && card.hasAttribute("data-filter")) {
    const st = card.dataset.filter;
    $$("#status-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.status === st));
    state.page = 1;
    renderTable();
  } else if (card.dataset.goto) {
    activateTab(card.dataset.goto);
  }
}
$("#kpi-strip").addEventListener("click", (e) => {
  const card = e.target.closest(".kpi.kpi-click");
  if (card) kpiAction(card);
});
$("#kpi-strip").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const card = e.target.closest(".kpi.kpi-click");
  if (card) { e.preventDefault(); kpiAction(card); }
});

// ---------------- 表格 ----------------
function sortList(list) {
  if (!state.sortKey) return list;
  const key = state.sortKey;
  const dir = state.sortDir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    let va = a[key], vb = b[key];
    const aNull = va === null || va === undefined || va === "";
    const bNull = vb === null || vb === undefined || vb === "";
    if (aNull && bNull) return 0;
    if (aNull) return 1;   // 空值恒排最后，不受方向影响
    if (bNull) return -1;
    if (typeof va === "string") return va.localeCompare(vb, "zh-CN") * dir;
    return (va - vb) * dir;
  });
}
function updateSortArrows() {
  $$("#asset-table th.sortable").forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    const active = th.dataset.sort === state.sortKey;
    th.classList.toggle("sorted", active);
    if (arrow) arrow.textContent = active ? (state.sortDir === "asc" ? "▲" : "▼") : "↕";
    th.setAttribute("aria-sort", active ? (state.sortDir === "asc" ? "ascending" : "descending") : "none");
  });
}

function renderDetailContent(p) {
  const customs = Object.entries(p.custom_fields || {});
  let html = `<div class="detail-content"><div class="detail-grid">`;
  html += `<div class="detail-item"><span class="detail-label">分类</span><span class="detail-value">${esc(p.category) || "—"}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">配置</span><span class="detail-value">${esc(p.config) || "—"}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">购买时间</span><span class="detail-value num">${p.purchase_date || "—"}</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">已持有</span><span class="detail-value num">${fmtNum(p.days_held)} 天</span></div>`;
  html += `<div class="detail-item"><span class="detail-label">购入单价 / 日均</span><span class="detail-value num">${fmt(p.price)} / ${fmt(p.daily_cost, { decimals: 2 })}</span></div>`;

  if (p.status === "for_sale") {
    // 待售：显示挂单价与预期盈亏，而不是结算信息
    html += `<div class="detail-item"><span class="detail-label">上架日期</span><span class="detail-value num">${p.list_date || "—"}</span></div>`;
    html += `<div class="detail-item"><span class="detail-label">已挂时长</span><span class="detail-value num">${fmtNum(p.days_listed)} 天</span></div>`;
    html += `<div class="detail-item"><span class="detail-label">挂单报价</span><span class="detail-value num">${fmt(p.list_price)}</span></div>`;
    html += `<div class="detail-item"><span class="detail-label">按报价成交盈亏</span><span class="detail-value num">${fmtPnl(p.list_pnl)}</span></div>`;
  } else if (p.status !== "in_use") {
    html += `<div class="detail-item"><span class="detail-label">处理日期</span><span class="detail-value num">${p.sale_date || "—"}</span></div>`;
    if (p.status === "sold") {
      html += `<div class="detail-item"><span class="detail-label">出售价格</span><span class="detail-value num">${fmt(p.sale_price)}</span></div>`;
    }
    html += `<div class="detail-item"><span class="detail-label">折旧金额</span><span class="detail-value num">${fmt(p.depreciation)}</span></div>`;
    html += `<div class="detail-item"><span class="detail-label">最终日均成本</span><span class="detail-value num">${fmt(p.final_holding_cost, { decimals: 2 })}/天</span></div>`;
    const rate = Number(p.depreciation_rate) || 0;
    html += `<div class="detail-item"><span class="detail-label">折旧率</span>
      <span class="detail-value"><span class="dep-bar"><span class="dep-track"><span class="dep-fill" style="width:${Math.min(100, rate)}%"></span></span><b class="num">${rate}%</b></span></span></div>`;
  }
  html += `</div>`;

  if (customs.length) {
    html += `<div class="detail-section"><h4>自定义字段</h4><div class="detail-grid">`;
    customs.forEach(([k, v]) => {
      html += `<div class="detail-item"><span class="detail-label">${esc(k)}</span><span class="detail-value">${esc(v) || "—"}</span></div>`;
    });
    html += `</div></div>`;
  }
  if (p.notes) {
    html += `<div class="detail-section"><h4>备注</h4><p class="detail-notes">${esc(p.notes)}</p></div>`;
  }
  html += `</div>`;
  return html;
}

// 页脚只会渲染「核心列」（勾选/展开/名称/价格/日均/盈亏），
// 其余列若可见就用一个 colspan 占位，列数必须与当前可见列数一致。
function renderFooter(list) {
  const foot = $("#asset-foot");
  if (!list.length) { foot.innerHTML = ""; return; }
  // 合计永远按「筛选后的全部记录」算，不是当前这一页——
  // 否则翻到第 3 页会看到合计突然变小，那是明显的错。
  const totalPrice = list.reduce((s, p) => s + (Number(p.price) || 0), 0);
  const holding = list.filter((p) => isHolding(p));
  const dailyTotal = holding.reduce((s, p) => s + (Number(p.daily_cost) || 0), 0);
  const settled = list.filter((p) => p.profit_loss !== null && p.profit_loss !== undefined);
  const pnlTotal = settled.reduce((s, p) => s + (Number(p.profit_loss) || 0), 0);
  const pnlCls = pnlTotal > 0 ? "pnl profit" : pnlTotal < 0 ? "pnl loss" : "pnl flat";

  // 页脚占用的列：1 勾选 / 2 展开 / 3-4 名称 / 5 价格 / 6-7 购买+持有 / 8 日均 / 9 盈亏 / 10 状态 / 11 操作
  const hidden = hiddenCols();
  const vis = (key) => !hidden.has(key);
  // 名称(3) + 品牌(4) 合并成合计标签
  const nameSpan = 1 + (vis("brand") ? 1 : 0);
  // 价格(5) 之后到 日均(8) 之前的空隙：购买(6) + 持有(7)
  const midSpan = (vis("purchase_date") ? 1 : 0) + (vis("days_held") ? 1 : 0);
  // 盈亏(9) 之后：状态(10) + 操作(11)
  const tailSpan = (vis("status") ? 1 : 0) + 1;

  foot.innerHTML = `
    <tr>
      <td></td>
      <td></td>
      <td colspan="${nameSpan}" class="sum-label">共 ${list.length} 件合计</td>
      <td class="price num">${fmt(totalPrice)}</td>
      <td colspan="${midSpan}" class="foot-mid"></td>
      <td class="daily num">${fmt(dailyTotal, { decimals: 2 })}/天</td>
      <td class="${pnlCls} num">${settled.length ? fmtPnl(pnlTotal) : "—"}</td>
      <td colspan="${tailSpan}"></td>
    </tr>`;
}

function renderEmptyState(visibleCount, filtered) {
  const tip = $("#empty-tip");
  const wrap = $(".table-wrap");
  if (visibleCount > 0) {
    tip.hidden = true; tip.innerHTML = "";
    tip.style.display = "none";
    return;
  }
  tip.style.display = "flex";
  tip.hidden = false;
  if (!state.products.length) {
    tip.innerHTML = `
      <div class="empty-ic">${icon("box")}</div>
      <h3>还没有任何资产</h3>
      <p>记录第一件数码产品，系统会自动算清每天的持有成本。</p>
      <button class="btn primary" id="empty-add">${icon("plus")}新增资产</button>`;
    $("#empty-add").onclick = () => openDrawer("create");
  } else {
    tip.innerHTML = `
      <div class="empty-ic">${icon("search")}</div>
      <h3>没有匹配的资产</h3>
      <p>当前筛选条件下没有结果，试着放宽条件或搜索其他关键词。</p>
      <button class="btn ghost" id="empty-clear">${icon("close")}清除全部筛选</button>`;
    $("#empty-clear").onclick = clearFilters;
  }
}

function renderTable() {
  const kw = $("#filter-kw").value.trim().toLowerCase();
  const st = currentStatus();
  const br = $("#filter-brand").value;
  const cat = $("#filter-category").value;

  let list = state.products.filter((p) => {
    if (st && p.status !== st) return false;
    if (br && p.brand !== br) return false;
    if (cat && p.category !== cat) return false;
    if (kw) {
      const hay = [p.name, p.brand, p.category, p.config, p.notes, Object.values(p.custom_fields || {}).join(" ")]
        .join(" ").toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  list = sortList(list);

  const filtered = !!(kw || st || br || cat);
  renderActiveFilters({ kw, st, br, cat });
  $("#asset-count").textContent = filtered ? `${list.length} / ${state.products.length} 件` : `${state.products.length} 件`;

  // ---- 分页切片 ----
  // 排序开销只有几毫秒，真正贵的是把每一行都塞进 DOM：
  // 5000 行 = 20 万个节点 / 8.9 MB HTML，而屏幕只看得见十几行。
  // 所以只渲染当前这一页，其余留在内存里。
  const pageSize = state.pageSize;
  const totalPages = Math.max(1, Math.ceil(list.length / pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const startIdx = (state.page - 1) * pageSize;
  const pageItems = list.slice(startIdx, startIdx + pageSize);

  const tbody = $("#asset-body");
  tbody.innerHTML = "";
  renderEmptyState(list.length, filtered);

  if (pageItems.length) {
    const frag = document.createDocumentFragment();
    pageItems.forEach((p) => {
      const isExpanded = state.expandedId === p.id;
      const tr = document.createElement("tr");
      if (isExpanded) tr.classList.add("expanded");
      tr.dataset.id = p.id;
      const isSel = state.selected.has(p.id);
      if (isSel) tr.classList.add("selected");
      tr.innerHTML = `
        <td class="col-check"><input type="checkbox" class="row-check" data-check="${p.id}"${isSel ? " checked" : ""} aria-label="选择 ${esc(p.name)}"></td>
        <td class="col-expand"><button class="expand-btn" data-act="expand" title="展开详情" aria-label="展开详情" aria-expanded="${isExpanded}">${icon("chevron")}</button></td>
        <td>
          <div class="cat-cell">
            <span class="cat-chip" title="${esc(p.category) || "未分类"}">${icon(categoryIcon(p.category))}</span>
            <div class="cell-name">
              <strong title="${esc(p.name)}">${esc(p.name)}</strong>
              ${p.config ? `<span class="cell-sub" title="${esc(p.config)}">${esc(p.config)}</span>` : ""}
              <span class="cell-mobile-meta">
                <span class="badge ${p.status}">${STATUS_TEXT[p.status] || p.status}</span>
                <span class="mmm-dot">·</span><span class="num">${p.purchase_date || "—"}</span>
                <span class="mmm-dot">·</span><span class="num">${fmtNum(p.days_held)} 天</span>
              </span>
            </div>
          </div>
        </td>
        <td class="muted">${esc(p.brand) || "—"}</td>
        <td class="price num">${fmt(p.price)}</td>
        <td class="num muted">${p.purchase_date || "—"}</td>
        <td class="num">${fmtNum(p.days_held)} 天</td>
        <td class="daily daily-${p.status} num">${fmt(p.daily_cost, { decimals: 2 })}</td>
        <td class="num">${pnlCell(p)}</td>
        <td><span class="badge ${p.status}">${STATUS_TEXT[p.status] || p.status}</span></td>
        <td class="col-ops">
          <div class="row-ops">
            ${p.status === "in_use" ? `
              <button class="op-btn" data-act="list" title="挂入待售清单">${icon("tag")}<span class="op-label">待售</span></button>
              <button class="op-btn" data-act="sell" title="登记出售或损坏">${icon("sell")}<span class="op-label">处理</span></button>
            ` : p.status === "for_sale" ? `
              <button class="op-btn" data-act="sell" title="登记售出">${icon("sell")}<span class="op-label">售出</span></button>
              <button class="op-btn restore" data-act="unlist" title="从待售清单下架">${icon("restore")}<span class="op-label">下架</span></button>
            ` : `
              <button class="op-btn restore" data-act="sell" title="恢复为使用中">${icon("restore")}<span class="op-label">恢复</span></button>
            `}
            <button class="icon-btn" data-act="edit" title="编辑" aria-label="编辑">${icon("edit")}</button>
            <button class="icon-btn danger" data-act="del" title="删除" aria-label="删除">${icon("trash")}</button>
          </div>
        </td>`;
      frag.appendChild(tr);

      if (isExpanded) {
        const detailTr = document.createElement("tr");
        detailTr.className = "detail-row";
        detailTr.innerHTML = `<td></td><td></td><td colspan="9">${renderDetailContent(p)}</td>`;
        frag.appendChild(detailTr);
      }
    });
    tbody.appendChild(frag);
  }

  renderFooter(list);
  renderPager(list.length, totalPages, startIdx, pageItems.length);
  updateBatchBar();
  syncCheckAll();
  updateSortArrows();
  writeHash();
}

// 分页条：首页 / 上一页 / 页码 / 下一页 / 末页 + 每页条数
function renderPager(total, totalPages, startIdx, shown) {
  const box = $("#asset-pager");
  if (!box) return;
  // 数据少于一页时不显示分页条，避免一堆没用的按钮
  if (total <= state.pageSize || totalPages <= 1) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;

  const cur = state.page;
  // 页码窗口：当前页左右各 1，加上首尾和省略号
  const nums = [];
  const push = (n) => { if (!nums.includes(n)) nums.push(n); };
  push(1);
  for (let i = cur - 1; i <= cur + 1; i++) if (i > 1 && i < totalPages) push(i);
  push(totalPages);
  nums.sort((a, b) => a - b);

  let pagesHtml = "";
  nums.forEach((n, i) => {
    if (i && n - nums[i - 1] > 1) pagesHtml += `<span class="pager-gap">…</span>`;
    pagesHtml += `<button class="pager-btn num-btn${n === cur ? " active" : ""}" data-page="${n}"
      aria-label="第 ${n} 页"${n === cur ? ' aria-current="page"' : ""}>${n}</button>`;
  });

  const from = startIdx + 1;
  const to = startIdx + shown;

  box.innerHTML = `
    <div class="pager-info">
      第 <b>${from}</b>–<b>${to}</b> 条，共 <b>${total}</b> 条
    </div>
    <div class="pager-nav">
      <button class="pager-btn" data-page="${cur - 1}" ${cur === 1 ? "disabled" : ""} aria-label="上一页">上一页</button>
      ${pagesHtml}
      <button class="pager-btn" data-page="${cur + 1}" ${cur === totalPages ? "disabled" : ""} aria-label="下一页">下一页</button>
    </div>
    <label class="pager-size">
      每页
      <select id="page-size">
        ${PAGE_SIZES.map((n) => `<option value="${n}"${n === state.pageSize ? " selected" : ""}>${n}</option>`).join("")}
      </select>
      条
    </label>`;
}

$("#asset-pager").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-page]");
  if (!btn || btn.disabled) return;
  const n = Number(btn.dataset.page);
  if (!Number.isFinite(n) || n === state.page) return;
  state.page = n;
  renderTable();
  // 翻页后回到表格顶部，否则停在上一页的位置会看不到内容
  const wrap = $(".table-wrap");
  if (wrap) wrap.scrollIntoView({ block: "start", behavior: "smooth" });
});

$("#asset-pager").addEventListener("change", (e) => {
  if (e.target.id !== "page-size") return;
  state.pageSize = Number(e.target.value) || 50;
  state.page = 1;
  try { localStorage.setItem(PAGE_SIZE_KEY, String(state.pageSize)); } catch (err) {}
  renderTable();
});

function pnlCell(p) {
  if (p.profit_loss === null || p.profit_loss === undefined) {
    return `<span class="pnl pending" title="持有中，尚未结算">持有中</span>`;
  }
  const v = Number(p.profit_loss);
  const cls = v > 0 ? "profit" : v < 0 ? "loss" : "flat";
  return `<span class="pnl ${cls} num" title="${v > 0 ? "盈利" : v < 0 ? "亏损" : "持平"}">${fmtPnl(v)}</span>`;
}

function renderActiveFilters({ kw, st, br, cat }) {
  const box = $("#active-filters");
  const tags = [];
  if (kw) tags.push({ k: "kw", t: `关键词：${kw}` });
  if (st) tags.push({ k: "status", t: `状态：${STATUS_TEXT[st]}` });
  if (br) tags.push({ k: "brand", t: `品牌：${br}` });
  if (cat) tags.push({ k: "category", t: `分类：${cat}` });
  if (!tags.length) { box.hidden = true; box.innerHTML = ""; return; }
  box.hidden = false;
  box.innerHTML = `<span>已筛选</span>` +
    tags.map((x) => `<span class="filter-tag">${esc(x.t)}<button class="icon-btn" data-clear="${x.k}" aria-label="移除该筛选" style="width:16px;height:16px">${icon("close")}</button></span>`).join("") +
    `<button class="filter-clear" id="clear-all-filters">全部清除</button>`;
}

function currentStatus() {
  const active = $("#status-chips .chip.active");
  return active ? active.dataset.status : "";
}

function clearFilters() {
  $("#filter-kw").value = "";
  $$("#status-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.status === ""));
  $("#filter-brand").value = "";
  $("#filter-category").value = "";
  state.page = 1;
  try { localStorage.removeItem(FILTER_KEY); } catch (e) {}
  renderTable();
}

// ---------------- 批量操作 ----------------
function selectedItems() {
  return state.products.filter((p) => state.selected.has(p.id));
}

function updateBatchBar() {
  const bar = $("#batch-bar");
  if (!bar) return;
  const n = state.selected.size;
  if (!n) {
    bar.hidden = true;
    bar.innerHTML = "";
    return;
  }
  bar.hidden = false;
  const items = selectedItems();
  const amount = items.reduce((s, p) => s + (Number(p.price) || 0), 0);
  bar.innerHTML = `
    <span class="batch-count">已选 <b>${n}</b> 项</span>
    <span class="batch-sum">购入价合计 <b>${fmt(amount)}</b></span>
    <div class="batch-ops">
      <button class="btn ghost sm" data-batch="sell">${icon("sell")}批量处理</button>
      <button class="btn ghost sm danger" data-batch="del">${icon("trash")}批量删除</button>
      <button class="btn ghost sm" data-batch="clear">取消选择</button>
    </div>`;
}

function syncCheckAll() {
  const box = $("#check-all");
  if (!box) return;
  const rows = $$("#asset-body tr[data-id]");
  const visibleIds = rows.map((r) => Number(r.dataset.id));
  const selOnPage = visibleIds.filter((id) => state.selected.has(id));
  box.checked = visibleIds.length > 0 && selOnPage.length === visibleIds.length;
  box.indeterminate = selOnPage.length > 0 && selOnPage.length < visibleIds.length;
}

$("#check-all").addEventListener("change", (e) => {
  const on = e.target.checked;
  $$("#asset-body tr[data-id]").forEach((tr) => {
    const id = Number(tr.dataset.id);
    if (on) state.selected.add(id); else state.selected.delete(id);
    const cb = tr.querySelector(".row-check");
    if (cb) cb.checked = on;
    tr.classList.toggle("selected", on && state.selected.has(id));
  });
  updateBatchBar();
  syncCheckAll();
});

$("#asset-body").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-check]");
  if (!cb) return;
  const id = Number(cb.dataset.check);
  if (cb.checked) state.selected.add(id); else state.selected.delete(id);
  const tr = cb.closest("tr");
  if (tr) tr.classList.toggle("selected", cb.checked);
  updateBatchBar();
  syncCheckAll();
});

$("#batch-bar").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-batch]");
  if (!btn) return;
  const act = btn.dataset.batch;

  if (act === "clear") {
    state.selected.clear();
    renderTable();
    updateBatchBar();
    return;
  }

  if (act === "del") {
    const ids = [...state.selected];
    const ok = await uiConfirm(
      "批量删除",
      `确定删除选中的 <strong>${ids.length}</strong> 条资产？此操作直接生效，不提供撤销。`,
      "全部删除", true
    );
    if (!ok) return;
    await withLoading(btn, async () => {
      let okCount = 0, failCount = 0;
      for (const id of ids) {
        try {
          await api(`/api/products/${id}`, "DELETE");
          okCount++;
        } catch (err) {
          failCount++;
        }
      }
      state.selected.clear();
      if (state.expandedId && ids.includes(state.expandedId)) state.expandedId = null;
      await loadProducts({ silent: true });
      updateBatchBar();
      toast(failCount ? `已删除 ${okCount} 条，${failCount} 条失败` : `已删除 ${okCount} 条`,
            failCount ? "error" : "success");
    });
    return;
  }

  if (act === "sell") {
    const ids = [...state.selected];
    // 复用单个处理弹窗，但把目标改成这一批
    sellTarget = { __batch: ids };
    openSellModal({ name: `选中的 ${ids.length} 条资产`, price: 0, status: "in_use" }, { batchIds: ids });
  }
});

// ---------------- 表格事件 ----------------
$("#asset-body").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const tr = btn.closest("tr");
  const id = Number(tr.dataset.id);
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const act = btn.dataset.act;

  if (act === "expand") {
    state.expandedId = state.expandedId === id ? null : id;
    renderTable();
  } else if (act === "edit") {
    openDrawer("edit", p);
  } else if (act === "list") {
    openListModal(p);
  } else if (act === "unlist") {
    const ok = await uiConfirm(
      "下架",
      `把「<strong>${esc(p.name)}</strong>」从待售清单拿回来，恢复为使用中？`,
      "确认下架"
    );
    if (!ok) return;
    await withLoading(btn, async () => {
      try {
        await api(`/api/products/${id}/unlist`, "POST");
        await loadProducts({ silent: true });
        toast("已下架，恢复为使用中", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  } else if (act === "sell") {
    openSellModal(p);
  } else if (act === "del") {
    const ok = await uiConfirm(
      "删除资产",
      `确定删除「<strong>${esc(p.name)}</strong>」？删除后可在提示条里撤销。`,
      "删除", true
    );
    if (!ok) return;
    await withLoading(btn, async () => {
      try {
        const res = await api(`/api/products/${id}`, "DELETE");
        if (state.expandedId === id) state.expandedId = null;
        state.deleting = res.deleted || p;
        await loadProducts({ silent: true });
        toast("已删除", "success", {
          duration: 6000,
          action: { label: "撤销", onClick: undoDelete },
        });
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
});

async function undoDelete() {
  const rec = state.deleting;
  if (!rec) return;
  state.deleting = null;
  try {
    await api("/api/products/restore", "POST", rec);
    await loadProducts({ silent: true });
    toast("已恢复该资产", "success");
  } catch (e) {
    toast(e.message, "error");
  }
}

$("#active-filters").addEventListener("click", (e) => {
  if (e.target.closest("#clear-all-filters")) { clearFilters(); return; }
  const btn = e.target.closest("[data-clear]");
  if (!btn) return;
  const k = btn.dataset.clear;
  if (k === "kw") $("#filter-kw").value = "";
  if (k === "status") $$("#status-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.status === ""));
  if (k === "brand") $("#filter-brand").value = "";
  if (k === "category") $("#filter-category").value = "";
  // 走 FromFirstPage：写回 localStorage 且重置到第 1 页，与 chips/下拉的路径一致
  renderTableFromFirstPage();
});

$("#asset-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.sort;
  if (state.sortKey === key) state.sortDir = state.sortDir === "asc" ? "desc" : "asc";
  else { state.sortKey = key; state.sortDir = key === "name" || key === "brand" || key === "status" ? "asc" : "desc"; }
  state.page = 1;   // 换排序后仍停在原页码会让用户以为数据丢了
  renderTable();
});

// ---------------- 出售 / 损坏 ----------------
let sellTarget = null;
let sellStatus = "sold";
let sellBatchIds = null;   // 批量处理时的 id 列表

function setSellStatus(s) {
  sellStatus = s;
  $$("#m-status .seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.status === s));
  $("#m-price-wrap").style.display = s === "sold" ? "" : "none";
  updateSettlePreview();
}

function openSellModal(p, { batchIds = null } = {}) {
  sellTarget = p;
  sellBatchIds = batchIds;
  $("#m-id").value = p.id || "";
  $("#m-price").value = "";
  $("#m-price").classList.remove("invalid");
  const confirmBtn = $("#modal-confirm");
  // 只有「已结算」（售出 / 损坏）才需要恢复；待售是持有状态，点它就是要售出
  const isRestore = !batchIds && !isHolding(p);

  $("#modal-title").textContent = isRestore ? "恢复为使用中" : (batchIds ? "批量登记处理" : "登记处理");
  $("#modal-summary").innerHTML = batchIds
    ? `<span class="ms-icon">${icon("layers")}</span>
       <span class="ms-body">
         <span class="ms-name">已选择 ${batchIds.length} 条资产</span>
         <span class="ms-meta">它们会统一按下面的状态与日期处理</span>
       </span>`
    : `<span class="ms-icon">${icon(categoryIcon(p.category))}</span>
    <span class="ms-body">
      <span class="ms-name">${esc(p.name)}</span>
      <span class="ms-meta">购入 ${fmt(p.price)} · ${p.purchase_date} · 已持有 ${fmtNum(p.days_held)} 天${
        p.status === "for_sale" && p.list_date
          ? ` · 已挂 ${fmtNum(p.days_listed)} 天${p.list_price ? ` · 报价 ${fmt(p.list_price)}` : ""}`
          : ""
      }</span>
    </span>`;

  if (!isRestore) {
    confirmBtn.textContent = batchIds ? `确认处理 ${batchIds.length} 条` : "确认登记";
    confirmBtn.dataset.mode = "process";
    $("#m-date").value = today();
    // 待售资产的上架日期是下限，处理日期不能早于它
    $("#m-date").min = p.status === "for_sale" && p.list_date ? p.list_date : "";
    $("#m-status-wrap").style.display = "";
    $("#m-date-wrap").style.display = "";
    // 待售资产点「售出」就是要卖，隐藏损坏选项避免误选；
    // 批量模式下不动，保留两种结果可选
    $("#m-status-wrap").style.display = (!batchIds && p.status === "for_sale") ? "none" : "";
    setSellStatus("sold");
  } else {
    confirmBtn.textContent = "恢复为使用中";
    confirmBtn.dataset.mode = "restore";
    $("#m-status-wrap").style.display = "none";
    $("#m-date-wrap").style.display = "none";
    $("#m-price-wrap").style.display = "none";
    const prev = p.status === "sold" ? `曾以 ${fmt(p.sale_price)} 售出` : "曾登记为损坏";
    $("#settle-preview").innerHTML = `<div class="sp-item" style="grid-column:1/-1">
      <span>恢复后将重新按购入价计算每日成本</span><b>${prev}，记录里的结算数据会清除</b></div>`;
  }
  $("#modal-mask").classList.add("show");
  pushFocusTrap($("#modal-mask"));
  setTimeout(() => (isRestore ? confirmBtn : $("#m-price")).focus(), 80);
}

function closeSellModal() {
  $("#modal-mask").classList.remove("show");
  popFocusTrap();
  sellTarget = null;
  sellBatchIds = null;
}

function updateSettlePreview() {
  const box = $("#settle-preview");
  // 批量模式下没有单条基准，给出汇总预估即可
  if (sellBatchIds) {
    const items = selectedItems();
    const total = items.reduce((s, p) => s + (Number(p.price) || 0), 0);
    const days = items.length
      ? Math.round(items.reduce((s, p) => s + (Number(p.days_held) || 0), 0) / items.length)
      : 0;
    box.innerHTML = `
      <div class="sp-item"><span>资产件数</span><b>${items.length} 件</b></div>
      <div class="sp-item"><span>购入价合计</span><b>${fmt(total)}</b></div>
      <div class="sp-item"><span>平均持有</span><b>${fmtNum(days)} 天</b></div>
      <div class="sp-item"><span>处理方式</span><b>${sellStatus === "sold" ? "按统一售价登记出售" : "全部记为损坏"}</b></div>`;
    return;
  }
  // 待售资产也会走「售出」（主入口路径），同样给出结算预览；
  // 只有非持有状态（恢复场景）不需要
  if (!sellTarget || !isHolding(sellTarget)) return;
  const saleDate = $("#m-date").value || today();
  const days = daysBetween(sellTarget.purchase_date, saleDate);
  const price = Number(sellTarget.price) || 0;

  if (sellStatus === "damaged") {
    box.innerHTML = `
      <div class="sp-item"><span>持有天数</span><b>${fmtNum(days)} 天</b></div>
      <div class="sp-item"><span>最终日均成本</span><b class="r">${fmt(price / days, { decimals: 2 })}/天</b></div>
      <div class="sp-item"><span>记为损失</span><b class="r">−${fmt(price)}</b></div>
      <div class="sp-item"><span>折旧率</span><b>100%</b></div>`;
    return;
  }
  const salePriceRaw = $("#m-price").value;
  if (salePriceRaw === "" || Number.isNaN(Number(salePriceRaw))) {
    box.innerHTML = `<div class="sp-item" style="grid-column:1/-1"><span>填写出售价格后自动算出最终日均成本与折旧</span></div>`;
    return;
  }
  const sp = Number(salePriceRaw);
  const net = price - sp;
  const pnl = sp - price;
  box.innerHTML = `
    <div class="sp-item"><span>持有天数</span><b>${fmtNum(days)} 天</b></div>
    <div class="sp-item"><span>最终日均成本</span><b>${fmt(net / days, { decimals: 2 })}/天</b></div>
    <div class="sp-item"><span>折旧金额</span><b>${fmt(net)}</b></div>
    <div class="sp-item"><span>盈亏</span><b class="${pnl > 0 ? "g" : pnl < 0 ? "r" : ""}">${fmtPnl(pnl)}</b></div>`;
}

$("#modal-confirm").onclick = async () => {
  const btn = $("#modal-confirm");
  const mode = btn.dataset.mode;
  const id = Number($("#m-id").value);

  if (mode !== "restore" && sellStatus === "sold") {
    const raw = $("#m-price").value;
    if (raw === "" || Number.isNaN(Number(raw))) {
      $("#m-price").classList.add("invalid");
      $("#m-price").focus();
      toast("请填写出售价格", "error");
      return;
    }
    if (Number(raw) < 0) { toast("出售价格不能为负数", "error"); return; }
  }
  const saleDate = $("#m-date").value;
  if (!sellBatchIds && mode !== "restore" && sellTarget && saleDate && saleDate < sellTarget.purchase_date) {
    toast("处理日期不能早于购买日期", "error");
    return;
  }

  // ---- 批量处理 ----
  if (sellBatchIds) {
    const ids = sellBatchIds.slice();
    const bad = ids
      .map((id) => state.products.find((x) => x.id === id))
      .filter((p) => p && p.purchase_date && saleDate < p.purchase_date);
    if (bad.length) {
      toast(`有 ${bad.length} 条资产的购买日期晚于处理日期，请调整日期`, "error");
      return;
    }
    await withLoading(btn, async () => {
      let ok = 0, fail = 0;
      for (const id of ids) {
        try {
          await api(`/api/products/${id}/sell`, "POST", {
            status: sellStatus,
            sale_date: saleDate || today(),
            sale_price: sellStatus === "sold" ? Number($("#m-price").value) : null,
          });
          ok++;
        } catch (e) {
          fail++;
        }
      }
      closeSellModal();
      state.selected.clear();
      await loadProducts({ silent: true });
      toast(fail ? `已处理 ${ok} 条，${fail} 条失败` : `已处理 ${ok} 条`, fail ? "error" : "success");
    });
    return;
  }

  await withLoading(btn, async () => {
    try {
      if (mode === "restore") {
        await api(`/api/products/${id}/sell`, "POST", { status: "in_use" });
        toast("已恢复为使用中", "success");
      } else {
        await api(`/api/products/${id}/sell`, "POST", {
          status: sellStatus,
          sale_date: saleDate || today(),
          sale_price: sellStatus === "sold" ? Number($("#m-price").value) : null,
        });
        toast(sellStatus === "sold" ? "已登记出售" : "已登记损坏", "success");
      }
      closeSellModal();
      await loadProducts({ silent: true });
    } catch (e) {
      toast(e.message, "error");
    }
  });
};

$("#modal-cancel").onclick = closeSellModal;
$("#modal-x").onclick = closeSellModal;
$("#modal-mask").addEventListener("click", (e) => { if (e.target.id === "modal-mask") closeSellModal(); });
$$("#m-status .seg-btn").forEach((b) => { b.onclick = () => setSellStatus(b.dataset.status); });
$("#m-price").addEventListener("input", updateSettlePreview);
$("#m-date").addEventListener("change", updateSettlePreview);

// ---------------- 保存 ----------------
$("#btn-save").onclick = () => {
  const btn = $("#btn-save");
  const data = collectForm();

  const mark = (id, bad) => $("#" + id).classList.toggle("invalid", bad);
  const nameBad = !data.name;
  const priceBad = data.price === "" || Number.isNaN(Number(data.price)) || Number(data.price) < 0;
  const dateBad = !data.purchase_date;
  mark("f-name", nameBad); mark("f-price", priceBad); mark("f-pdate", dateBad);
  if (nameBad) { $("#f-name").focus(); return toast("请填写资产名称", "error"); }
  if (priceBad) { $("#f-price").focus(); return toast("请填写有效的购买价格", "error"); }
  if (dateBad) { $("#f-pdate").focus(); return toast("请选择购买时间", "error"); }

  const id = data.id;
  delete data.id;
  const payload = { ...data, price: Number(data.price) };

  withLoading(btn, async () => {
    try {
      if (id) { await api(`/api/products/${id}`, "PUT", payload); toast("已更新", "success"); }
      else { await api("/api/products", "POST", payload); toast("已保存", "success"); }
      closeDrawer();
      await loadProducts({ silent: true });
    } catch (e) {
      toast(e.message, "error");
    }
  });
};

$("#btn-add").onclick = () => openDrawer("create");
$("#fab-add").onclick = () => openDrawer("create");
$("#drawer-close").onclick = closeDrawer;
$("#drawer-mask").addEventListener("click", closeDrawer);
$("#btn-reset").onclick = () => { resetForm(); $("#f-name").focus(); };
$("#add-custom").onclick = () => {
  const row = addCustomRow();
  row.querySelector(".ck").focus();
};
$("#f-price").addEventListener("input", updateCostPreview);
$("#f-pdate").addEventListener("change", updateCostPreview);

// ---------------- 筛选交互 ----------------
// 任何会改变结果集的操作都要回到第 1 页，否则可能停在一个已经不存在的页码上
function renderTableFromFirstPage() {
  state.page = 1;
  saveFilters();
  renderTable();
}

// 筛选条件持久化：刷新后 / 重开 exe 后仍在原来的视图里
const FILTER_KEY = "at_filters";

function saveFilters() {
  try {
    const f = {
      kw: $("#filter-kw").value,
      st: currentStatus(),
      brand: $("#filter-brand").value,
      cat: $("#filter-category").value,
      sortKey: state.sortKey,
      sortDir: state.sortDir,
    };
    // 全空就不写，免得下次启动读到一堆空字符串
    const dirty = f.kw || f.st || f.brand || f.cat;
    if (dirty) localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    else localStorage.removeItem(FILTER_KEY);
  } catch (e) {}
}

function restoreFilters() {
  let f = null;
  try {
    f = JSON.parse(localStorage.getItem(FILTER_KEY) || "null");
  } catch (e) {}
  if (!f) return;
  // hash 里显式给了排序就以 hash 为准（分享链接优先）
  const hashHasSort = /#(?:assets|report|wish|forsale)\/[\w]+-(?:asc|desc)/.test(location.hash);
  if (f.kw) $("#filter-kw").value = f.kw;
  if (f.st) {
    $$("#status-chips .chip").forEach((c) => c.classList.toggle("active", c.dataset.status === f.st));
  }
  // 品牌/分类的下拉项要等数据回来才有，先存起来等 syncFilterOptions 应用
  state.pendingFilter = { brand: f.brand || "", cat: f.cat || "" };
  if (!hashHasSort && f.sortKey) {
    state.sortKey = f.sortKey;
    state.sortDir = f.sortDir === "asc" ? "asc" : "desc";
  }
}

$("#filter-kw").addEventListener("input", debounce(renderTableFromFirstPage, 160));
$("#status-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#status-chips .chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderTableFromFirstPage();
});
$("#filter-brand").addEventListener("change", renderTableFromFirstPage);
$("#filter-category").addEventListener("change", renderTableFromFirstPage);

// ---------------- 列配置 ----------------
// 现在可选：品牌 / 购买时间 / 已持有 / 状态。名称、价格、日均、盈亏、操作是核心列，始终显示。
// 用 CSS 的 hidden 属性控制，而不是重建表格结构——这样排序、分页都不用跟着改。
const COLS = [
  { key: "brand", label: "品牌", idx: 4 },
  { key: "purchase_date", label: "购买时间", idx: 6 },
  { key: "days_held", label: "已持有", idx: 7 },
  { key: "status", label: "状态", idx: 10 },
];
const COLS_KEY = "at_hidden_cols";

function hiddenCols() {
  try {
    const arr = JSON.parse(localStorage.getItem(COLS_KEY) || "[]");
    return new Set(arr.filter((k) => COLS.some((c) => c.key === k)));
  } catch (e) {
    return new Set();
  }
}

function applyColumnVisibility() {
  const hidden = hiddenCols();
  const table = $("#asset-table");
  if (!table) return;
  COLS.forEach((c) => {
    table.classList.toggle("hide-" + c.key, hidden.has(c.key));
  });
}

// 切换列可见性后只需要重算页脚 colspan，不必整表重绘
function afterColumnToggle() {
  applyColumnVisibility();
  const kw = $("#filter-kw").value.trim().toLowerCase();
  const st = currentStatus();
  const br = $("#filter-brand").value;
  const cat = $("#filter-category").value;
  let list = state.products.filter((p) => {
    if (st && p.status !== st) return false;
    if (br && p.brand !== br) return false;
    if (cat && p.category !== cat) return false;
    if (kw) {
      const hay = [p.name, p.brand, p.category, p.config, p.notes, Object.values(p.custom_fields || {}).join(" ")]
        .join(" ").toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });
  renderFooter(sortList(list));
}

function renderColumnsMenu() {
  const box = $("#columns-menu");
  if (!box) return;
  const hidden = hiddenCols();
  box.innerHTML = `
    <div class="menu-head">显示的列</div>
    ${COLS.map((c) => `
      <label class="menu-item menu-check">
        <input type="checkbox" data-col="${c.key}"${hidden.has(c.key) ? "" : " checked"}>
        <span class="menu-text"><strong>${c.label}</strong></span>
      </label>`).join("")}
    <div class="menu-foot">名称、价格、日均、盈亏、操作始终显示</div>`;
}

function closeColumnsMenu() {
  $("#columns-menu").classList.remove("show");
  $("#btn-columns").setAttribute("aria-expanded", "false");
}

$("#btn-columns").onclick = (e) => {
  e.stopPropagation();
  const open = !$("#columns-menu").classList.contains("show");
  closeExportMenu();
  renderColumnsMenu();
  $("#columns-menu").classList.toggle("show", open);
  $("#btn-columns").setAttribute("aria-expanded", String(open));
};

$("#columns-menu").addEventListener("change", (e) => {
  const cb = e.target.closest("[data-col]");
  if (!cb) return;
  const set = hiddenCols();
  if (cb.checked) set.delete(cb.dataset.col); else set.add(cb.dataset.col);
  try { localStorage.setItem(COLS_KEY, JSON.stringify([...set])); } catch (err) {}
  afterColumnToggle();
});

document.addEventListener("click", (e) => {
  if (!e.target.closest("#btn-columns") && !e.target.closest("#columns-menu")) closeColumnsMenu();
});

// ---------------- 导出菜单 ----------------
function closeExportMenu() {
  $("#export-menu").classList.remove("show");
  $("#btn-export").setAttribute("aria-expanded", "false");
}
$("#btn-export").onclick = (e) => {
  e.stopPropagation();
  const open = !$("#export-menu").classList.contains("show");
  $("#export-menu").classList.toggle("show", open);
  $("#btn-export").setAttribute("aria-expanded", String(open));
};
document.addEventListener("click", (e) => {
  if (!e.target.closest(".menu-wrap")) closeExportMenu();
});

function downloadFile(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}
$("#btn-export-json").onclick = () => {
  downloadFile(`/api/export?format=json&_=${Date.now()}`, `asset_tracker_${stamp()}.json`);
  closeExportMenu();
  toast("已导出 JSON", "success");
};
$("#btn-export-csv").onclick = () => {
  downloadFile(`/api/export?format=csv&_=${Date.now()}`, `asset_tracker_${stamp()}.csv`);
  closeExportMenu();
  toast("已导出 CSV，Excel 可直接打开", "success");
};

// ---------------- 导入 ----------------
$("#btn-import").onclick = () => $("#import-file").click();
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  const mode = await uiDialog({
    title: "选择导入方式",
    message: `文件「<strong>${esc(file.name)}</strong>」<br>追加导入会跳过重复记录；覆盖导入会先清空现有数据。`,
    actions: [
      { label: "取消", value: null, kind: "ghost" },
      { label: "覆盖导入", value: "replace", kind: "danger" },
      { label: "追加导入", value: "append", kind: "primary" },
    ],
  });
  e.target.value = "";
  if (!mode) return;

  if (mode === "replace") {
    const ok = await uiConfirm(
      "确认覆盖导入",
      `覆盖导入会<span class="warn">清空现有全部 ${state.products.length} 条记录</span>后再写入文件数据，建议先导出备份。`,
      "继续覆盖", true
    );
    if (!ok) return;
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("mode", mode);

  toast("正在导入…", "loading", { sticky: true });
  try {
    const res = await fetch(BASE + "/api/import", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    hideToast();
    if (data.ok) {
      await uiDialog({
        title: "导入完成",
        message: `文件共 <strong>${data.total}</strong> 条，成功导入 <strong>${data.inserted}</strong> 条，跳过 ${data.skipped} 条。<br>方式：${mode === "append" ? "追加" : "覆盖"}`,
        actions: [{ label: "知道了", value: true, kind: "primary" }],
      });
      await loadProducts({ silent: true });
    } else {
      await uiAlert("导入失败", esc(data.msg || "未知错误"));
    }
  } catch (err) {
    hideToast();
    await uiAlert("导入出错", esc(err.message));
  }
});

// ---------------- Tab 与深链 ----------------
function activateTab(name, { push = true } = {}) {
  $$(".tab").forEach((x) => {
    const on = x.dataset.tab === name;
    x.classList.toggle("active", on);
    x.setAttribute("aria-selected", String(on));
  });
  $$(".page").forEach((p) => p.classList.remove("active"));
  const page = $("#tab-" + name);
  if (page) page.classList.add("active");
  if (name === "report") loadReport();
  if (name === "wish") loadWish();
  if (name === "forsale") loadForsale();
  if (push) writeHash();
  // 切换后重算图表宽度，避免隐藏容器初始化导致尺寸为 0
  requestAnimationFrame(() => Object.values(charts).forEach((c) => c.resize()));
}
$$(".tab").forEach((t) => { t.onclick = () => activateTab(t.dataset.tab); });

function writeHash() {
  const tab = $("#tab-report").classList.contains("active") ? "report"
    : $("#tab-wish").classList.contains("active") ? "wish"
    : $("#tab-forsale").classList.contains("active") ? "forsale"
    : "assets";
  const parts = [tab];
  // 排序 / 展开行只属于资产列表：在别的页签保存数据时写进 hash 会串味，
  // 分享出去的链接会带上不属于该页签的排序和 id
  if (tab === "assets") {
    if (state.sortKey) parts.push(`${state.sortKey}-${state.sortDir}`);
    if (state.expandedId) parts.push(`id${state.expandedId}`);
  }
  const hash = "#" + parts.join("/");
  if (location.hash !== hash) history.replaceState(null, "", hash);
}
function readHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return;
  const [tab, sortPart, idPart] = raw.split("/");
  if (["report", "wish", "forsale", "assets"].includes(tab)) activateTab(tab, { push: false });
  if (sortPart) {
    const m = sortPart.match(/^(\w+)-(asc|desc)$/);
    if (m) { state.sortKey = m[1]; state.sortDir = m[2]; }
  }
  if (idPart && idPart.startsWith("id")) state.expandedId = Number(idPart.slice(2)) || null;
}

// 手动改地址栏、外部链接跳转、浏览器前进/后退时同步页面状态
window.addEventListener("hashchange", () => {
  const tab = (location.hash.replace(/^#/, "").split("/")[0]) || "assets";
  readHash();
  // 回到列表页：把 hash 里的排序 / 展开状态应用到表格
  if (tab === "assets") renderTable();
});

// ---------------- 主题 ----------------
function setTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("at-theme", t); } catch (e) {}
  chartsReset();
  if ($("#tab-report").classList.contains("active")) loadReport();
  else renderTable();
}
$("#theme-toggle").onclick = () => {
  const cur = document.documentElement.getAttribute("data-theme");
  setTheme(cur === "light" ? "dark" : "light");
};

// ---------------- 行密度 ----------------
function setDensity(d) {
  if (d === "compact") document.documentElement.setAttribute("data-density", "compact");
  else document.documentElement.removeAttribute("data-density");
  try { localStorage.setItem("at-density", d); } catch (e) {}
}
$("#density-toggle").onclick = () => {
  const compact = document.documentElement.getAttribute("data-density") === "compact";
  setDensity(compact ? "" : "compact");
  toast(compact ? "已切换为舒适密度" : "已切换为紧凑密度", "success", { duration: 1400 });
};

// ---------------- 快捷键帮助 ----------------
function showHelp() {
  const m = $("#help-mask");
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add("show"));
}
function hideHelp() {
  const m = $("#help-mask");
  if (m.hidden) return;
  m.classList.remove("show");
  setTimeout(() => { m.hidden = true; }, 200);
}
$("#help-close") && ($("#help-close").onclick = hideHelp);
$("#help-mask") && $("#help-mask").addEventListener("click", (e) => { if (e.target === e.currentTarget) hideHelp(); });

// ---------------- 快捷键 ----------------
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if ($("#help-mask").classList.contains("show")) return hideHelp();
    if ($("#dialog-mask").classList.contains("show")) return closeDialog(null);
    if ($("#convert-mask").classList.contains("show")) return closeConvertModal();
    if ($("#list-mask").classList.contains("show")) return closeListModal();
    if ($("#modal-mask").classList.contains("show")) return closeSellModal();
    if ($("#wish-drawer").classList.contains("show")) return closeWishDrawer();
    if ($("#drawer").classList.contains("show")) return closeDrawer();
    closeExportMenu();
    hideToast();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const el = document.activeElement;
  const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
  if (typing) return;
  if (e.key === "?") {
    e.preventDefault();
    if ($("#help-mask").classList.contains("show")) hideHelp();
    else showHelp();
    return;
  }

  const modalOpen = $("#drawer").classList.contains("show") ||
    $("#wish-drawer").classList.contains("show") ||
    $("#modal-mask").classList.contains("show") ||
    $("#convert-mask").classList.contains("show") ||
    $("#list-mask").classList.contains("show") ||
    $("#dialog-mask").classList.contains("show") ||
    $("#help-mask").classList.contains("show");
  if (modalOpen) return;

  const k = e.key.toLowerCase();
  if (k === "n") {
    e.preventDefault();
    // 在哪个清单就新建哪种记录，避免在预购页按 N 却弹资产表单
    if ($("#tab-wish").classList.contains("active")) openWishDrawer("create");
    else openDrawer("create");
  }
  else if (e.key === "/") {
    e.preventDefault();
    if ($("#tab-wish").classList.contains("active")) { $("#wish-kw").focus(); return; }
    if ($("#tab-forsale").classList.contains("active")) { $("#forsale-kw").focus(); return; }
    activateTab("assets"); $("#filter-kw").focus();
  }
  else if (k === "t") { e.preventDefault(); $("#theme-toggle").click(); }
  else if (k === "d") { e.preventDefault(); $("#density-toggle").click(); }
  else if (k === "r") { e.preventDefault(); activateTab("report"); }
  else if (k === "l") { e.preventDefault(); activateTab("assets"); }
  else if (k === "w") { e.preventDefault(); activateTab("wish"); }
  else if (k === "s") { e.preventDefault(); activateTab("forsale"); }
  else if (k === "e") { e.preventDefault(); activateTab("assets"); $("#btn-export").click(); }
});

// ---------------- 报表：数据范围 ----------------
function inRange(p, range) {
  if (range === "all") return true;
  const pd = p.purchase_date || "";
  if (range === "year") return pd.startsWith(String(new Date().getFullYear()));
  if (range === "12m") {
    const d = new Date();
    d.setMonth(d.getMonth() - 12);
    return pd >= `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01` && pd <= today();
  }
  return true;
}

// ---------------- 图表主题 ----------------
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (n) => cs.getPropertyValue(n).trim();
  return {
    accent: v("--accent"), green: v("--green"), red: v("--red"), gold: v("--gold"),
    text: v("--text"), text2: v("--text-2"), text3: v("--text-3"),
    grid: v("--border-soft"), surface: v("--surface"), surface2: v("--surface-2"),
    palette: [v("--c1"), v("--c2"), v("--c3"), v("--c4"), v("--c5"), v("--c6"), v("--c7"), v("--c8")],
    isLight: document.documentElement.getAttribute("data-theme") === "light",
  };
}
function chartsReset() {
  // 清空后重建实例，保证主题令牌生效
  Object.keys(charts).forEach((k) => {
    try { charts[k].dispose(); } catch (e) {}
    delete charts[k];
  });
}
function getChart(id) {
  const el = $("#" + id);
  if (!el) return null;
  if (!charts[id]) {
    if (!el.clientWidth) return null;
    charts[id] = echarts.init(el, null, { renderer: "canvas" });
  }
  return charts[id];
}
function emptyChart(id) {
  const el = $("#" + id);
  if (!el) return;
  const inst = charts[id];
  if (inst) { inst.dispose(); delete charts[id]; }
  el.innerHTML = `<div class="chart-empty">暂无数据</div>`;
}
function clearChartPlaceholder(id) {
  const el = $("#" + id);
  if (el && el.querySelector(".chart-empty")) el.innerHTML = "";
}

// 基础坐标轴样式
function axisStyle(c, { rotate = 0 } = {}) {
  return {
    axisLine: { lineStyle: { color: c.grid } },
    axisTick: { show: false },
    axisLabel: { color: c.text3, fontSize: 10.5, rotate, hideOverlap: true },
    splitLine: { lineStyle: { color: c.grid, type: "dashed" } },
  };
}
function tooltipStyle(c) {
  return {
    backgroundColor: c.isLight ? "#fff" : c.surface2,
    borderColor: c.isLight ? "rgba(23,43,84,.12)" : "rgba(120,150,210,.24)",
    borderWidth: 1,
    padding: [8, 11],
    textStyle: { color: c.text, fontSize: 12 },
    extraCssText: "border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.18);backdrop-filter:blur(8px)",
    confine: true,
  };
}

// ---------------- 统计卡片 ----------------
function renderStats() {
  const box = $("#stat-row");
  if (!state.chartScope.length) { box.innerHTML = ""; return; }
  const scope = state.chartScope;
  const inScope = scope.filter(isHolding);
  const soldScope = scope.filter((p) => p.status === "sold");
  const damagedScope = scope.filter((p) => p.status === "damaged");
  const settled = scope.filter((p) => p.profit_loss !== null && p.profit_loss !== undefined);
  const heldValue = inScope.reduce((a, p) => a + (Number(p.price) || 0), 0);
  const dailyTotal = inScope.reduce((a, p) => a + (Number(p.daily_cost) || 0), 0);
  const invested = scope.reduce((a, p) => a + (Number(p.price) || 0), 0);
  const saleTotal = soldScope.reduce((a, p) => a + (Number(p.sale_price) || 0), 0);
  const pnl = settled.reduce((a, p) => a + (Number(p.profit_loss) || 0), 0);
  const avgDaily = inScope.length ? dailyTotal / inScope.length : 0;
  // 盈亏计数按当前范围重算，避免与图表口径不一致
  const profitCount = settled.filter((p) => p.profit_loss > 0).length;
  const lossCount = settled.filter((p) => p.profit_loss < 0).length;

  box.innerHTML = `
    <div class="stat">
      <div class="stat-label">${icon("wallet")}持有资产总额</div>
      <div class="stat-value">${fmt(heldValue)}</div>
      <div class="stat-foot"><b>${inScope.length}</b> 件在持<span class="sep"></span>含待售 ${scope.filter((p) => p.status === "for_sale").length}</div>
    </div>
    <div class="stat">
      <div class="stat-label">${icon("activity")}每日持有成本</div>
      <div class="stat-value a">${fmt(dailyTotal, { decimals: 2 })}</div>
      <div class="stat-foot">年化 <b>${fmt(dailyTotal * 365)}</b><span class="sep"></span>均件 ${fmt(avgDaily, { decimals: 2 })}/天</div>
    </div>
    <div class="stat dual">
      <div class="stat-label">${icon("sell")}结算结果</div>
      <div class="dual-row">
        <div class="dual-item">
          <span class="dual-label">售出回血</span>
          <span class="dual-num g">${fmt(saleTotal)}</span>
        </div>
        <div class="dual-split"></div>
        <div class="dual-item">
          <span class="dual-label">盈亏合计</span>
          <span class="dual-num ${pnl > 0 ? "g" : pnl < 0 ? "r" : ""}">${fmtPnl(pnl)}</span>
        </div>
      </div>
      <div class="stat-foot">已结算 <b>${settled.length}</b> 件<span class="sep"></span>盈利 ${profitCount} · 亏损 ${lossCount}</div>
    </div>
    <div class="stat">
      <div class="stat-label">${icon("layers")}总投入 / 资产数</div>
      <div class="stat-value">${fmt(invested)}</div>
      <div class="stat-foot"><b>${scope.length}</b> 件<span class="sep"></span>在持 ${inScope.length} · 售出 ${soldScope.length} · 损坏 ${damagedScope.length}</div>
    </div>`;
}

// ---------------- 智能洞察 ----------------
function renderInsights() {
  const box = $("#insight-box");
  const scope = state.chartScope;
  if (!scope.length) { box.innerHTML = ""; return; }

  const inUse = scope.filter(isHolding);
  const settled = scope.filter((p) => p.profit_loss !== null && p.profit_loss !== undefined);
  const items = [];

  const dailyTotal = inUse.reduce((a, p) => a + (Number(p.daily_cost) || 0), 0);
  if (inUse.length && dailyTotal > 0) {
    items.push({
      // 年化推算是信息性结论而非异常，不占用红色警示通道（改用中性 + 蓝色数字）
      tone: "", icon: "¥",
      html: `按当前 <strong>${inUse.length}</strong> 件在用资产推算，一年持有开销约 <span class="accent">${fmt(dailyTotal * 365)}</span>，相当于每月 <span class="accent">${fmt(dailyTotal * 30)}</span>。`,
    });
    const top = [...inUse].sort((a, b) => (b.daily_cost || 0) - (a.daily_cost || 0))[0];
    if (top && top.daily_cost > 0) {
      items.push({
        tone: "", icon: "↑",
        html: `当下最烧钱的是「<strong>${esc(top.name)}</strong>」，每天 <span class="warn">${fmt(top.daily_cost, { decimals: 2 })}</span>，已持有 ${fmtNum(top.days_held)} 天。`,
      });
    }
  }

  const steep = settled.filter((p) => (p.depreciation_rate || 0) >= 60);
  if (steep.length) {
    const worst = [...steep].sort((a, b) => (b.depreciation_rate || 0) - (a.depreciation_rate || 0))[0];
    items.push({
      tone: "warn", icon: "↓",
      html: `<strong>${steep.length}</strong> 件已结算资产折旧率超过 60%，最惨的「<strong>${esc(worst.name)}</strong>」达 <span class="warn">${worst.depreciation_rate}%</span>。`,
    });
  }

  const winners = settled.filter((p) => (p.profit_loss || 0) >= 0);
  if (winners.length) {
    const best = [...winners].sort((a, b) => (b.profit_loss || 0) - (a.profit_loss || 0))[0];
    items.push({
      tone: "good", icon: "✓",
      html: `保值亮点：「<strong>${esc(best.name)}</strong>」结算后 <span class="good">${fmtPnl(best.profit_loss)}</span>，${best.profit_loss > 0 ? "卖出即盈利" : "几乎零损耗"}。`,
    });
  }

  // 找到最值得「回本」的在用资产：日成本最高但持有时间短
  if (inUse.length >= 3) {
    const oldest = [...inUse].sort((a, b) => (a.daily_cost || 0) - (b.daily_cost || 0))[0];
    if (oldest && oldest.daily_cost > 0) {
      items.push({
        tone: "gold", icon: "★",
        html: `最划算的在用资产是「<strong>${esc(oldest.name)}</strong>」，日均仅 <span class="gold">${fmt(oldest.daily_cost, { decimals: 2 })}</span>，已陪你 ${fmtNum(oldest.days_held)} 天。`,
      });
    }
  }

  const missing = scope.filter((p) => !p.brand || !p.category).length;
  if (missing) {
    items.push({
      tone: "", icon: "!",
      html: `有 <strong>${missing}</strong> 件资产缺品牌或分类，补齐后分布图表会更准确。`,
    });
  }

  if (!items.length) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="insight-card">
      <div class="insight-list">
        ${items.map((i) => `
          <div class="insight-item">
            <span class="ii-dot ${i.tone}">${i.icon}</span>
            <span>${i.html}</span>
          </div>`).join("")}
      </div>
    </div>`;
}

// ---------------- 趣味排行 ----------------
function renderFunRank() {
  const box = $("#fun-row");
  const scope = state.chartScope;
  if (!scope.length) {
    box.innerHTML = `<div class="fun-card empty" style="grid-column:1/-1">
      <div class="fun-head"><span class="fun-icon">${icon("trophy")}</span><span class="fun-title">趣味排行</span></div>
      <div class="fun-name">录入资产后解锁</div></div>`;
    return;
  }

  const settled = scope.filter((p) => p.depreciation_rate !== null && p.depreciation_rate !== undefined);
  const inUse = scope.filter(isHolding);

  const bigSpender = [...scope].sort((a, b) => b.price - a.price)[0];
  const hoarder = [...scope].sort((a, b) => b.days_held - a.days_held)[0];
  const diver = settled.length ? [...settled].sort((a, b) => b.depreciation_rate - a.depreciation_rate)[0] : null;
  const valuePool = (inUse.length ? inUse : scope).filter((p) => p.price >= 200);
  const valueKing = valuePool.length ? [...valuePool].sort((a, b) => a.daily_cost - b.daily_cost)[0] : null;
  const bestKeeper = settled.length ? [...settled].sort((a, b) => a.depreciation_rate - b.depreciation_rate)[0] : null;
  const newest = [...scope].sort((a, b) => (b.purchase_date || "").localeCompare(a.purchase_date || ""))[0];

  const yearMap = {};
  scope.forEach((p) => {
    if (p.purchase_date) {
      const y = p.purchase_date.slice(0, 4);
      yearMap[y] = (yearMap[y] || 0) + (Number(p.price) || 0);
    }
  });
  const yearTop = Object.entries(yearMap).sort((a, b) => b[1] - a[1])[0];

  const cards = [
    { icon: "money", title: "败家之王", name: bigSpender.name, val: `入手价 ${fmt(bigSpender.price)}` },
    { icon: "hourglass", title: "最强钉子户", name: hoarder.name, val: `已陪伴 ${fmtNum(hoarder.days_held)} 天` },
    { icon: "trend-down", title: "跳水冠军", name: diver ? diver.name : null, val: diver ? `折旧率 ${diver.depreciation_rate}%` : "虚位以待" },
    { icon: "star", title: "性价比之王", name: valueKing ? valueKing.name : null, val: valueKing ? `仅 ${fmt(valueKing.daily_cost, { decimals: 2 })}/天` : "虚位以待" },
    { icon: "flag", title: "最保值产品", name: bestKeeper ? bestKeeper.name : null, val: bestKeeper ? `折旧率仅 ${bestKeeper.depreciation_rate}%` : "虚位以待" },
    { icon: "calendar", title: "年度败家王", name: yearTop ? `${yearTop[0]} 年` : null, val: yearTop ? `共投入 ${fmt(yearTop[1])}` : "虚位以待" },
    { icon: "clock", title: "最新入手", name: newest ? newest.name : null, val: newest ? `${newest.purchase_date} 入手` : "虚位以待" },
    { icon: "grid", title: "品类之最", name: topCategory(), val: topCategory(true) },
  ];

  box.innerHTML = cards.map((c) => c.name
    ? `<div class="fun-card">
         <div class="fun-head"><span class="fun-icon">${icon(c.icon)}</span><span class="fun-title">${c.title}</span></div>
         <div class="fun-name" title="${esc(c.name)}">${esc(c.name)}</div>
         <div class="fun-value">${c.val}</div>
       </div>`
    : `<div class="fun-card empty">
         <div class="fun-head"><span class="fun-icon">${icon(c.icon)}</span><span class="fun-title">${c.title}</span></div>
         <div class="fun-name">虚位以待</div>
         <div class="fun-value">${c.val}</div>
       </div>`).join("");

  function topCategory(asLabel = false) {
    const map = {};
    scope.forEach((p) => {
      const c = p.category || "未分类";
      map[c] = (map[c] || 0) + 1;
    });
    const top = Object.entries(map).sort((a, b) => b[1] - a[1])[0];
    if (!top) return asLabel ? "" : null;
    return asLabel ? `${esc(top[0])} · ${top[1]} 件` : top[0];
  }
}

// ---------------- 图表渲染 ----------------
function renderCharts() {
  const c = themeColors();
  const scope = state.chartScope;
  const inUse = scope.filter(isHolding);

  // ① 累计投入走势
  if (scope.length >= 2) {
    clearChartPlaceholder("chart-cumulative");
    const sorted = [...scope].sort((a, b) => (a.purchase_date || "").localeCompare(b.purchase_date || ""));
    let cum = 0;
    const points = sorted.map((p) => {
      cum += Number(p.price) || 0;
      return [p.purchase_date, Math.round(cum * 100) / 100];
    });
    const ch = getChart("chart-cumulative");
    if (ch) ch.setOption({
      grid: { left: 8, right: 18, top: 20, bottom: 26, containLabel: true },
      tooltip: {
        trigger: "axis", ...tooltipStyle(c),
        formatter: (ps) => {
          const p = ps[0];
          return `<div style="font-weight:600;margin-bottom:3px">${p.axisValue}</div>累计投入 <b>${fmt(p.value)}</b>`;
        },
      },
      xAxis: { type: "category", boundaryGap: false, data: points.map((p) => p[0]), ...axisStyle(c, { rotate: 0 }) },
      yAxis: { type: "value", ...axisStyle(c), axisLine: { show: false }, axisLabel: { color: c.text3, fontSize: 10.5, formatter: (v) => v >= 10000 ? (v / 10000) + "万" : v } },
      series: [{
        type: "line", data: points.map((p) => p[1]), smooth: .25, showSymbol: false,
        lineStyle: { width: 2, color: c.accent },
        itemStyle: { color: c.accent },
        areaStyle: {
          color: {
            type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: hexA(c.accent, .28) },
              { offset: 1, color: hexA(c.accent, 0) },
            ],
          },
        },
        emphasis: { focus: "series" },
      }],
    }, true);
  } else {
    emptyChart("chart-cumulative");
  }

  // ② 每日成本排名
  const dailyData = [...scope].filter((p) => (p.daily_cost || 0) > 0)
    .sort((a, b) => b.daily_cost - a.daily_cost).slice(0, 10).reverse();
  if (dailyData.length) {
    clearChartPlaceholder("chart-daily");
    const ch = getChart("chart-daily");
    if (ch) ch.setOption({
      grid: { left: 4, right: 54, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis", axisPointer: { type: "shadow" }, ...tooltipStyle(c),
        formatter: (ps) => {
          const d = dailyData[ps[0].dataIndex];
          return `<div style="font-weight:600;margin-bottom:3px">${esc(d.name)}</div>
            每日 <b>${fmt(d.daily_cost, { decimals: 2 })}</b><br>
            状态 ${STATUS_TEXT[d.status]} · 持有 ${fmtNum(d.days_held)} 天`;
        },
      },
      xAxis: { type: "value", ...axisStyle(c), axisLabel: { color: c.text3, fontSize: 10.5, formatter: (v) => "¥" + v }, splitLine: { show: false } },
      yAxis: {
        type: "category", data: dailyData.map((d) => truncate(d.name, 9)),
        ...axisStyle(c), axisLine: { show: false }, splitLine: { show: false },
        axisLabel: { color: c.text2, fontSize: 10.5 },
      },
      series: [{
        type: "bar", barWidth: 11, data: dailyData.map((d) => ({
          value: d.daily_cost,
          itemStyle: {
            color: d.status === "in_use" ? c.green : d.status === "for_sale" ? c.accent : d.status === "sold" ? c.gold : c.red,
            borderRadius: [0, 4, 4, 0],
          },
        })),
        label: {
          show: true, position: "right", color: c.text3, fontSize: 10,
          formatter: (p) => fmt(p.value, { decimals: 2 }),
        },
      }],
    }, true);
  } else {
    emptyChart("chart-daily");
  }

  // ③ 折旧排行
  const depData = scope.filter((p) => p.depreciation !== null && p.depreciation !== undefined)
    .sort((a, b) => b.depreciation - a.depreciation).slice(0, 10).reverse();
  if (depData.length) {
    clearChartPlaceholder("chart-dep");
    const ch = getChart("chart-dep");
    if (ch) ch.setOption({
      grid: { left: 4, right: 54, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        trigger: "axis", axisPointer: { type: "shadow" }, ...tooltipStyle(c),
        formatter: (ps) => {
          const d = depData[ps[0].dataIndex];
          return `<div style="font-weight:600;margin-bottom:3px">${esc(d.name)}</div>
            折旧 <b>${fmt(d.depreciation)}</b>（${d.depreciation_rate}%）<br>
            最终日均 ${fmt(d.final_holding_cost, { decimals: 2 })}`;
        },
      },
      xAxis: { type: "value", ...axisStyle(c), axisLabel: { color: c.text3, fontSize: 10.5, formatter: (v) => "¥" + v } },
      yAxis: {
        type: "category", data: depData.map((d) => truncate(d.name, 9)),
        ...axisStyle(c), axisLine: { show: false }, splitLine: { show: false },
        axisLabel: { color: c.text2, fontSize: 10.5 },
      },
      series: [{
        type: "bar", barWidth: 11, data: depData.map((d) => d.depreciation),
        itemStyle: {
          borderRadius: [0, 4, 4, 0],
          color: c.red,
        },
        label: { show: true, position: "right", color: c.text3, fontSize: 10, formatter: (p) => fmt(p.value) },
      }],
    }, true);
  } else {
    emptyChart("chart-dep");
  }

  // ④ 品牌投入分布
  const brandMap = {};
  scope.forEach((p) => {
    const b = p.brand || "未标注";
    brandMap[b] = (brandMap[b] || 0) + (Number(p.price) || 0);
  });
  const brandData = Object.entries(brandMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  if (brandData.length) {
    clearChartPlaceholder("chart-brand");
    const ch = getChart("chart-brand");
    if (ch) ch.setOption({
      tooltip: { trigger: "item", ...tooltipStyle(c), formatter: (p) => `${esc(p.name)}<br><b>${fmt(p.value)}</b>（${p.percent}%）` },
      legend: {
        bottom: 0, itemWidth: 7, itemHeight: 7, icon: "circle", itemGap: 10,
        textStyle: { color: c.text3, fontSize: 10.5 },
        type: brandData.length > 6 ? "scroll" : "plain",
      },
      color: c.palette,
      series: [{
        type: "pie", radius: ["46%", "70%"], center: ["50%", "44%"],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: false },
        labelLine: { show: false },
        emphasis: { scale: true, scaleSize: 4, label: { show: true, color: c.text, fontSize: 11, fontWeight: 600, formatter: "{b}\n{d}%" } },
        data: brandData,
      }],
    }, true);
    // 点击品牌 -> 列表按该品牌过滤
    bindChartClick("chart-brand", (p) => {
      const b = p.name === "未标注" ? "" : p.name;
      linkToAssets(() => {
        const sel = $("#filter-brand");
        if (sel && [...sel.options].some((o) => o.value === b)) sel.value = b;
      }, `品牌「${p.name}」`);
    });
  } else {
    emptyChart("chart-brand");
  }

  // ⑤ 分类投入分布（玫瑰图）
  const catMap = {};
  scope.forEach((p) => {
    const k = p.category || "未分类";
    catMap[k] = (catMap[k] || 0) + (Number(p.price) || 0);
  });
  const catData = Object.entries(catMap).map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
  if (catData.length) {
    clearChartPlaceholder("chart-category");
    const ch = getChart("chart-category");
    if (ch) ch.setOption({
      tooltip: { trigger: "item", ...tooltipStyle(c), formatter: (p) => `${esc(p.name)}<br><b>${fmt(p.value)}</b>（${p.percent}%）` },
      legend: {
        bottom: 0, itemWidth: 7, itemHeight: 7, icon: "circle", itemGap: 10,
        textStyle: { color: c.text3, fontSize: 10.5 },
        type: catData.length > 6 ? "scroll" : "plain",
      },
      color: c.palette,
      series: [{
        type: "pie", radius: ["30%", "70%"], center: ["50%", "44%"], roseType: "radius",
        itemStyle: { borderColor: c.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: false }, labelLine: { show: false },
        emphasis: { label: { show: true, color: c.text, fontSize: 11, fontWeight: 600, formatter: "{b}\n{d}%" } },
        data: catData,
      }],
    }, true);
    // 点击分类 -> 列表按该分类过滤
    bindChartClick("chart-category", (p) => {
      const v = p.name === "未分类" ? "" : p.name;
      linkToAssets(() => {
        const sel = $("#filter-category");
        if (sel && [...sel.options].some((o) => o.value === v)) sel.value = v;
      }, `分类「${p.name}」`);
    });
  } else {
    emptyChart("chart-category");
  }

  // ⑥ 月度投入趋势
  const monthMap = {};
  scope.forEach((p) => {
    const pd = p.purchase_date || "";
    if (pd.length >= 7) monthMap[pd.slice(0, 7)] = (monthMap[pd.slice(0, 7)] || 0) + (Number(p.price) || 0);
  });
  const months = Object.keys(monthMap).sort();
  if (months.length) {
    clearChartPlaceholder("chart-monthly");
    const ch = getChart("chart-monthly");
    if (ch) ch.setOption({
      grid: { left: 8, right: 12, top: 26, bottom: 6, containLabel: true },
      tooltip: { trigger: "axis", ...tooltipStyle(c), formatter: (ps) => `${ps[0].name}<br>投入 <b>${fmt(ps[0].value)}</b>` },
      xAxis: { type: "category", data: months, ...axisStyle(c, { rotate: months.length > 8 ? 40 : 0 }) },
      yAxis: { type: "value", ...axisStyle(c), axisLine: { show: false }, axisLabel: { color: c.text3, fontSize: 10.5, formatter: (v) => v >= 10000 ? (v / 10000) + "万" : v } },
      series: [{
        type: "bar", data: months.map((m) => Math.round(monthMap[m] * 100) / 100), barMaxWidth: 26,
        itemStyle: {
          borderRadius: [4, 4, 0, 0],
          color: c.accent,
        },
        emphasis: { itemStyle: { color: c.accent } },
      }],
    }, true);
  } else {
    emptyChart("chart-monthly");
  }

  // ⑦ 资产画像散点
  if (scope.length) {
    clearChartPlaceholder("chart-scatter");
    const ch = getChart("chart-scatter");
    const maxPrice = Math.max(...scope.map((p) => Number(p.price) || 0), 1);
    if (ch) ch.setOption({
      grid: { left: 8, right: 20, top: 20, bottom: 34, containLabel: true },
      tooltip: {
        ...tooltipStyle(c),
        formatter: (p) => {
          const d = p.data;
          return `<div style="font-weight:600;margin-bottom:3px">${esc(d.name)}</div>
            持有 <b>${fmtNum(d.value[0])}</b> 天 · 日均 <b>${fmt(d.value[1], { decimals: 2 })}</b><br>
            购入 ${fmt(d.value[2])} · ${STATUS_TEXT[d.status]}`;
        },
      },
      xAxis: {
        type: "value", name: "持有天数", nameLocation: "middle", nameGap: 24,
        nameTextStyle: { color: c.text3, fontSize: 10.5 }, ...axisStyle(c),
      },
      yAxis: {
        type: "value", name: "每日成本", nameTextStyle: { color: c.text3, fontSize: 10.5 },
        ...axisStyle(c), axisLine: { show: false },
      },
      series: [{
        type: "scatter",
        data: scope.map((p) => ({
          name: p.name, value: [p.days_held, p.daily_cost, p.price], status: p.status,
          itemStyle: {
            color: p.status === "in_use" ? c.green : p.status === "for_sale" ? c.accent : p.status === "sold" ? c.gold : c.red,
            opacity: .7, borderColor: c.surface, borderWidth: 1.5,
          },
        })),
        symbolSize: (val) => 8 + Math.sqrt((val[2] || 0) / maxPrice) * 26,
        emphasis: { itemStyle: { opacity: 1, borderWidth: 2 } },
      }],
    }, true);
    // 点击散点 -> 直接跳到那一条并展开详情
    bindChartClick("chart-scatter", (p) => {
      const name = p.data && p.data.name;
      const hit = name ? scope.find((x) => x.name === name) : null;
      if (!hit) return;
      state.expandedId = hit.id;
      linkToAssets(() => {
        $("#filter-kw").value = hit.name;
      }, `「${hit.name}」`);
    });
  } else {
    emptyChart("chart-scatter");
  }
}

function hexA(hex, alpha) {
  const h = String(hex).trim().replace("#", "");
  const full = h.length === 3 ? h.split("").map((x) => x + x).join("") : h;
  const r = parseInt(full.slice(0, 2), 16), g = parseInt(full.slice(2, 4), 16), b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some(Number.isNaN)) return `rgba(91,140,255,${alpha})`;
  return `rgba(${r},${g},${b},${alpha})`;
}
function truncate(s, n) {
  const str = String(s || "");
  return str.length > n ? str.slice(0, n) + "…" : str;
}

// ---------------- 图表联动 ----------------
// 报表里的图不只是「看」，点到哪就去列表里筛到哪：
// 品牌 / 分类饼图 -> 列表按品牌、分类过滤；散点 -> 直接定位到那一条。
function linkToAssets(predicate, label) {
  activateTab("assets");
  clearFilters();
  predicate();
  state.page = 1;
  renderTable();
  toast(`已筛选：${label}`, "success", { duration: 2600 });
}

function bindChartClick(elId, handler) {
  const el = $("#" + elId);
  if (!el) return;
  const inst = charts[elId];
  if (!inst) return;
  inst.off("click");
  inst.on("click", (params) => {
    try {
      handler(params);
    } catch (e) {
      /* 联动失败不该影响图表本身 */
    }
  });
  el.style.cursor = "pointer";
}

// ---------------- 加载报表 ----------------
async function loadReport() {
  try {
    // 注意：所有统计都基于 state.chartScope 前端重算（跟随统计范围过滤），
    // /api/report/summary 是全量口径、无法按范围切分，故不再请求
    state.chartScope = state.products.filter((p) => inRange(p, state.range));

    renderStats();
    renderInsights();
    renderFunRank();
    $("#chart-note").textContent = state.range === "all" ? `共 ${state.chartScope.length} 件` : `范围内 ${state.chartScope.length} 件`;
    renderCharts();

    // 图表容器刚显示时尺寸可能为 0，下一帧补齐
    requestAnimationFrame(() => Object.values(charts).forEach((c) => c.resize()));
  } catch (e) {
    toast(e.message, "error");
  }
}

$("#range-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#range-chips .chip").forEach((c) => c.classList.toggle("active", c === chip));
  state.range = chip.dataset.range;
  loadReport();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => Object.values(charts).forEach((c) => c.resize()), 120);
});

// ================= 预购清单 =================
// 预购是「意向」，不进成本口径；只有转化后生成的资产才进报表。
// 两套数据的唯一接缝是 convert 接口，所以前端也保持两套独立渲染。
let wishTarget = null;     // 正在编辑的预购
let convertTarget = null;  // 正在转化的预购

function wishMatches(w) {
  const kw = $("#wish-kw").value.trim().toLowerCase();
  const st = $("#wish-chips .chip.active").dataset.wstatus || "";
  const prio = $("#wish-priority").value;
  if (st && w.status !== st) return false;
  if (prio && w.priority !== prio) return false;
  if (kw) {
    const hay = [w.name, w.brand, w.category, w.source, w.notes,
                 Object.values(w.custom_fields || {}).join(" ")].join(" ").toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

function wishSortList(list) {
  const { key, dir } = state.wishSort;
  if (!key) return list;
  const d = dir === "asc" ? 1 : -1;
  // 优先级按语义排序，不是按字母
  const prioRank = { high: 0, normal: 1, low: 2 };
  const statusRank = { ready: 0, watching: 1, converted: 2, dropped: 3 };
  return [...list].sort((a, b) => {
    if (key === "priority") return ((prioRank[a.priority] ?? 9) - (prioRank[b.priority] ?? 9)) * d;
    if (key === "status") return ((statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9)) * d;
    let va = a[key], vb = b[key];
    const aN = va === null || va === undefined || va === "";
    const bN = vb === null || vb === undefined || vb === "";
    if (aN && bN) return 0;
    if (aN) return 1;
    if (bN) return -1;
    if (typeof va === "string") return va.localeCompare(vb, "zh-CN") * d;
    return (va - vb) * d;
  });
}

function renderWishTable() {
  const box = $("#wish-body");
  if (!box) return;
  const list = wishSortList(state.wish.filter(wishMatches));

  $("#wish-count").textContent = `${state.wish.length} 项`;
  const chips = { all: state.wish.length, watching: 0, ready: 0, converted: 0, dropped: 0 };
  state.wish.forEach((w) => { if (chips[w.status] !== undefined) chips[w.status]++; });
  $$("#wish-chips .chip").forEach((c) => {
    const n = c.querySelector(".chip-n");
    if (n) n.textContent = chips[n.dataset.wc] ?? 0;
  });

  // 页脚合计按筛选后的全量算
  const active = list.filter((w) => w.status === "watching" || w.status === "ready");
  $("#wish-foot").innerHTML = list.length ? `
    <tr>
      <td colspan="2">合计 ${list.length} 项</td>
      <td class="num">${fmt(active.reduce((s, w) => s + (Number(w.target_price) || 0), 0))}</td>
      <td colspan="5" class="muted">未购买 ${active.length} 项 · 已转化 ${list.filter((w) => w.status === "converted").length} 项</td>
    </tr>` : "";

  if (!list.length) {
    box.innerHTML = "";
    const tip = $("#wish-empty");
    tip.hidden = false;
    const filtered = $("#wish-kw").value.trim() || $("#wish-priority").value ||
      ($("#wish-chips .chip.active").dataset.wstatus || "");
    tip.innerHTML = `
      <div class="empty-ic">${icon("heart")}</div>
      <h3>${filtered ? "没有匹配的预购" : "预购清单还是空的"}</h3>
      <p>${filtered ? "换个关键词或清空筛选试试" : "把想买但还没下手的东西记下来，等价格合适再买"}</p>
      ${filtered ? "" : `<button class="btn primary" id="wish-empty-add">${icon("plus")}记一个想买的</button>`}`;
    const btn = $("#wish-empty-add");
    if (btn) btn.onclick = () => openWishDrawer("create");
    return;
  }
  $("#wish-empty").hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach((w) => {
    const tr = document.createElement("tr");
    tr.dataset.wid = w.id;
    if (w.status === "converted" || w.status === "dropped") tr.classList.add("is-done");
    const dl = w.days_left;
    let dlHtml = `<span class="days-left">—</span>`;
    if (dl !== null && dl !== undefined) {
      if (dl < 0) dlHtml = `<span class="days-left overdue">已过 ${Math.abs(dl)} 天</span>`;
      else if (dl <= 7) dlHtml = `<span class="days-left soon">还剩 ${dl} 天</span>`;
      else dlHtml = `<span class="days-left">还剩 ${dl} 天</span>`;
    }
    const canAct = w.status !== "converted" && w.status !== "dropped";
    tr.innerHTML = `
      <td>
        <div class="wish-name">
          <strong>${esc(w.name)}</strong>
          ${w.config ? `<span class="sub">${esc(truncate(w.config, 30))}</span>` : ""}
          ${w.notes ? `<span class="sub">${esc(truncate(w.notes, 28))}</span>` : ""}
        </div>
      </td>
      <td class="muted">${esc(w.brand) || "—"}</td>
      <td class="num price edit-cell${canAct ? "" : " locked"}"
          ${canAct ? `data-edit="wish" title="点击改心理价"` : ""}>${fmt(w.target_price)}</td>
      <td><span class="prio ${w.priority}"><span class="dot"></span>${PRIO_TEXT[w.priority] || w.priority}</span></td>
      <td class="num">${w.expected_date || "—"}<br>${dlHtml}</td>
      <td>${w.source ? `<span class="src-tag">${esc(w.source)}</span>` : "—"}</td>
      <td><span class="badge ${w.status}">${WISH_TEXT[w.status] || w.status}</span></td>
      <td class="col-ops">
        <div class="row-ops">
          ${canAct ? `
            <button class="op-btn" data-wact="convert" title="已经买了，转入资产列表">${icon("cart")}<span class="op-label">买到了</span></button>
            <button class="icon-btn" data-wact="edit" title="编辑" aria-label="编辑">${icon("edit")}</button>
            <button class="icon-btn" data-wact="drop" title="放弃" aria-label="放弃">${icon("flag")}</button>
          ` : w.status === "converted" ? `
            <span class="muted" style="font-size:11.5px">已转入资产 #${w.product_id ?? "—"}</span>
          ` : `<span class="muted" style="font-size:11.5px">已放弃</span>`}
          <button class="icon-btn danger" data-wact="del" title="删除" aria-label="删除">${icon("trash")}</button>
        </div>
      </td>`;
    frag.appendChild(tr);
  });
  box.innerHTML = "";
  box.appendChild(frag);
  updateWishSortArrows();
}

function updateWishSortArrows() {
  $$("#wish-table th.sortable").forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    const on = th.dataset.wsort === state.wishSort.key;
    th.classList.toggle("sorted", on);
    if (arrow) arrow.textContent = on ? (state.wishSort.dir === "asc" ? "▲" : "▼") : "↕";
  });
}

function renderWishKpi(b) {
  const box = $("#wish-kpi");
  if (!b || !b.total) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="kpi">
      <span class="kpi-label">${icon("wallet")}待买预算</span>
      <strong class="kpi-value a">${fmt(b.budget)}</strong>
      <span class="kpi-sub">未购买 ${b.watching_count + b.ready_count} 项</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon("cart")}待下手</span>
      <strong class="kpi-value gold">${fmt(b.ready_budget)}</strong>
      <span class="kpi-sub">${b.ready_count} 项 准备买</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon("heart")}已转化</span>
      <strong class="kpi-value g">${b.converted_count}</strong>
      <span class="kpi-sub">转化率 ${b.convert_rate}%</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon("clock")}平均犹豫</span>
      <strong class="kpi-value">${fmtNum(b.avg_wait_days)} 天</strong>
      <span class="kpi-sub">从记录到买下</span>
    </div>`;
}

function renderWishCharts(b) {
  if (!b) return;
  const c = themeColors();

  // ① 预算 Top（横向条形）
  const topEl = $("#chart-wish-top");
  if (!b.top_budget.length) { emptyChart("chart-wish-top"); }
  else {
    clearChartPlaceholder("chart-wish-top");
    const inst = getChart("chart-wish-top");
    if (inst) {
      const rows = [...b.top_budget].reverse();
      inst.setOption({
        grid: { left: 8, right: 58, top: 8, bottom: 4, containLabel: true },
        tooltip: { ...tooltipStyle(c), trigger: "item",
          formatter: (p) => `${esc(rows[p.dataIndex].name)}<br/><b>${fmt(p.value)}</b> · ${PRIO_TEXT[rows[p.dataIndex].priority] || ""}` },
        xAxis: { type: "value", ...axisStyle(c), axisLabel: { ...axisStyle(c).axisLabel, formatter: (v) => v >= 1000 ? v / 1000 + "k" : v } },
        yAxis: { type: "category", data: rows.map((d) => truncate(d.name, 10)), ...axisStyle(c),
          axisLabel: { color: c.text2, fontSize: 10.5 } },
        series: [{
          type: "bar", data: rows.map((d) => d.value), barMaxWidth: 14,
          itemStyle: { borderRadius: [0, 4, 4, 0],
            color: (p) => rows[p.dataIndex].priority === "high" ? c.red
              : rows[p.dataIndex].priority === "low" ? c.text3 : c.accent },
          label: { show: true, position: "right", color: c.text2, fontSize: 10,
            formatter: (p) => fmt(p.value) },
        }],
      }, true);
    }
  }

  // ② 优先级构成（环形）
  if (!b.priority_dist.length) { emptyChart("chart-wish-prio"); }
  else {
    clearChartPlaceholder("chart-wish-prio");
    const inst = getChart("chart-wish-prio");
    if (inst) {
      const colorMap = { "很想要": c.red, "一般": c.accent, "观望": c.text3 };
      inst.setOption({
        tooltip: { ...tooltipStyle(c), trigger: "item", formatter: (p) => `${p.name}<br/><b>${p.value} 项</b> · ${fmt(p.data.amount)}` },
        legend: { bottom: 0, textStyle: { color: c.text3, fontSize: 10.5 }, itemWidth: 8, itemHeight: 8 },
        series: [{
          type: "pie", radius: ["48%", "70%"], center: ["50%", "44%"], avoidLabelOverlap: true,
          itemStyle: { borderColor: c.surface, borderWidth: 2 },
          label: { show: false },
          data: b.priority_dist.map((d) => ({
            name: d.name, value: d.value, amount: d.amount,
            itemStyle: { color: colorMap[d.name] || c.accent },
          })),
        }],
      }, true);
    }
  }

  // ③ 分类预算分布
  if (!b.cat_dist.length) { emptyChart("chart-wish-cat"); }
  else {
    clearChartPlaceholder("chart-wish-cat");
    const inst = getChart("chart-wish-cat");
    if (inst) {
      const rows = b.cat_dist.slice(0, 8);
      inst.setOption({
        grid: { left: 8, right: 20, top: 12, bottom: 4, containLabel: true },
        tooltip: { ...tooltipStyle(c), trigger: "item",
          formatter: (p) => `${esc(rows[p.dataIndex].name)}<br/><b>${fmt(p.value)}</b> · ${rows[p.dataIndex].count} 项` },
        xAxis: { type: "category", data: rows.map((d) => truncate(d.name, 6)), ...axisStyle(c),
          axisLabel: { ...axisStyle(c).axisLabel, rotate: 28 } },
        yAxis: { type: "value", ...axisStyle(c) },
        series: [{
          type: "bar", data: rows.map((d) => d.value), barMaxWidth: 26,
          itemStyle: { color: c.accent, borderRadius: [4, 4, 0, 0] },
        }],
      }, true);
    }
  }

  // ④ 计划入手月份
  if (!b.plan.length) { emptyChart("chart-wish-plan"); }
  else {
    clearChartPlaceholder("chart-wish-plan");
    const inst = getChart("chart-wish-plan");
    if (inst) {
      inst.setOption({
        grid: { left: 8, right: 20, top: 14, bottom: 6, containLabel: true },
        tooltip: { ...tooltipStyle(c), trigger: "axis",
          formatter: (ps) => {
            const i = ps[0].dataIndex;
            return `${b.plan[i].month}<br/><b>${b.plan[i].count} 项</b> · ${fmt(b.plan[i].value)}`;
          } },
        xAxis: { type: "category", data: b.plan.map((d) => d.month.slice(2)), ...axisStyle(c) },
        yAxis: { type: "value", ...axisStyle(c) },
        // 用柱子而不是折线：这里按「月」汇总，是离散量不是连续趋势；
        // 而且只有一个月时折线会退化成半空中一个孤零零的点，看不出是钱
        series: [
          { name: "预算", type: "bar", data: b.plan.map((d) => d.value),
            barMaxWidth: 30, itemStyle: { color: c.accent, borderRadius: [4, 4, 0, 0] },
            label: { show: b.plan.length <= 6, position: "top", color: c.text3, fontSize: 10,
              formatter: (p) => fmt(p.value) } },
        ],
      }, true);
    }
  }
}

async function loadWish({ silent = false } = {}) {
  try {
    const [list, board] = await Promise.all([api("/api/wishlist"), api("/api/wishlist/board")]);
    state.wish = list.data || [];
    state.wishBoard = board.data || null;
    renderWishTable();
    renderWishKpi(state.wishBoard);
    renderWishCharts(state.wishBoard);
    updateTabBadges();
    requestAnimationFrame(() => Object.values(charts).forEach((c) => c.resize()));
  } catch (e) {
    if (!silent) toast(e.message, "error");
  }
}

// ---- 预购抽屉 ----
function renderWishCustoms(obj = {}) {
  const box = $("#w-custom-list");
  box.innerHTML = "";
  Object.entries(obj).forEach(([k, v]) => addWishCustomRow(k, v));
  syncWishCustomHint();
}
function addWishCustomRow(key = "", val = "") {
  const box = $("#w-custom-list");
  const div = document.createElement("div");
  div.className = "custom-item";
  div.innerHTML = `
    <input class="ck" placeholder="字段名" value="${esc(key)}" maxlength="40" aria-label="自定义字段名">
    <input class="cv" placeholder="值" value="${esc(val)}" maxlength="200" aria-label="自定义字段值">
    <button class="del" type="button" title="删除该字段" aria-label="删除该字段">${icon("close")}</button>`;
  div.querySelector(".del").onclick = () => { div.remove(); syncWishCustomHint(); };
  box.appendChild(div);
  syncWishCustomHint();
  return div;
}
function syncWishCustomHint() {
  const hint = $("#w-custom-hint");
  if (hint) hint.hidden = $$("#w-custom-list .custom-item").length > 0;
}
function collectWishCustoms() {
  const obj = {};
  $$("#w-custom-list .custom-item").forEach((it) => {
    const k = it.querySelector(".ck").value.trim();
    const v = it.querySelector(".cv").value.trim();
    if (k) obj[k] = v;
  });
  return obj;
}
function resetWishForm() {
  $("#wish-form-title").textContent = "新增预购";
  $("#wish-form-sub").textContent = "先记下想买什么、大概多少钱，买的时候一键转入资产";
  $("#w-id").value = "";
  ["w-name", "w-brand", "w-category", "w-price", "w-source", "w-config", "w-notes"].forEach((id) => {
    const el = $("#" + id);
    if (el) { el.value = ""; el.classList.remove("invalid"); }
  });
  $("#w-edate").value = "";
  $("#w-priority").value = "normal";
  $("#w-status").value = "watching";
  renderWishCustoms({});
  updateWishPreview();
}
function fillWishForm(w) {
  $("#wish-form-title").textContent = "编辑预购";
  $("#wish-form-sub").textContent = w.name || "";
  $("#w-id").value = w.id;
  $("#w-name").value = w.name || "";
  $("#w-brand").value = w.brand || "";
  $("#w-category").value = w.category || "";
  $("#w-price").value = w.target_price ?? "";
  $("#w-edate").value = w.expected_date || "";
  $("#w-priority").value = w.priority || "normal";
  $("#w-source").value = w.source || "";
  $("#w-config").value = w.config || "";
  $("#w-status").value = w.status === "ready" ? "ready" : "watching";
  $("#w-notes").value = w.notes || "";
  ["w-name"].forEach((id) => $("#" + id).classList.remove("invalid"));
  renderWishCustoms(w.custom_fields || {});
  updateWishPreview();
}
function collectWishForm() {
  const idVal = $("#w-id").value;
  return {
    id: idVal ? Number(idVal) : null,
    name: $("#w-name").value.trim(),
    brand: $("#w-brand").value.trim(),
    category: $("#w-category").value.trim(),
    target_price: $("#w-price").value,
    expected_date: $("#w-edate").value,
    priority: $("#w-priority").value,
    source: $("#w-source").value.trim(),
    config: $("#w-config").value.trim(),
    status: $("#w-status").value,
    custom_fields: collectWishCustoms(),
    notes: $("#w-notes").value.trim(),
  };
}
function updateWishPreview() {
  const price = Number($("#w-price").value);
  const ed = $("#w-edate").value;
  $("#wp-budget").textContent = price > 0 ? fmt(price) : "—";
  if (!ed) { $("#wp-wait").textContent = "未设计划日期"; return; }
  const days = Math.round((new Date(ed + "T00:00:00") - new Date(today() + "T00:00:00")) / 86400000);
  $("#wp-wait").textContent = days >= 0 ? `距计划还有 ${days} 天` : `计划日期已过 ${Math.abs(days)} 天`;
}
function openWishDrawer(mode = "create", w = null) {
  if (mode === "edit" && w) fillWishForm(w); else resetWishForm();
  $("#wish-drawer-mask").classList.add("show");
  $("#wish-drawer").classList.add("show");
  document.body.style.overflow = "hidden";
  pushFocusTrap($("#wish-drawer"));
  setTimeout(() => $("#w-name").focus(), 300);
}
function closeWishDrawer() {
  $("#wish-drawer-mask").classList.remove("show");
  $("#wish-drawer").classList.remove("show");
  document.body.style.overflow = "";
  popFocusTrap();
}

// ---- 转化弹窗 ----
function openConvertModal(w) {
  convertTarget = w;
  $("#cv-id").value = w.id;
  $("#cv-date").value = today();
  $("#cv-price").value = w.target_price > 0 ? w.target_price : "";
  $("#cv-config").value = "";
  $("#convert-summary").innerHTML = `
    <span class="ms-icon">${icon("cart")}</span>
    <span class="ms-body">
      <span class="ms-name">${esc(w.name)}</span>
      <span class="ms-meta">预算 ${fmt(w.target_price)} · 记录了 ${fmtNum(w.waited_days)} 天</span>
    </span>`;
  updateConvertPreview();
  $("#convert-mask").classList.add("show");
  pushFocusTrap($("#convert-mask"));
  setTimeout(() => $("#cv-price").focus(), 80);
}
function closeConvertModal() {
  $("#convert-mask").classList.remove("show");
  popFocusTrap();
  convertTarget = null;
}
function updateConvertPreview() {
  const price = Number($("#cv-price").value);
  const d = $("#cv-date").value;
  const box = $("#convert-preview");
  if (!(price > 0) || !d) { box.innerHTML = ""; return; }
  const w = convertTarget;
  const budget = Number(w?.target_price) || 0;
  const diff = budget > 0 ? price - budget : null;
  const days = daysBetween(d, today());
  const daily = days > 0 ? price / days : price;
  let html = `<div class="sp-item"><span>日均成本（从购买日起）</span><b>${fmt(daily, { decimals: 2 })}/天</b></div>`;
  if (diff !== null) {
    const cls = diff > 0 ? "r" : diff < 0 ? "g" : "";
    html += `<div class="sp-item"><span>对比预算</span><b class="${cls}">${fmtPnl(diff)}</b></div>`;
  }
  box.innerHTML = html;
}

async function saveWish() {
  const data = collectWishForm();
  const nameEl = $("#w-name");
  if (!data.name) {
    nameEl.classList.add("invalid");
    nameEl.focus();
    toast("请填写名称", "error");
    return;
  }
  const btn = $("#wish-btn-save");
  await withLoading(btn, async () => {
    try {
      if (data.id) await api(`/api/wishlist/${data.id}`, "PUT", data);
      else await api("/api/wishlist", "POST", data);
      closeWishDrawer();
      await loadWish();
      toast(data.id ? "已保存" : "已加入预购清单", "success");
    } catch (e) {
      toast(e.message, "error");
    }
  });
}

// ================= 待售清单 =================
let listTarget = null;     // 正在挂售的资产

function fsMatches(p) {
  const kw = $("#forsale-kw").value.trim().toLowerCase();
  const age = $("#forsale-chips .chip.active").dataset.fage || "";
  const d = p.days_listed || 0;
  if (age === "fresh" && d > 7) return false;
  if (age === "mid" && (d <= 7 || d > 30)) return false;
  if (age === "stale" && d <= 30) return false;
  if (kw) {
    const hay = [p.name, p.brand, p.category, p.config, p.notes].join(" ").toLowerCase();
    if (!hay.includes(kw)) return false;
  }
  return true;
}

function fsSortList(list) {
  const { key, dir } = state.fsSort;
  if (!key) return list;
  const d = dir === "asc" ? 1 : -1;
  return [...list].sort((a, b) => {
    const va = a[key], vb = b[key];
    const aN = va === null || va === undefined || va === "";
    const bN = vb === null || vb === undefined || vb === "";
    if (aN && bN) return 0;
    if (aN) return 1;
    if (bN) return -1;
    if (typeof va === "string") return va.localeCompare(vb, "zh-CN") * d;
    return (va - vb) * d;
  });
}

function renderForsaleTable() {
  const box = $("#forsale-body");
  if (!box) return;
  const list = fsSortList(state.following.filter(fsMatches));

  $("#forsale-count").textContent = `${state.following.length} 件`;
  const chips = { all: state.following.length, fresh: 0, mid: 0, stale: 0 };
  state.following.forEach((p) => {
    const d = p.days_listed || 0;
    if (d <= 7) chips.fresh++;
    else if (d <= 30) chips.mid++;
    else chips.stale++;
  });
  $$("#forsale-chips .chip").forEach((c) => {
    const n = c.querySelector(".chip-n");
    if (n) n.textContent = chips[n.dataset.fc] ?? 0;
  });

  const cost = list.reduce((s, p) => s + (Number(p.price) || 0), 0);
  const ask = list.reduce((s, p) => s + (Number(p.list_price) || 0), 0);
  $("#forsale-foot").innerHTML = list.length ? `
    <tr>
      <td colspan="2">合计 ${list.length} 件</td>
      <td class="num">${fmt(cost)}</td>
      <td class="num">${fmt(ask)}</td>
      <td class="num">${fmtPnl(ask - cost)}</td>
      <td colspan="3" class="muted">若按挂单价全部成交</td>
    </tr>` : "";

  if (!list.length) {
    box.innerHTML = "";
    const tip = $("#forsale-empty");
    tip.hidden = false;
    const filtered = $("#forsale-kw").value.trim() || ($("#forsale-chips .chip.active").dataset.fage || "");
    tip.innerHTML = `
      <div class="empty-ic">${icon("tag")}</div>
      <h3>${filtered ? "没有匹配的待售资产" : "还没有挂出去的东西"}</h3>
      <p>${filtered ? "换个条件试试" : "在资产列表点「待售」，就会出现在这里"}</p>
      ${filtered ? "" : `<button class="btn primary" id="fs-empty-add">${icon("plus")}去资产列表挑一件</button>`}`;
    const btn = $("#fs-empty-add");
    if (btn) btn.onclick = () => activateTab("assets");
    return;
  }
  $("#forsale-empty").hidden = true;

  const frag = document.createDocumentFragment();
  list.forEach((p) => {
    const tr = document.createElement("tr");
    tr.dataset.id = p.id;
    if ((p.days_listed || 0) >= 30) tr.classList.add("is-stale");
    const pnl = p.list_pnl;
    const pnlCls = pnl === null || pnl === undefined ? "pending"
      : pnl > 0 ? "profit" : pnl < 0 ? "loss" : "flat";
    tr.innerHTML = `
      <td>
        <div class="cat-cell">
          <span class="cat-chip" title="${esc(p.category) || "未分类"}">${icon(categoryIcon(p.category))}</span>
          <div class="cell-name">
            <strong title="${esc(p.name)}">${esc(p.name)}</strong>
            ${p.config ? `<span class="cell-sub">${esc(p.config)}</span>` : ""}
          </div>
        </div>
      </td>
      <td class="muted">${esc(p.brand) || "—"}</td>
      <td class="num">${fmt(p.price)}</td>
      <td class="num edit-cell" data-edit="ask" title="点击改挂单价">${
        p.list_price !== null && p.list_price !== undefined
          ? fmt(p.list_price)
          : `<span class="muted">未定价</span>`}</td>
      <td class="num">${pnl === null || pnl === undefined ? `<span class="pnl pending">待定价</span>` : `<span class="pnl ${pnlCls} num">${fmtPnl(pnl)}</span>`}</td>
      <td class="num">${fmtNum(p.days_listed)} 天</td>
      <td class="daily daily-for_sale num">${fmt(p.daily_cost, { decimals: 2 })}</td>
      <td class="col-ops">
        <div class="row-ops">
          <button class="op-btn" data-fact="sell" title="登记售出">${icon("sell")}<span class="op-label">售出</span></button>
          <button class="op-btn restore" data-fact="unlist" title="下架，恢复使用中">${icon("restore")}<span class="op-label">下架</span></button>
          <button class="icon-btn" data-fact="edit" title="调整挂单价" aria-label="调整挂单价">${icon("edit")}</button>
        </div>
      </td>`;
    frag.appendChild(tr);
  });
  box.innerHTML = "";
  box.appendChild(frag);
  updateFsSortArrows();
}

function updateFsSortArrows() {
  $$("#forsale-table th.sortable").forEach((th) => {
    const arrow = th.querySelector(".sort-arrow");
    const on = th.dataset.fsort === state.fsSort.key;
    th.classList.toggle("sorted", on);
    if (arrow) arrow.textContent = on ? (state.fsSort.dir === "asc" ? "▲" : "▼") : "↕";
  });
}

function renderForsaleKpi(b) {
  const box = $("#forsale-kpi");
  if (!b || !b.total) { box.innerHTML = ""; return; }
  box.innerHTML = `
    <div class="kpi">
      <span class="kpi-label">${icon("layers")}压货成本</span>
      <strong class="kpi-value">${fmt(b.book_value)}</strong>
      <span class="kpi-sub">${b.total} 件待售</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon("tag")}挂单报价</span>
      <strong class="kpi-value a">${fmt(b.ask_value)}</strong>
      <span class="kpi-sub">${
        b.ask_value > 0
          ? "按报价可回血" + (b.avg_discount !== null ? ` · 历史成交比报价低 ${Math.abs(b.avg_discount)}%` : "")
          : "尚未定价"
      }</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon(b.expect_pnl >= 0 ? "trend-up" : "trend-down")}预期盈亏</span>
      <strong class="kpi-value ${b.expect_pnl > 0 ? "g" : b.expect_pnl < 0 ? "r" : ""}">${fmtPnl(b.expect_pnl)}</strong>
      <span class="kpi-sub">若全部按报价成交</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon("clock")}平均挂单</span>
      <strong class="kpi-value">${fmtNum(b.avg_listed_days)} 天</strong>
      <span class="kpi-sub">${b.stale_count} 件超 30 天</span>
    </div>
    <div class="kpi">
      <span class="kpi-label">${icon("activity")}仍在烧钱</span>
      <strong class="kpi-value r">${fmt(b.daily_cost, { decimals: 2 })}/天</strong>
      <span class="kpi-sub">${b.total} 件待售期间的持有成本</span>
    </div>`;
}

function renderForsaleCharts(b) {
  if (!b) return;
  const c = themeColors();

  // ① 挂单时长分布
  if (!b.age_dist.length) { emptyChart("chart-fs-age"); }
  else {
    clearChartPlaceholder("chart-fs-age");
    const inst = getChart("chart-fs-age");
    if (inst) {
      const colors = [c.green, c.accent, c.gold, c.red];
      inst.setOption({
        tooltip: { ...tooltipStyle(c), trigger: "item",
          formatter: (p) => `${p.name}<br/><b>${p.value} 件</b> · ${fmt(p.data.amount)}` },
        legend: { bottom: 0, textStyle: { color: c.text3, fontSize: 10.5 }, itemWidth: 8, itemHeight: 8 },
        series: [{
          type: "pie", radius: ["46%", "68%"], center: ["50%", "44%"],
          itemStyle: { borderColor: c.surface, borderWidth: 2 },
          label: { show: false },
          data: b.age_dist.map((d, i) => ({
            name: d.name, value: d.value, amount: d.amount,
            itemStyle: { color: colors[i % colors.length] },
          })),
        }],
      }, true);
    }
  }

  // ② 压货最久 Top（横向条，天数）
  if (!b.old_top.length) { emptyChart("chart-fs-old"); }
  else {
    clearChartPlaceholder("chart-fs-old");
    const inst = getChart("chart-fs-old");
    if (inst) {
      const rows = [...b.old_top].reverse();
      inst.setOption({
        grid: { left: 8, right: 46, top: 8, bottom: 4, containLabel: true },
        tooltip: { ...tooltipStyle(c), trigger: "item",
          formatter: (p) => `${esc(rows[p.dataIndex].name)}<br/>已挂 <b>${p.value} 天</b><br/>成本 ${fmt(rows[p.dataIndex].price)}` },
        xAxis: { type: "value", ...axisStyle(c) },
        yAxis: { type: "category", data: rows.map((d) => truncate(d.name, 10)), ...axisStyle(c),
          axisLabel: { color: c.text2, fontSize: 10.5 } },
        series: [{
          type: "bar", data: rows.map((d) => d.days || 0), barMaxWidth: 13,
          itemStyle: { borderRadius: [0, 4, 4, 0],
            color: (p) => (rows[p.dataIndex].days || 0) >= 30 ? c.red : c.accent },
          label: { show: true, position: "right", color: c.text2, fontSize: 10,
            formatter: "{c} 天" },
        }],
      }, true);
    }
  }

  // ③ 分类压货结构
  if (!b.cat_dist.length) { emptyChart("chart-fs-cat"); }
  else {
    clearChartPlaceholder("chart-fs-cat");
    const inst = getChart("chart-fs-cat");
    if (inst) {
      const rows = b.cat_dist.slice(0, 8);
      inst.setOption({
        grid: { left: 8, right: 20, top: 12, bottom: 18, containLabel: true },
        tooltip: { ...tooltipStyle(c), trigger: "item",
          formatter: (p) => `${esc(rows[p.dataIndex].name)}<br/>成本 <b>${fmt(p.value)}</b> · ${rows[p.dataIndex].count} 件` },
        // 旋转 28° 的长标签会顶到画布底边，留出 18px 才不会被切掉
        xAxis: { type: "category", data: rows.map((d) => truncate(d.name, 6)), ...axisStyle(c),
          axisLabel: { ...axisStyle(c).axisLabel, rotate: 28, margin: 8 } },
        yAxis: { type: "value", ...axisStyle(c) },
        series: [{
          type: "bar", data: rows.map((d) => d.cost), barMaxWidth: 26,
          itemStyle: { color: c.gold, borderRadius: [4, 4, 0, 0] },
        }],
      }, true);
    }
  }

  // ④ 成本 vs 报价（每件一条，双柱对比，最直观地看出「降了多少」）
  const cmp = state.following.filter((p) => (p.list_price ?? 0) > 0).slice(0, 10);
  if (!cmp.length) { emptyChart("chart-fs-cmp"); }
  else {
    clearChartPlaceholder("chart-fs-cmp");
    const inst = getChart("chart-fs-cmp");
    if (inst) {
      inst.setOption({
        grid: { left: 8, right: 12, top: 22, bottom: 18, containLabel: true },
        tooltip: { ...tooltipStyle(c), trigger: "axis",
          formatter: (ps) => {
            const i = ps[0].dataIndex;
            const p = cmp[i];
            return `${esc(p.name)}<br/>购入 ${fmt(p.price)}<br/>挂单 ${fmt(p.list_price)}<br/>差价 <b>${fmtPnl((p.list_price || 0) - p.price)}</b>`;
          } },
        legend: { top: 0, textStyle: { color: c.text3, fontSize: 10.5 }, itemWidth: 8, itemHeight: 8 },
        xAxis: { type: "category", data: cmp.map((p) => truncate(p.name, 5)), ...axisStyle(c),
          axisLabel: { ...axisStyle(c).axisLabel, rotate: 28, margin: 8 } },
        yAxis: { type: "value", ...axisStyle(c) },
        series: [
          { name: "购入价", type: "bar", data: cmp.map((p) => p.price), barMaxWidth: 13,
            itemStyle: { color: c.text3, borderRadius: [3, 3, 0, 0] } },
          { name: "挂单价", type: "bar", data: cmp.map((p) => p.list_price), barMaxWidth: 13,
            itemStyle: { color: c.accent, borderRadius: [3, 3, 0, 0] } },
        ],
      }, true);
    }
  }
}

async function loadForsale({ silent = false } = {}) {
  try {
    // 待售数据是 products 的子集，直接从内存筛，不额外请求
    state.following = state.products.filter((p) => p.status === "for_sale");
    renderForsaleTable();
    const board = await api("/api/forsale/board");
    state.fsBoard = board.data || null;
    renderForsaleKpi(state.fsBoard);
    renderForsaleCharts(state.fsBoard);
    updateTabBadges();
    requestAnimationFrame(() => Object.values(charts).forEach((c) => c.resize()));
  } catch (e) {
    if (!silent) toast(e.message, "error");
  }
}

function updateTabBadges() {
  const nb = $("#wish-badge");
  if (nb) {
    const n = state.wish.filter((w) => w.status === "watching" || w.status === "ready").length;
    nb.textContent = n;
    nb.hidden = n === 0;
  }
  const fb = $("#forsale-badge");
  if (fb) {
    const n = state.products.filter((p) => p.status === "for_sale").length;
    fb.textContent = n;
    fb.hidden = n === 0;
  }
}

// ---- 挂入待售弹窗 ----
function openListModal(p) {
  listTarget = p;
  $("#ls-id").value = p.id;
  $("#ls-date").value = today();
  $("#ls-price").value = p.price ?? "";
  $("#list-summary").innerHTML = `
    <span class="ms-icon">${icon(categoryIcon(p.category))}</span>
    <span class="ms-body">
      <span class="ms-name">${esc(p.name)}</span>
      <span class="ms-meta">购入 ${fmt(p.price)} · ${p.purchase_date} · 已持有 ${fmtNum(p.days_held)} 天</span>
    </span>`;
  updateListPreview();
  $("#list-mask").classList.add("show");
  pushFocusTrap($("#list-mask"));
  setTimeout(() => $("#ls-price").focus(), 80);
}
function closeListModal() {
  $("#list-mask").classList.remove("show");
  popFocusTrap();
  listTarget = null;
}
function updateListPreview() {
  const ask = Number($("#ls-price").value);
  const d = $("#ls-date").value;
  const box = $("#list-preview");
  const p = listTarget;
  if (!p) { box.innerHTML = ""; return; }
  const diff = ask > 0 ? ask - p.price : null;
  let html = "";
  if (diff !== null) {
    const cls = diff > 0 ? "g" : diff < 0 ? "r" : "";
    html += `<div class="sp-item"><span>按报价成交盈亏</span><b class="${cls}">${fmtPnl(diff)}</b></div>`;
    // 购入价 0 是合法值（白捡/赠品），除它没有意义
    if (p.price > 0) {
      html += `<div class="sp-item"><span>折算折价</span><b>${((ask - p.price) / p.price * 100).toFixed(1)}%</b></div>`;
    }
  }
  html += `<div class="sp-item" style="grid-column:1/-1"><span>注意</span><b>待售期间每日成本继续累加</b></div>`;
  box.innerHTML = html;
}

// ================= 事件绑定：预购 / 待售 =================
$("#wish-drawer-mask").addEventListener("click", closeWishDrawer);
$("#wish-drawer-close").addEventListener("click", closeWishDrawer);
$("#btn-add-wish").addEventListener("click", () => openWishDrawer("create"));
$("#w-add-custom").addEventListener("click", () => addWishCustomRow());
$("#wish-btn-reset").addEventListener("click", resetWishForm);
$("#wish-btn-save").addEventListener("click", saveWish);
["w-price", "w-edate"].forEach((id) => $("#" + id).addEventListener("input", updateWishPreview));

$("#wish-kw").addEventListener("input", debounce(renderWishTable, 180));
$("#wish-priority").addEventListener("change", renderWishTable);
$("#wish-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#wish-chips .chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderWishTable();
});
$("#wish-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.wsort;
  if (state.wishSort.key === key) state.wishSort.dir = state.wishSort.dir === "asc" ? "desc" : "asc";
  else { state.wishSort.key = key; state.wishSort.dir = key === "name" || key === "brand" ? "asc" : "desc"; }
  renderWishTable();
});

$("#wish-body").addEventListener("click", async (e) => {
  // 改价优先：点金额单元格直接进编辑态，不冒泡到行操作
  const cell = e.target.closest('[data-edit="wish"]');
  if (cell) { startCellEdit(cell); return; }

  const btn = e.target.closest("[data-wact]");
  if (!btn) return;
  const tr = btn.closest("tr");
  const id = Number(tr.dataset.wid);
  const w = state.wish.find((x) => x.id === id);
  if (!w) return;
  const act = btn.dataset.wact;

  if (act === "edit") { openWishDrawer("edit", w); return; }
  if (act === "convert") { openConvertModal(w); return; }

  if (act === "drop") {
    const ok = await uiConfirm("放弃预购", `把「<strong>${esc(w.name)}</strong>」标记为已放弃？<br>记录会保留，随时可以恢复。`, "确认放弃");
    if (!ok) return;
    await withLoading(btn, async () => {
      try {
        await api(`/api/wishlist/${id}/drop`, "POST");
        await loadWish();
        toast("已标记为放弃", "success", {
          duration: 5000,
          action: { label: "恢复", onClick: async () => {
            try { await api(`/api/wishlist/${id}/restore`, "POST"); await loadWish(); toast("已恢复", "success"); }
            catch (err) { toast(err.message, "error"); }
          } },
        });
      } catch (err) {
        toast(err.message, "error");
      }
    });
    return;
  }

  if (act === "del") {
    const ok = await uiConfirm("删除预购", `确定删除「<strong>${esc(w.name)}</strong>」？`, "删除", true);
    if (!ok) return;
    await withLoading(btn, async () => {
      try {
        await api(`/api/wishlist/${id}`, "DELETE");
        await loadWish();
        toast("已删除", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
});

$("#convert-x").addEventListener("click", closeConvertModal);
$("#convert-cancel").addEventListener("click", closeConvertModal);
["cv-price", "cv-date"].forEach((id) => $("#" + id).addEventListener("input", updateConvertPreview));
$("#convert-confirm").addEventListener("click", async () => {
  const w = convertTarget;
  if (!w) return;
  const price = $("#cv-price").value;
  const d = $("#cv-date").value;
  if (!(Number(price) > 0)) { toast("请填写实际成交价", "error"); $("#cv-price").focus(); return; }
  if (!d) { toast("请选择购买日期", "error"); return; }
  const btn = $("#convert-confirm");
  await withLoading(btn, async () => {
    try {
      const res = await api(`/api/wishlist/${w.id}/convert`, "POST", {
        price, purchase_date: d, config: $("#cv-config").value.trim(),
      });
      closeConvertModal();
      await loadProducts({ silent: true });
      await loadWish();
      toast("已转入资产列表", "success", {
        duration: 6000,
        action: { label: "去看看", onClick: () => { activateTab("assets"); state.expandedId = res.product_id; renderTable(); } },
      });
    } catch (e) {
      toast(e.message, "error");
    }
  });
});

// 待售
$("#list-x").addEventListener("click", closeListModal);
$("#list-cancel").addEventListener("click", closeListModal);
["ls-price", "ls-date"].forEach((id) => $("#" + id).addEventListener("input", updateListPreview));
$("#list-confirm").addEventListener("click", async () => {
  const p = listTarget;
  if (!p) return;
  const d = $("#ls-date").value;
  if (!d) { toast("请选择上架日期", "error"); return; }
  const btn = $("#list-confirm");
  await withLoading(btn, async () => {
    try {
      await api(`/api/products/${p.id}/list`, "POST", {
        list_date: d, list_price: $("#ls-price").value,
      });
      closeListModal();
      await loadProducts({ silent: true });
      toast("已挂入待售清单", "success", {
        duration: 5000,
        action: { label: "查看", onClick: () => activateTab("forsale") },
      });
    } catch (e) {
      toast(e.message, "error");
    }
  });
});

$("#forsale-kw").addEventListener("input", debounce(renderForsaleTable, 180));
$("#forsale-chips").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  $$("#forsale-chips .chip").forEach((c) => c.classList.toggle("active", c === chip));
  renderForsaleTable();
});
$("#forsale-table thead").addEventListener("click", (e) => {
  const th = e.target.closest("th.sortable");
  if (!th) return;
  const key = th.dataset.fsort;
  if (state.fsSort.key === key) state.fsSort.dir = state.fsSort.dir === "asc" ? "desc" : "asc";
  else { state.fsSort.key = key; state.fsSort.dir = key === "name" || key === "brand" ? "asc" : "desc"; }
  renderForsaleTable();
});

$("#forsale-body").addEventListener("click", async (e) => {
  // 改挂单价优先，其余才是行操作
  const cell = e.target.closest('[data-edit="ask"]');
  if (cell) { startCellEdit(cell); return; }

  const btn = e.target.closest("[data-fact]");
  if (!btn) return;
  const tr = btn.closest("tr");
  const id = Number(tr.dataset.id);
  const p = state.products.find((x) => x.id === id);
  if (!p) return;
  const act = btn.dataset.fact;

  if (act === "sell") { openSellModal(p); return; }
  if (act === "edit") { openListModal(p); return; }

  if (act === "unlist") {
    const ok = await uiConfirm("下架", `把「<strong>${esc(p.name)}</strong>」从待售清单拿回来，恢复为使用中？`, "确认下架");
    if (!ok) return;
    await withLoading(btn, async () => {
      try {
        await api(`/api/products/${id}/unlist`, "POST");
        await loadProducts({ silent: true });
        toast("已下架", "success");
      } catch (err) {
        toast(err.message, "error");
      }
    });
  }
});

$("#btn-pick-forsale").addEventListener("click", () => {
  activateTab("assets");
  toast("在资产列表点「待售」即可挂上", "", { duration: 3200 });
});

// ---------------- 启动 ----------------
function init() {
  // 恢复上次选择的每页条数
  try {
    const saved = Number(localStorage.getItem(PAGE_SIZE_KEY));
    if (PAGE_SIZES.includes(saved)) state.pageSize = saved;
  } catch (e) {}

  resetForm();
  resetWishForm();
  renderWishCustoms({});
  readHash();
  restoreFilters();
  applyColumnVisibility();
  loadProducts();
  if ($("#tab-report").classList.contains("active")) loadReport();
  if ($("#tab-wish").classList.contains("active")) loadWish();
  if ($("#tab-forsale").classList.contains("active")) loadForsale();
}
init();
