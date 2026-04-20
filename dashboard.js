const DATA_URL = "data/prices.json";

// --- Colour palette for chart lines ---
const PALETTE = [
  "#cc0000", "#0066cc", "#00aa44", "#ff8800", "#8800cc",
  "#00aacc", "#cc6600", "#006644", "#cc0088", "#4466aa",
];

let rawData = [];
let chart = null;
let sortState = { col: "monthly_price", dir: "asc" };

// --- Init ---
async function init() {
  try {
    const res = await fetch(DATA_URL);
    rawData = await res.json();
  } catch (e) {
    rawData = [];
  }

  populateFilters();
  render();
}

// --- Filters ---
function getUniqueValues(field) {
  const vals = new Set();
  for (const day of rawData) {
    for (const l of day.listings) {
      if (l[field] != null) vals.add(l[field]);
    }
  }
  return [...vals].sort((a, b) => (typeof a === "string" ? a.localeCompare(b) : a - b));
}

function populateFilters() {
  fillSelect("filter-variant", getUniqueValues("variant"), "All variants");
  fillSelect("filter-months", getUniqueValues("contract_months"), "Any contract length", v => `${v} months`);
  fillSelect("filter-mileage", getUniqueValues("annual_mileage"), "Any mileage", v => `${v.toLocaleString()} miles/yr`);
}

function fillSelect(id, values, placeholder, labelFn = v => v) {
  const sel = document.getElementById(id);
  sel.innerHTML = `<option value="">${placeholder}</option>`;
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = labelFn(v);
    sel.appendChild(opt);
  }
}

function getFilters() {
  return {
    variant: document.getElementById("filter-variant").value,
    months: document.getElementById("filter-months").value,
    mileage: document.getElementById("filter-mileage").value,
  };
}

function applyFilters(listings, filters) {
  return listings.filter(l => {
    if (filters.variant && l.variant !== filters.variant) return false;
    if (filters.months && String(l.contract_months) !== filters.months) return false;
    if (filters.mileage && String(l.annual_mileage) !== filters.mileage) return false;
    return true;
  });
}

// --- Main render ---
function render() {
  const filters = getFilters();

  const filteredData = rawData.map(day => ({
    date: day.date,
    listings: applyFilters(day.listings, filters),
  })).filter(day => day.listings.length > 0);

  const latestDay = filteredData[filteredData.length - 1] || null;
  const previousDay = filteredData[filteredData.length - 2] || null;

  updateStats(latestDay, previousDay, filteredData);
  updateChart(filteredData, filters);
  updateTable(latestDay ? latestDay.listings : []);
}

// --- Stats bar ---
function updateStats(latestDay, previousDay, filteredData) {
  if (!latestDay) {
    setStatCard("stat-cheapest", "--", null, "Cheapest monthly");
    setStatCard("stat-avg", "--", null, "Average monthly");
    setStatCard("stat-listings", "0", null, "Listings today");
    setStatCard("stat-days", "0", null, "Days tracked");
    return;
  }

  const prices = latestDay.listings.map(l => l.monthly_price).filter(Boolean);
  const cheapest = prices.length ? Math.min(...prices) : null;
  const avg = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : null;

  let cheapestDelta = null;
  if (previousDay) {
    const prevPrices = previousDay.listings.map(l => l.monthly_price).filter(Boolean);
    const prevCheapest = prevPrices.length ? Math.min(...prevPrices) : null;
    if (prevCheapest && cheapest) cheapestDelta = cheapest - prevCheapest;
  }

  setStatCard("stat-cheapest", cheapest ? `£${cheapest.toFixed(2)}` : "--", cheapestDelta, "Cheapest monthly");
  setStatCard("stat-avg", avg ? `£${avg.toFixed(2)}` : "--", null, "Avg monthly price");
  setStatCard("stat-listings", latestDay.listings.length, null, "Listings today");
  setStatCard("stat-days", filteredData.length, null, "Days tracked");
}

function setStatCard(id, value, delta, label) {
  const card = document.getElementById(id);
  card.querySelector(".value").textContent = value;
  card.querySelector(".label").textContent = label;
  const deltaEl = card.querySelector(".delta");
  if (delta != null) {
    const sign = delta > 0 ? "+" : "";
    deltaEl.textContent = `${sign}£${delta.toFixed(2)} vs yesterday`;
    deltaEl.className = `delta ${delta > 0 ? "up" : delta < 0 ? "down" : "neutral"}`;
  } else {
    deltaEl.textContent = "";
    deltaEl.className = "delta";
  }
}

