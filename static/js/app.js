// ============ 数码资产持有成本管理系统 前端 ============
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

let allProducts = [];
let charts = {};

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
    <input class="ck" placeholder="字段名" value="${key}">
    <input class="cv" placeholder="值" value="${val}">
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

// ---------- 加载列表 ----------
async function loadProducts() {
  const res = await api("/api/products");
  allProducts = res.data || [];
  renderTable();
}
function statusText(s) {
  return { in_use: "使用中", sold: "已售出", damaged: "已损坏" }[s] || s;
}
// 盈亏单元格：盈利绿 / 亏损红 / 持有中灰
function pnlCell(p) {
  if (p.profit_loss === null || p.profit_loss === undefined) {
    return `<span class="pnl pending" title="持有中，未结算">持有中</span>`;
  }
  const v = Number(p.profit_loss);
  if (v > 0) return `<span class="pnl profit">+${fmt(v)}</span>`;
  if (v < 0) return `<span class="pnl loss">−${fmt(Math.abs(v))}</span>`;
  return `<span class="pnl flat">¥0</span>`;
}
function renderTable() {
  const kw = $("#filter-kw").value.trim().toLowerCase();
  const st = $("#filter-status").value;
  const tbody = $("#asset-body");
  tbody.innerHTML = "";
  let list = allProducts.filter((p) => {
    const okSt = !st || p.status === st;
    const okKw = !kw || (p.name + p.brand + p.category).toLowerCase().includes(kw);
    return okSt && okKw;
  });
  $("#empty-tip").style.display = list.length ? "none" : "block";

  list.forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${esc(p.name)}</strong>${p.config ? `<div style="color:var(--muted);font-size:11px">${esc(p.config)}</div>` : ""}</td>
      <td>${esc(p.brand) || "—"}</td>
      <td class="price">${fmt(p.price)}</td>
      <td>${p.purchase_date || "—"}</td>
      <td>${p.days_held} 天</td>
      <td class="daily">${fmt(p.daily_cost)}/天</td>
      <td>${pnlCell(p)}</td>
      <td><span class="badge ${p.status}">${statusText(p.status)}</span></td>
      <td>
        <button class="op-btn" data-act="sell" data-id="${p.id}" data-status="${p.status}">${p.status === "in_use" ? "出售/损坏" : "恢复"}</button>
        <button class="op-btn" data-act="edit" data-id="${p.id}">编辑</button>
        <button class="op-btn danger" data-act="del" data-id="${p.id}">删除</button>
      </td>`;
    tbody.appendChild(tr);
  });
}
function esc(s) {
  return String(s || "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
}

// ---------- 表格事件 ----------
$("#asset-body").addEventListener("click", async (e) => {
  const btn = e.target.closest(".op-btn");
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const act = btn.dataset.act;
  const p = allProducts.find((x) => x.id === id);
  if (act === "edit") {
    fillForm(p);
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (act === "del") {
    if (!confirm(`确定删除「${p.name}」？`)) return;
    await api(`/api/products/${id}`, "DELETE");
    toast("已删除");
    loadProducts();
  } else if (act === "sell") {
    openSellModal(p);
  }
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
    // 询问是出售还是损坏
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
  resetForm();
  loadProducts();
};
$("#btn-reset").onclick = resetForm;
$("#add-custom").onclick = () => addCustomRow();

// ---------- 筛选 ----------
$("#filter-kw").oninput = renderTable;
$("#filter-status").onchange = renderTable;

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

// ---------- 报表 ----------
const palette = ["#5b8cff", "#8f5bff", "#3ddc97", "#f5b942", "#ff8c42", "#ff6b6b", "#4fd1c5", "#7c9cff"];
function getChart(id) {
  if (!charts[id]) charts[id] = echarts.init($("#" + id));
  return charts[id];
}
async function loadReport() {
  const [sum, dep] = await Promise.all([api("/api/report/summary"), api("/api/report/depreciation")]);
  const s = sum.data;
  // 总盈亏动态颜色
  const pnl = Number(s.total_pnl || 0);
  const pnlCls = pnl > 0 ? "g" : (pnl < 0 ? "r" : "o");
  const pnlTxt = pnl > 0 ? "+" + fmt(pnl) : (pnl < 0 ? "−" + fmt(Math.abs(pnl)) : fmt(0));
  const pnlLabel = pnl > 0 ? "总收益（盈利）" : (pnl < 0 ? "总亏损" : "总收益 / 亏损");
  // 统计卡片
  $("#stat-row").innerHTML = `
    <div class="stat"><div class="num">${fmt(s.held_value)}</div><div class="lbl">持有资产总额（使用中 ${s.in_use_count} 件，不含已售/损坏）</div></div>
    <div class="stat o"><div class="num">${fmt(s.total_invested)}</div><div class="lbl">总投入（历史累计，不含已删除）</div></div>
    <div class="stat ${pnlCls}"><div class="num">${pnlTxt}</div><div class="lbl">${pnlLabel} · 盈利 ${s.profit_count} 件 / 亏损 ${s.loss_count} 件</div></div>
    <div class="stat"><div class="num">${s.total_count}</div><div class="lbl">资产总数（使用中 ${s.in_use_count} · 售出 ${s.sold_count} · 损坏 ${s.damaged_count}）</div></div>
    <div class="stat g"><div class="num">${fmt(s.current_daily_total)}</div><div class="lbl">当前每日持有成本合计</div></div>
    <div class="stat r"><div class="num">${fmt(s.total_depreciation)}</div><div class="lbl">已结算资产折旧合计</div></div>`;

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

  // 时间线
  const tl = dep.data.timeline;
  getChart("chart-timeline").setOption({
    grid: { left: 70, right: 30, top: 30, bottom: 40 },
    tooltip: { trigger: "axis", formatter: (ps) => `${ps[0].name}<br/>累计投入：${fmt(ps[0].value)}` },
    xAxis: { type: "category", data: tl.map((t) => t.date), axisLabel: { color: "#9aa5bf", rotate: 30 } },
    yAxis: { type: "value", axisLabel: { color: "#9aa5bf" }, splitLine: { lineStyle: { color: "#2a3554" } } },
    series: [{ type: "line", data: tl.map((t) => t.cum_price), smooth: true,
      areaStyle: { color: "rgba(91,140,255,.18)" }, lineStyle: { color: "#5b8cff", width: 3 },
      itemStyle: { color: "#5b8cff" }, symbolSize: 7 }],
  });
}
window.addEventListener("resize", () => Object.values(charts).forEach((c) => c.resize()));

// ---------- 初始化 ----------
resetForm();
loadProducts();
