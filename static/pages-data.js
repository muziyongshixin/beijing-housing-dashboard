/* Browser-side analytics for the GitHub Pages edition. */
(function () {
  let db = null;
  let meta = null;

  const text = (params, key, fallback = "") => String(params.get(key) ?? fallback).trim();
  const integer = (params, key, fallback, min, max) => Math.max(min, Math.min(max, Number.parseInt(text(params, key, fallback), 10) || fallback));
  const number = (params, key, fallback, min, max) => Math.max(min, Math.min(max, Number.parseFloat(text(params, key, fallback)) || fallback));
  const monthText = value => `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}`;
  const dateText = value => `${String(value).slice(0, 4)}-${String(value).slice(4, 6)}-${String(value).slice(6, 8)}`;
  const monthNumber = value => Number(String(value).replace("-", ""));
  const shiftMonth = (month, delta) => {
    const [year, mon] = month.split("-").map(Number);
    const absolute = year * 12 + mon - 1 + delta;
    return `${Math.floor(absolute / 12).toString().padStart(4, "0")}-${(absolute % 12 + 1).toString().padStart(2, "0")}`;
  };
  const monthRange = (start, end) => {
    const result = [];
    for (let current = start; current <= end; current = shiftMonth(current, 1)) result.push(current);
    return result;
  };
  const safeChange = (current, base) => current != null && base != null && base !== 0 ? current / base - 1 : null;
  const finite = value => Number.isFinite(value) ? Math.round(value * 1e6) / 1e6 : null;

  function query(sql, params = []) {
    const statement = db.prepare(sql);
    statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    statement.free();
    return rows;
  }

  function metricValue(values, metric) {
    const clean = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!clean.length) return null;
    if (metric === "mean") return clean.reduce((sum, value) => sum + value, 0) / clean.length;
    if (metric === "min") return clean[0];
    if (metric === "max") return clean[clean.length - 1];
    const percentile = metric === "p30" ? .3 : metric === "p60" ? .6 : .5;
    const index = (clean.length - 1) * percentile;
    const lower = Math.floor(index), upper = Math.ceil(index);
    return clean[lower] + (clean[upper] - clean[lower]) * (index - lower);
  }

  function configFrom(params) {
    for (const key of ["end_month", "base_start", "base_end"]) {
      const value = text(params, key);
      if (value && (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value) || value > meta.max_month)) throw new Error("日期超出免费快照范围");
    }
    const endMonth = text(params, "end_month", meta.default_end_month);
    const window = integer(params, "window", 6, 1, 24);
    const compare = ["adjacent", "yoy", "custom"].includes(text(params, "compare", "adjacent")) ? text(params, "compare") : "adjacent";
    const currentStart = shiftMonth(endMonth, -(window - 1));
    let baseStart, baseEnd;
    if (compare === "yoy") {
      baseStart = shiftMonth(currentStart, -12);
      baseEnd = shiftMonth(endMonth, -12);
    } else if (compare === "custom") {
      baseStart = text(params, "base_start", shiftMonth(currentStart, -window));
      baseEnd = text(params, "base_end", shiftMonth(currentStart, -1));
      if (baseStart > baseEnd) [baseStart, baseEnd] = [baseEnd, baseStart];
    } else {
      baseEnd = shiftMonth(currentStart, -1);
      baseStart = shiftMonth(baseEnd, -(window - 1));
    }
    const metric = ["median", "mean", "p30", "p60", "min", "max"].includes(text(params, "metric", "median")) ? text(params, "metric") : "median";
    return {
      end_month: endMonth, window, compare, base_start: baseStart, base_end: baseEnd,
      current_start: currentStart, current_end: endMonth, metric,
      level: text(params, "level", "district") === "community" ? "community" : "district",
      district: text(params, "district", "全部"), business_area: text(params, "business_area", "全部"),
      rooms: text(params, "rooms", "全部"), area_min: number(params, "area_min", 10, 10, 500),
      area_max: number(params, "area_max", 500, 10, 500), min_current: integer(params, "min_current", 10, 0, 10000),
      min_base: integer(params, "min_base", 10, 0, 10000), min_total: integer(params, "min_total", 25, 0, 20000),
      min_active_months: integer(params, "min_active_months", 3, 0, 24), sort: text(params, "sort", "price_change"),
      direction: text(params, "direction", "asc"), limit: integer(params, "limit", 100, 10, 500),
    };
  }

  function periodRows(config, start, end, includeLocation = true, trend = null) {
    const clauses = ["t.sale_month BETWEEN ? AND ?", "t.area BETWEEN ? AND ?"];
    const args = [monthNumber(start), monthNumber(end), Math.round(Math.min(config.area_min, config.area_max) * 100), Math.round(Math.max(config.area_min, config.area_max) * 100)];
    if (includeLocation && config.district !== "全部") { clauses.push("d.name = ?"); args.push(config.district); }
    if (includeLocation && config.business_area !== "全部") { clauses.push("b.name = ?"); args.push(config.business_area); }
    if (config.rooms !== "全部") { clauses.push("l.rooms = ?"); args.push(config.rooms); }
    if (trend?.level === "district") { clauses.push("d.name = ?"); args.push(trend.name); }
    if (trend?.level === "community") { clauses.push("c.name = ?"); args.push(trend.name); }
    return query(`
      SELECT t.sale_month month, d.name district, d.map_name map_district, b.name business_area,
             c.name community, t.unit_price, t.area / 100.0 area, t.cycle_days,
             CASE WHEN t.listing_price > 0 THEN 1.0 * t.sale_price / t.listing_price - 1 END discount_rate
      FROM transactions t JOIN communities c ON c.id=t.community_id
      JOIN business_areas b ON b.id=c.business_area_id JOIN districts d ON d.id=b.district_id
      JOIN layouts l ON l.id=t.layout_id WHERE ${clauses.join(" AND ")}
    `, args);
  }

  function aggregate(rows, keyFields, metric, prefix) {
    const groups = new Map();
    for (const row of rows) {
      const key = keyFields.map(field => row[field]).join("\u0001");
      let group = groups.get(key);
      if (!group) {
        group = { rows: [], values: {} };
        for (const field of keyFields) group.values[field] = row[field];
        groups.set(key, group);
      }
      group.rows.push(row);
    }
    return [...groups.values()].map(group => {
      const rows = group.rows;
      return {
        ...group.values,
        [`${prefix}_price`]: finite(metricValue(rows.map(row => row.unit_price), metric)),
        [`${prefix}_volume`]: rows.length,
        [`${prefix}_months`]: new Set(rows.map(row => row.month)).size,
        [`${prefix}_area`]: finite(metricValue(rows.map(row => row.area), "median")),
        [`${prefix}_cycle`]: finite(metricValue(rows.map(row => row.cycle_days), "median")),
        [`${prefix}_discount`]: finite(metricValue(rows.map(row => row.discount_rate), "median")),
      };
    });
  }

  function mergeAggregates(current, base, keyFields) {
    const result = new Map();
    const keyFor = row => keyFields.map(field => row[field]).join("\u0001");
    for (const row of current) result.set(keyFor(row), { ...row });
    for (const row of base) result.set(keyFor(row), { ...(result.get(keyFor(row)) || row), ...row });
    return [...result.values()];
  }

  function qualify(rows, config, cityChange) {
    for (const row of rows) {
      row.price_change = finite(safeChange(row.current_price, row.base_price));
      row.volume_change = finite(safeChange(row.current_volume, row.base_volume));
      row.area_change = finite(safeChange(row.current_area, row.base_area));
      row.cycle_change = finite(safeChange(row.current_cycle, row.base_cycle));
      row.discount_change = row.current_discount != null && row.base_discount != null ? finite(row.current_discount - row.base_discount) : null;
      row.relative_beijing = row.price_change != null && cityChange != null ? finite(row.price_change - cityChange) : null;
      row.total_volume = (row.current_volume || 0) + (row.base_volume || 0);
      row.eligible = (row.current_volume || 0) >= config.min_current && (row.base_volume || 0) >= config.min_base &&
        row.total_volume >= config.min_total && (row.current_months || 0) >= config.min_active_months &&
        (row.base_months || 0) >= config.min_active_months && row.price_change != null;
    }
    return rows;
  }

  async function initialize(progress) {
    meta = await fetch("data/meta.json").then(response => response.json());
    progress?.("首次打开需加载 31MB 成交数据库…");
    const SQL = await initSqlJs({ locateFile: file => `vendor/${file}` });
    const response = await fetch(meta.pages.database);
    if (!response.ok) throw new Error(`成交数据库加载失败：${response.status}`);
    const total = Number(response.headers.get("content-length")) || meta.pages.database_bytes;
    let bytes;
    if (response.body && total) {
      const reader = response.body.getReader(), chunks = [];
      let loaded = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); loaded += value.length;
        progress?.(`正在加载成交数据库 ${Math.round(loaded / total * 100)}%`);
      }
      bytes = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    } else {
      bytes = new Uint8Array(await response.arrayBuffer());
    }
    db = new SQL.Database(bytes);
    progress?.("数据已加载，正在计算…");
    return meta;
  }

  async function searchCommunities(params) {
    const q = text(params, "q");
    if (!q) return { query: "", results: [] };
    const rows = query(`
      SELECT d.name district, b.name business_area, c.name community, c.transaction_count,
             c.first_date, c.last_date FROM communities c
      JOIN business_areas b ON b.id=c.business_area_id JOIN districts d ON d.id=b.district_id
      WHERE c.name LIKE ? ORDER BY CASE WHEN c.name=? THEN 0 WHEN c.name LIKE ? THEN 1 ELSE 2 END,
      c.transaction_count DESC, c.last_date DESC LIMIT ?
    `, [`%${q}%`, q, `${q}%`, integer(params, "limit", 12, 1, 30)]);
    return { query: q, results: rows.map(row => ({ ...row, first_date: dateText(row.first_date), last_date: dateText(row.last_date) })) };
  }

  async function analyze(params) {
    const config = configFrom(params);
    const current = periodRows(config, config.current_start, config.current_end);
    const base = periodRows(config, config.base_start, config.base_end);
    const benchmarkCurrent = periodRows(config, config.current_start, config.current_end, false);
    const benchmarkBase = periodRows(config, config.base_start, config.base_end, false);
    const cityCurrentPrice = finite(metricValue(benchmarkCurrent.map(row => row.unit_price), config.metric));
    const cityBasePrice = finite(metricValue(benchmarkBase.map(row => row.unit_price), config.metric));
    const cityChange = finite(safeChange(cityCurrentPrice, cityBasePrice));
    const keys = config.level === "district" ? ["district"] : ["district", "business_area", "community"];
    let merged = mergeAggregates(aggregate(current, keys, config.metric, "current"), aggregate(base, keys, config.metric, "base"), keys);
    qualify(merged, config, cityChange);
    if (config.level === "district") {
      const communityKeys = ["district", "business_area", "community"];
      const communities = mergeAggregates(aggregate(current, communityKeys, config.metric, "current"), aggregate(base, communityKeys, config.metric, "base"), communityKeys);
      qualify(communities, config, cityChange);
      const resilience = new Map();
      for (const row of communities.filter(row => row.eligible)) {
        const value = resilience.get(row.district) || { total: 0, resilient: 0 };
        value.total += 1; value.resilient += Number(row.price_change > cityChange); resilience.set(row.district, value);
      }
      for (const row of merged) {
        const value = resilience.get(row.district);
        row.resilient_ratio = value ? finite(value.resilient / value.total) : null;
        row.eligible_community_count = value?.total || 0;
      }
    }
    const sortKey = config.sort;
    const ascending = config.direction !== "desc";
    const rows = merged.filter(row => row.eligible).sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av == null) return 1; if (bv == null) return -1;
      return ascending ? av - bv : bv - av;
    }).slice(0, config.limit);

    const mapKeys = ["map_district"];
    const mapCurrent = periodRows({ ...config, district: "全部", business_area: "全部" }, config.current_start, config.current_end);
    const mapBase = periodRows({ ...config, district: "全部", business_area: "全部" }, config.base_start, config.base_end);
    const mapRows = mergeAggregates(aggregate(mapCurrent, mapKeys, config.metric, "current"), aggregate(mapBase, mapKeys, config.metric, "base"), mapKeys).map(row => ({
      district: row.map_district, price_change: finite(safeChange(row.current_price, row.base_price)),
      current_volume: row.current_volume || 0, base_volume: row.base_volume || 0,
      eligible: (row.current_volume || 0) >= config.min_current && (row.base_volume || 0) >= config.min_base &&
        (row.current_volume || 0) + (row.base_volume || 0) >= config.min_total,
    }));
    return {
      config,
      benchmark: {
        current_price: cityCurrentPrice, base_price: cityBasePrice, price_change: cityChange,
        current_volume: benchmarkCurrent.length, base_volume: benchmarkBase.length,
        volume_change: finite(safeChange(benchmarkCurrent.length, benchmarkBase.length)),
        current_area: finite(metricValue(benchmarkCurrent.map(row => row.area), "median")),
        base_area: finite(metricValue(benchmarkBase.map(row => row.area), "median")),
      },
      summary: { candidate_count: merged.length, eligible_count: merged.filter(row => row.eligible).length, returned_count: rows.length },
      rows, map: mapRows,
    };
  }

  async function trend(params) {
    const config = configFrom(params);
    const start = meta.date_min.slice(0, 7) > shiftMonth(config.end_month, -47) ? meta.date_min.slice(0, 7) : shiftMonth(config.end_month, -47);
    const selection = { level: text(params, "trend_level", "city"), name: text(params, "trend_name", "北京") };
    const rows = periodRows(config, start, config.end_month, true, selection.level === "city" ? null : selection);
    const points = monthRange(start, config.end_month).map(month => {
      const from = shiftMonth(month, -(config.window - 1));
      const windowRows = rows.filter(row => monthText(row.month) >= from && monthText(row.month) <= month);
      const monthRows = rows.filter(row => monthText(row.month) === month);
      return { month, price: finite(metricValue(windowRows.map(row => row.unit_price), config.metric)), volume: monthRows.length, window_volume: windowRows.length, area: finite(metricValue(windowRows.map(row => row.area), "median")) };
    });
    return { ...selection, points };
  }

  async function communityDetail(params) {
    const config = configFrom(params);
    const district = text(params, "district"), businessArea = text(params, "business_area"), community = text(params, "community");
    const rows = query(`
      SELECT t.sale_date, t.sale_month, l.name layout, o.name orientation, f.name floor,
             t.area / 100.0 area, t.listing_price / 100.0 listing_price, t.sale_price / 100.0 sale_price,
             t.unit_price, t.cycle_days, t.source_code
      FROM transactions t JOIN communities c ON c.id=t.community_id
      JOIN business_areas b ON b.id=c.business_area_id JOIN districts d ON d.id=b.district_id
      JOIN layouts l ON l.id=t.layout_id JOIN orientations o ON o.id=t.orientation_id JOIN floors f ON f.id=t.floor_id
      WHERE d.name=? AND b.name=? AND c.name=? ORDER BY t.sale_date
    `, [district, businessArea, community]);
    if (!rows.length) throw new Error("未找到该小区的成交记录");
    const months = monthRange(monthText(rows[0].sale_month), monthText(rows[rows.length - 1].sale_month));
    const monthly = months.map(month => {
      const sample = rows.filter(row => monthText(row.sale_month) === month);
      return { month, volume: sample.length, median_price: finite(metricValue(sample.map(row => row.unit_price), "median")), mean_price: finite(metricValue(sample.map(row => row.unit_price), "mean")), median_area: finite(metricValue(sample.map(row => row.area), "median")) };
    });
    const rolling = months.map(month => {
      const start = shiftMonth(month, -(config.window - 1));
      const sample = rows.filter(row => monthText(row.sale_month) >= start && monthText(row.sale_month) <= month);
      const listing = sample.filter(row => row.listing_price > 0 && row.area > 0);
      return { month, price: finite(metricValue(sample.map(row => row.unit_price), config.metric)), sample_count: sample.length,
        listing_price: finite(metricValue(listing.map(row => row.listing_price * 10000 / row.area), config.metric)), listing_sample_count: listing.length };
    });
    const current = rows.filter(row => monthText(row.sale_month) >= config.current_start && monthText(row.sale_month) <= config.current_end);
    const base = rows.filter(row => monthText(row.sale_month) >= config.base_start && monthText(row.sale_month) <= config.base_end);
    const currentPrice = finite(metricValue(current.map(row => row.unit_price), config.metric));
    const basePrice = finite(metricValue(base.map(row => row.unit_price), config.metric));
    return {
      community, district, business_area: businessArea, config,
      summary: {
        transaction_count: rows.length, first_date: dateText(rows[0].sale_date), last_date: dateText(rows[rows.length - 1].sale_date),
        overall_median_price: finite(metricValue(rows.map(row => row.unit_price), "median")), overall_median_area: finite(metricValue(rows.map(row => row.area), "median")),
        average_monthly_volume: finite(rows.length / new Set(rows.map(row => row.sale_month)).size), current_price: currentPrice, base_price: basePrice,
        price_change: finite(safeChange(currentPrice, basePrice)), current_volume: current.length, base_volume: base.length,
        current_monthly_average: finite(current.length / monthRange(config.current_start, config.current_end).length),
        base_monthly_average: finite(base.length / monthRange(config.base_start, config.base_end).length),
      },
      monthly, rolling,
      transactions: rows.slice().reverse().map(row => ({
        sale_date: dateText(row.sale_date), layout: row.layout, orientation: row.orientation, floor: row.floor,
        area: row.area, listing_price: row.listing_price, sale_price: row.sale_price, unit_price: row.unit_price,
        listing_unit_price: row.listing_price > 0 && row.area > 0 ? row.listing_price * 10000 / row.area : null,
        cycle_days: row.cycle_days, url: /^\d{12}$/.test(String(row.source_code)) ? `https://bj.ke.com/chengjiao/${row.source_code}.html` : "",
      })),
    };
  }

  async function communityHeatmap(params) {
    const query = new URLSearchParams(params); query.set("level", "community"); query.set("limit", "500");
    const result = await analyze(query);
    return {config:result.config, summary:result.summary, rows:result.rows};
  }
  window.DashboardData = { initialize, searchCommunities, analyze, trend, communityDetail, communityHeatmap };
})();
