import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const rupiahFull = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

const shortDateFormatter = new Intl.DateTimeFormat("id-ID", {
  day: "numeric",
  month: "short",
});

const fullDateFormatter = new Intl.DateTimeFormat("id-ID", {
  weekday: "short",
  day: "numeric",
  month: "long",
  year: "numeric",
});

function formatShortDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return shortDateFormatter.format(date);
}

function formatFullDate(dateKey) {
  const date = new Date(`${dateKey}T00:00:00`);
  if (Number.isNaN(date.getTime())) return dateKey;
  return fullDateFormatter.format(date);
}

function formatCompactRupiah(value) {
  if (value === 0) return "Rp 0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `Rp ${(value / 1_000_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} M`;
  }
  if (abs >= 1_000_000) {
    return `Rp ${(value / 1_000_000).toLocaleString("id-ID", { maximumFractionDigits: 1 })} jt`;
  }
  if (abs >= 1_000) {
    return `Rp ${(value / 1_000).toLocaleString("id-ID", { maximumFractionDigits: 0 })} rb`;
  }
  return rupiahFull.format(value);
}

function RevenueTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;

  return (
    <div className="trend-tooltip">
      <div className="trend-tooltip-date">{formatFullDate(point.date)}</div>
      <div className="trend-tooltip-row">
        <span>Pendapatan selesai</span>
        <strong>{rupiahFull.format(point.revenue)}</strong>
      </div>
      <div className="trend-tooltip-row">
        <span>Transaksi</span>
        <span>{point.transactions} transaksi</span>
      </div>
    </div>
  );
}

function RevenueTrendChart({
  data = [],
  from,
  to,
  isSingleDayRange = false,
  loading = false,
  onOpenCashier,
}) {
  const chartData = data.map((entry) => ({
    ...entry,
    shortDate: formatShortDate(entry.date),
  }));

  const totalRevenue = chartData.reduce((sum, item) => sum + item.revenue, 0);
  const totalTransactions = chartData.reduce((sum, item) => sum + item.transactions, 0);

  return (
    <section className="store-report-list revenue-trend-card" aria-label="Grafik tren pendapatan harian">
      <div className="trend-header">
        <div>
          <h2>Tren pendapatan harian</h2>
          <p className="trend-meta">
            <span>{isSingleDayRange ? "7 hari terakhir" : `${from} — ${to}`}</span>
            <span aria-hidden="true">·</span>
            <span>{totalTransactions} transaksi selesai</span>
            <span aria-hidden="true">·</span>
            <strong>{rupiahFull.format(totalRevenue)}</strong>
          </p>
        </div>
      </div>

      {loading && !chartData.length ? (
        <div className="trend-skeleton" aria-busy="true" aria-label="Memuat grafik tren pendapatan" />
      ) : (
        <>
          <div className="trend-chart-wrap">
            <ResponsiveContainer width="100%" height={260}>
              <LineChart data={chartData} margin={{ top: 14, right: 18, left: 6, bottom: 4 }}>
                <CartesianGrid stroke="#edf1ee" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="shortDate"
                  tick={{ fill: "#839088", fontSize: 11 }}
                  axisLine={{ stroke: "#e5ebe6" }}
                  tickLine={false}
                  minTickGap={18}
                />
                <YAxis
                  tickFormatter={formatCompactRupiah}
                  tick={{ fill: "#839088", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={74}
                  allowDecimals={false}
                />
                <Tooltip content={<RevenueTooltip />} />
                <Line
                  type="monotone"
                  dataKey="revenue"
                  name="Pendapatan harian"
                  stroke="#2f8259"
                  strokeWidth={2.5}
                  dot={{ r: 3.5, fill: "#2f8259", stroke: "#ffffff", strokeWidth: 1.5 }}
                  activeDot={{ r: 5.5, fill: "#246e4b", stroke: "#ffffff", strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          {totalTransactions === 0 && (
            <div className="trend-empty-note">
              <span>Belum ada penjualan selesai pada rentang tanggal ini.</span>
              {onOpenCashier && (
                <button type="button" className="text-button" onClick={onOpenCashier}>
                  Catat transaksi di Kasir <span>→</span>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default RevenueTrendChart;