// --- Chart ---
function updateChart(filteredData, filters) {
  const container = document.getElementById("chart-container");
  const emptyEl = document.getElementById("chart-empty");

  if (filteredData.length < 2) {
    container.style.display = "none";
    emptyEl.style.display = "flex";
    emptyEl.querySelector("p").textContent =
      filteredData.length === 0 ? "No data matches your filters." : "Need at least 2 days of data to show trends.";
    if (chart) { chart.destroy(); chart = null; }
    return;
  }

  container.style.display = "block";
  emptyEl.style.display = "none";

  // Build datasets — one per variant
  const variantMap = new Map();
  for (const day of filteredData) {
    for (const l of day.listings) {
      if (!l.monthly_price) continue;
      const key = filters.variant || l.variant;
      if (!variantMap.has(key)) variantMap.set(key, []);
      variantMap.get(key).push({ date: day.date, price: l.monthly_price });
    }
  }

  const labels = [...new Set(filteredData.map(d => d.date))].sort();

  const datasets = [];
  let colorIdx = 0;
  for (const [variant, points] of variantMap) {
    const priceByDate = new Map(points.map(p => [p.date, p.price]));
    const color = PALETTE[colorIdx++ % PALETTE.length];
    datasets.push({
      label: variant,
      data: labels.map(d => priceByDate.get(d) ?? null),
      borderColor: color,
      backgroundColor: color + "22",
      pointRadius: 4,
      pointHoverRadius: 6,
      tension: 0.3,
      spanGaps: false,
    });
  }

  const ctx = document.getElementById("price-chart").getContext("2d");

  if (chart) chart.destroy();
  chart = new Chart(ctx, {
    type: "line",
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "bottom", labels: { boxWidth: 12, padding: 16, font: { size: 11 } } },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.dataset.label}: £${ctx.parsed.y?.toFixed(2) ?? "N/A"}/mo`,
          },
        },
      },
      scales: {
        x: { ticks: { maxTicksLimit: 10, font: { size: 11 } } },
        y: {
          ticks: { callback: v => `£${v}`, font: { size: 11 } },
          title: { display: true, text: "Monthly Price (£)", font: { size: 11 } },
        },
      },
    },
  });
}

// --- Table ---
function updateTable(listings) {
  const tbody = document.querySelector("#prices-table tbody");
  const emptyRow = document.getElementById("table-empty-row");

  if (!listings.length) {
    tbody.innerHTML = "";
    emptyRow.style.display = "";
    return;
  }
  emptyRow.style.display = "none";

  const sorted = [...listings].sort((a, b) => {
    const av = a[sortState.col], bv = b[sortState.col];
    if (av == null) return 1;
    if (bv == null) return -1;
    const cmp = typeof av === "string" ? av.localeCompare(bv) : av - bv;
    return sortState.dir === "asc" ? cmp : -cmp;
  });

  tbody.innerHTML = sorted.map(l => `
    <tr>
      <td>${l.variant || "—"}</td>
      <td class="price-cell">${l.monthly_price != null ? `£${l.monthly_price.toFixed(2)}` : "—"}</td>
      <td>${l.initial_payment != null ? `£${l.initial_payment.toFixed(2)}` : "—"}</td>
      <td>${l.contract_months != null ? `<span class="badge">${l.contract_months} mo</span>` : "—"}</td>
      <td>${l.annual_mileage != null ? l.annual_mileage.toLocaleString() : "—"}</td>
    </tr>
  `).join("");
}

function handleSort(col) {
  if (sortState.col === col) {
    sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
  } else {
    sortState.col = col;
    sortState.dir = "asc";
  }

  document.querySelectorAll("thead th").forEach(th => {
    th.classList.remove("sorted-asc", "sorted-desc");
    if (th.dataset.col === col) {
      th.classList.add(sortState.dir === "asc" ? "sorted-asc" : "sorted-desc");
    }
  });

  const filters = getFilters();
  const latestDay = rawData
    .map(day => ({ date: day.date, listings: applyFilters(day.listings, filters) }))
    .filter(day => day.listings.length > 0)
    .at(-1);

  updateTable(latestDay ? latestDay.listings : []);
}

// --- Event wiring ---
document.addEventListener("DOMContentLoaded", () => {
  init();

  ["filter-variant", "filter-months", "filter-mileage"].forEach(id => {
    document.getElementById(id).addEventListener("change", render);
  });

  document.querySelectorAll("thead th[data-col]").forEach(th => {
    th.addEventListener("click", () => handleSort(th.dataset.col));
  });
});
