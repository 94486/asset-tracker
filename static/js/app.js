// ============ 数码资产持有成本管理系统 前端 ============
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let allProducts = [];
let charts = {};
let sortKey = null;       // 当前排序字段
let sortDir = "asc";      // asc / desc
let expandedId = null;     // 当前展开的行 id

// ---------- 工具 ----------
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 2200);
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
    <button class="del" type="button">✕</button>`;
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
  $("#form-title").textContent = "✚ 录入新资产";
  $("#f-id").value = "";
  ["f-name", "f-brand", "f-category", "f-price", "f-config", "f-notes"].forEach((id) => ($("#" + id).value = ""));
  $("#f-pdate").value = today();
  renderCustoms({});
}
function fillForm(p) {
  $("#form-title").textContent = "✎ 编辑资产";
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
  if (e.key === "Escape" && $("#drawer").classList.contains("show")) closeDrawer();
});

// ---------- 加载列表 ----------
async function loadProducts() {
  const res = await api("/api/products");
  allProducts = res.data || [];
  populateFilters();
  renderTable();
  // 资产列表页也显示统计卡片
  try {
    const sum = await api("/api/report/summary");
    renderStats("stat-row-assets", sum.data);
  } catch (e) { /* 报表接口失败不影响列表 */ }
}
function statusText(s) {
  return { in_use: "使用中", sold: "已售出", damaged: "已损坏" }[s] || s;
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
  $("#empty-tip").style.display = list.length ? "none" : "block";

  list.forEach((p) => {
    const isExpanded = expandedId === p.id;
    const tr = document.createElement("tr");
    if (isExpanded) tr.classList.add("expanded");
    tr.innerHTML = `
      <td class="col-expand"><button class="expand-btn" data-id="${p.id}" title="展开详情">${isExpanded ? "▼" : "▶"}</button></td>
      <td><strong>${esc(p.name)}</strong>${p.config ? `<div style="color:var(--muted);font-size:11px">${esc(p.config)}</div>` : ""}</td>
      <td>${esc(p.brand) || "—"}</td>
      <td class="price num">${fmt(p.price)}</td>
      <td class="num">${p.purchase_date || "—"}</td>
      <td class="num">${p.days_held} 天</td>
      <td class="daily num">${fmt(p.daily_cost)}/天</td>
      <td>${pnlCell(p)}</td>
      <td><span class="badge ${p.status}">${statusText(p.status)}</span></td>
      <td class="col-ops">
        <button class="op-btn" data-act="sell" data-id="${p.id}" data-status="${p.status}">${p.status === "in_use" ? "处理" : "恢复"}</button>
        <button class="op-btn" data-act="edit" data-id="${p.id}">编辑</button>
        <button class="op-btn danger" data-act="del" data-id="${p.id}">删除</button>
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
  const btn = e.target.closest(".op-btn");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const p = allProducts.find((x) => x.id === id);
  if (act === "edit") {
    openDrawer("edit", p);
  } else if (act === "del") {
    if (!confirm(`确定删除「${p.name}」？`)) return;
    await api(`/api/products/${id}`, "DELETE");
    if (expandedId === id) expandedId = null;
    toast("已删除");
    loadProducts();
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
function openSellModal(p) {
  sellTarget = p;
  $("#modal-mask").classList.add("show");
  $("#m-id").value = p.id;
  $("#m-date").value = today();
  $("#m-price").value = "";
  if (p.status === "in_use") {
    $("#modal-title").textContent = `登记处理 · ${p.name}`;
    $("#modal-confirm").textContent = "登记出售";
    $("#modal-confirm").dataset.mode = "sold";
    $("#m-price-wrap").style.display = "block";
  } else {
    $("#modal-title").textContent = `恢复为使用中 · ${p.name}`;
    $("#modal-confirm").textContent = "恢复";
    $("#modal-confirm").dataset.mode = "restore";
    $("#m-price-wrap").style.display = "none";
  }
}
function closeSellModal() {
  $("#modal-mask").classList.remove("show");
  sellTarget = null;
}
$("#modal-cancel").onclick = closeSellModal;
$("#modal-mask").addEventListener("click", (e) => { if (e.target.id === "modal-mask") closeSellModal(); });
$("#modal-confirm").onclick = async () => {
  const mode = $("#modal-confirm").dataset.mode;
  const id = Number($("#m-id").value);
  if (mode === "restore") {
    await api(`/api/products/${id}/sell`, "POST", { status: "in_use" });
    toast("已恢复为使用中");
  } else {
    const isDamage = confirm("点【确定】登记为「已售出」，点【取消】登记为「已损坏」");
    const status = isDamage ? "sold" : "damaged";
    await api(`/api/products/${id}/sell`, "POST", {
      status,
      sale_date: $("#m-date").value || today(),
      sale_price: status === "sold" ? Number($("#m-price").value || 0) : null,
    });
    toast(status === "sold" ? "已登记出售" : "已登记损坏");
  }
  closeSellModal();
  loadProducts();
};

// ---------- 保存 ----------
$("#btn-save").onclick = async () => {
  const data = collectForm();
  if (!data.name) return toast("请填写名称");
  if (data.price === "" || isNaN(data.price)) return toast("请填写有效价格");
  if (!data.purchase_date) return toast("请选择购买时间");
  const id = data.id;
  delete data.id;
  if (id) {
    await api(`/api/products/${id}`, "PUT", data);
    toast("已更新");
  } else {
    await api("/api/products", "POST", data);
    toast("已保存");
  }
  closeDrawer();
  loadProducts();
};
$("#btn-reset").onclick = resetForm;
$("#add-custom").onclick = () => addCustomRow();

// ---------- 筛选事件 ----------
$("#filter-kw").oninput = renderTable;
$("#filter-status").onchange = renderTable;
$("#filter-brand").onchange = renderTable;
$("#filter-category").onchange = renderTable;

// ---------- Tab 切换 ----------
$$(".tab").forEach((t) => {
  t.onclick = () => {
    $$(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    $$(".page").forEach((p) => p.classList.remove("active"));
    $("#tab-" + t.dataset.tab).classList.add("active");
    if (t.dataset.tab === "report") loadReport();
  };
});

// ---------- 统计卡片（资产列表页和报表页共用） ----------
function renderStats(containerId, s) {
  const box = $("#" + containerId);
  if (!box) return;
  const pnl = Number(s.total_pnl || 0);
  const pnlCls = pnl > 0 ? "g" : (pnl < 0 ? "r" : "o");
  const pnlTxt = pnl > 0 ? "+" + fmt(pnl) : (pnl < 0 ? "−" + fmt(Math.abs(pnl)) : fmt(0));
  const pnlLabel = pnl > 0 ? "总收益（盈利）" : (pnl < 0 ? "总亏损" : "总收益 / 亏损");

  box.innerHTML = `
    <div class="stat"><div class="num">${fmt(s.held_value)}</div><div class="lbl">持有资产总额（使用中 ${s.in_use_count} 件，不含已售/损坏）</div></div>
    <div class="stat o"><div class="num">${fmt(s.total_invested)}</div><div class="lbl">总投入（历史累计，不含已删除）</div></div>
    <div class="stat ${pnlCls}"><div class="num">${pnlTxt}</div><div class="lbl">${pnlLabel} · 盈利 ${s.profit_count} 件 / 亏损 ${s.loss_count} 件</div></div>
    <div class="stat"><div class="num">${s.total_count}</div><div class="lbl">资产总数（使用中 ${s.in_use_count} · 售出 ${s.sold_count} · 损坏 ${s.damaged_count}）</div></div>
    <div class="stat g"><div class="num">${fmt(s.current_daily_total)}</div><div class="lbl">当前每日持有成本合计</div></div>
    <div class="stat r"><div class="num">${fmt(s.total_depreciation)}</div><div class="lbl">已结算资产折旧合计</div></div>`;
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

  // 最保值品牌：已结算资产平均折旧率最低
  const brandDepMap = {};
  settled.forEach((p) => {
    const b = p.brand || "未标注";
    if (!brandDepMap[b]) brandDepMap[b] = { total: 0, count: 0 };
    brandDepMap[b].total += p.depreciation_rate || 0;
    brandDepMap[b].count += 1;
  });
  const bestBrandEntry = Object.entries(brandDepMap)
    .map(([b, v]) => ({ brand: b, avgRate: v.total / v.count }))
    .sort((a, b) => a.avgRate - b.avgRate)[0];
  const bestBrand = bestBrandEntry ? { name: bestBrandEntry.brand, _rate: bestBrandEntry.avgRate } : null;

  // 最新入手：购买日期最近
  const newest = [...allProducts].sort((a, b) => (b.purchase_date || "").localeCompare(a.purchase_date || ""))[0];

  const cards = [
    { icon: "💰", title: "败家之王", p: bigSpender, val: `入手价 ${fmt(bigSpender.price)}` },
    { icon: "🏠", title: "最强钉子户", p: hoarder, val: `已陪伴 ${hoarder.days_held} 天` },
    { icon: "📉", title: "跳水冠军", p: diver, val: diver ? `折旧率 ${diver.depreciation_rate}%` : "虚位以待" },
    { icon: "✨", title: "性价比之王", p: valueKing, val: valueKing ? `仅 ${fmt(valueKing.daily_cost)}/天` : "虚位以待" },
    { icon: "📅", title: "年度败家王", p: yearKing, val: yearKing ? `共投入 ${fmt(yearKing._total)}` : "虚位以待" },
    { icon: "🛡️", title: "最保值品牌", p: bestBrand, val: bestBrand ? `平均折旧 ${bestBrand._rate.toFixed(1)}%` : "虚位以待" },
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

  // 统计卡片（与资产列表页共用渲染函数）
  renderStats("stat-row", s);

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

// ---------- 初始化 ----------
resetForm();
loadProducts();
