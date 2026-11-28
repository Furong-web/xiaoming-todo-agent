import { useEffect, useMemo, useState } from "react";
import { listHistory, type HistoryRecord } from "./history-client.ts";

/** YYYY-MM-DD 转成本地 Date（用本地构造，避免被当成 UTC 而错位一天）。 */
function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function shiftDays(day: string, offset: number): string {
  const date = parseDay(day);
  date.setDate(date.getDate() + offset);
  return localDay(date);
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 日期标题：今天 / 昨天 / 11 月 26 日 周三。 */
function dayLabel(day: string, today: string): string {
  if (day === today) return "今天";
  if (day === shiftDays(today, -1)) return "昨天";
  const date = parseDay(day);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${WEEKDAYS[date.getDay()]}`;
}

/** 短标题：11/26。 */
function shortDay(day: string): string {
  const date = parseDay(day);
  return `${date.getMonth() + 1}/${date.getDate()}`;
}

/**
 * 归到所在周的周一。历史按「周」折叠成文件夹，
 * 从周一开始才能保证周一到周日正好是一个完整的文件夹。
 */
function weekStart(day: string): string {
  const date = parseDay(day);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return localDay(date);
}

interface WeekFolder {
  /** 周一日期，同时作为文件夹的 key */
  start: string;
  end: string;
  /** 当周有记录的天数 */
  dayCount: number;
  records: HistoryRecord[];
  /** 本周是否还缺记录（用于「这周还没结束」的提示） */
  partial: boolean;
}

/** 把按日期倒序的记录折叠成周文件夹，最新的周排在前面。 */
function buildWeeks(records: HistoryRecord[], today: string): WeekFolder[] {
  const map = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const key = weekStart(record.date);
    const bucket = map.get(key);
    if (bucket) bucket.push(record);
    else map.set(key, [record]);
  }

  return [...map.entries()]
    .map(([start, items]) => {
      const end = shiftDays(start, 6);
      return {
        start,
        end,
        records: items,
        dayCount: new Set(items.map((item) => item.date)).size,
        partial: start <= today && today <= end,
      };
    })
    .sort((a, b) => (a.start < b.start ? 1 : -1));
}

/** 周文件夹标题：本周 / 上周 / 11 月 17 日 - 11 月 23 日。 */
function weekLabel(folder: WeekFolder, today: string): string {
  const currentStart = weekStart(today);
  if (folder.start === currentStart) return "本周";
  if (folder.start === shiftDays(currentStart, -7)) return "上周";
  return `${shortDay(folder.start)} - ${shortDay(folder.end)}`;
}

/** 把记录按归属日期分组，日期新的在前。 */
function buildDays(records: HistoryRecord[]): Array<{ date: string; items: HistoryRecord[] }> {
  const map = new Map<string, HistoryRecord[]>();
  for (const record of records) {
    const bucket = map.get(record.date);
    if (bucket) bucket.push(record);
    else map.set(record.date, [record]);
  }
  return [...map.entries()]
    .map(([date, items]) => ({
      date,
      items: [...items].sort((a, b) => (b.completedAt ?? "").localeCompare(a.completedAt ?? "")),
    }))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function formatTime(iso?: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

interface HistoryViewProps {
  /** 与清单共用刷新信号：清单里删掉任务后会重新拉历史 */
  refreshKey: number;
}

export function HistoryView({ refreshKey }: HistoryViewProps) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [keyword, setKeyword] = useState("");
  /** 空字符串表示不限日期 */
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  /** 搜索/日期变化后自动展开命中的文件夹，但用户手动折叠过的不再强制打开 */
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});

  const today = localDay(new Date());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    listHistory({ from: from || undefined, to: to || undefined, q: keyword.trim() || undefined })
      .then((result) => {
        if (cancelled) return;
        setRecords(result);
        setError("");
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "加载失败");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey, from, to, keyword]);

  const weeks = useMemo(() => buildWeeks(records, today), [records, today]);
  const totalDays = useMemo(() => new Set(records.map((item) => item.date)).size, [records]);
  const filtering = Boolean(keyword.trim() || from || to);

  /** 筛选后默认展开命中的周，平时默认都折叠成文件夹。 */
  const isOpen = (folder: WeekFolder) =>
    overrides[folder.start] ?? (filtering ? true : folder.partial);

  const toggle = (folder: WeekFolder) =>
    setOverrides((prev) => ({ ...prev, [folder.start]: !isOpen(folder) }));

  function pickRange(days: number) {
    setFrom(shiftDays(today, -(days - 1)));
    setTo(today);
    setOverrides({});
  }

  function clearFilters() {
    setKeyword("");
    setFrom("");
    setTo("");
    setOverrides({});
  }

  return (
    <div className="board history">
      <div className="board-heading">
        <strong>任务历史</strong>
        <span>
          {records.length === 0
            ? "还没有历史记录"
            : `${records.length} 条已完成 · 覆盖 ${totalDays} 天`}
        </span>
      </div>

      <div className="history-filters">
        <input
          type="search"
          className="history-search"
          placeholder="搜索任务关键词…"
          value={keyword}
          onChange={(event) => {
            setKeyword(event.target.value);
            setOverrides({});
          }}
          aria-label="搜索历史任务"
        />
        <div className="history-dates">
          <label>
            从
            <input
              type="date"
              value={from}
              max={to || today}
              onChange={(event) => {
                setFrom(event.target.value);
                setOverrides({});
              }}
            />
          </label>
          <label>
            到
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(event) => {
                setTo(event.target.value);
                setOverrides({});
              }}
            />
          </label>
          <button type="button" className="history-chip" onClick={() => pickRange(7)}>
            近 7 天
          </button>
          <button type="button" className="history-chip" onClick={() => pickRange(30)}>
            近 30 天
          </button>
          {filtering && (
            <button type="button" className="history-chip clear" onClick={clearFilters}>
              清除筛选
            </button>
          )}
        </div>
      </div>

      {error && <p className="board-error" role="alert">{error}</p>}
      {loading && <p className="board-empty">加载中…</p>}
      {!loading && records.length === 0 && (
        <p className="board-empty">
          {filtering
            ? "这段时间没有匹配的记录，换个关键词或日期试试。"
            : "在清单里勾选完成的任务都会记录在这里，按周整理成文件夹。"}
        </p>
      )}

      {weeks.map((folder) => {
        const open = isOpen(folder);
        return (
          <section className={`history-folder${open ? " is-open" : ""}`} key={folder.start}>
            <button
              type="button"
              className="history-folder-head"
              onClick={() => toggle(folder)}
              aria-expanded={open}
            >
              <span className="history-folder-icon" aria-hidden="true">
                {open ? "📂" : "📁"}
              </span>
              <span className="history-folder-name">{weekLabel(folder, today)}</span>
              <span className="history-folder-range">
                {shortDay(folder.start)} - {shortDay(folder.end)}
                {folder.partial ? " · 进行中" : ""}
              </span>
              <span className="board-count">
                {folder.records.length} 条 / {folder.dayCount} 天
              </span>
              <span className="history-folder-arrow" aria-hidden="true">
                {open ? "▾" : "▸"}
              </span>
            </button>

            {open && (
              <div className="history-days">
                {buildDays(folder.records).map((day) => (
                  <div className="history-day" key={day.date}>
                    <div className="history-day-head">
                      <span>{dayLabel(day.date, today)}</span>
                      <small>{day.items.length} 条</small>
                    </div>
                    <ul className="history-items">
                      {day.items.map((record) => (
                        <li key={record.id}>
                          <span className="history-dot" aria-hidden="true">
                            ✓
                          </span>
                          <span className="history-title">{record.title}</span>
                          {record.parentTitle && (
                            <span className="history-parent">· {record.parentTitle}</span>
                          )}
                          {record.module && <span className="history-tag">{record.module}</span>}
                          <span className="history-time">
                            {formatTime(record.completedAt) || "无完成时刻"}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
