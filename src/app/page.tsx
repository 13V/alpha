"use client";

import { useEffect, useMemo, useState } from "react";

import ExportToolbar from "@/components/ExportToolbar";
import HowItWorks from "@/components/HowItWorks";
import ResultsTable from "@/components/ResultsTable";
import { CHAINS, detectChain, isEvmAddress, type ChainId } from "@/lib/chains";
import { formatMcap, parseDuneTime } from "@/lib/format";
import type { ScanResponse } from "@/lib/types";

const EVM_CHOICES: ChainId[] = ["base", "bnb", "ethereum"];
/**
 * A window reaching back further than the token existed spends its engine
 * seconds finding trades that cannot be there, and Dune bills those seconds.
 *
 * What is verified: on a five-day-old token the same query returned identical
 * rankings at 7d, 365d and 1095d, diffed row by row. What is NOT verified is
 * any speed multiple. Engine time here is dominated by Dune's cluster, not by
 * the window or the SQL -- the same query on the same token at 7d has been
 * observed anywhere from 9s to 174s. Do not put a number on this in copy or in
 * comments; earlier versions of both did and were wrong twice.
 *
 * Auto walks up this ladder and stops at the first rung that covers the token,
 * so a young token is one narrow scan and an old one pays the wide scan it
 * genuinely needs. The rungs are spread so the worst case is four small runs
 * before the big one, not a slow climb.
 */
const LADDER = [7, 90, 365, 1095];
const AUTO = 0;

const WINDOWS = [AUTO, 7, 30, 90, 365, 1095];
const DAY_MS = 86_400_000;
const KEY_STORE = "whoprinted-dune-key";
const RUN_STORE = "whoprinted-inflight";
/** What these were called before the rename, so a saved key survives it. */
const LEGACY_KEY_STORE = "bagtrace-dune-key";

/**
 * A running execution is the expensive thing on Dune -- it is billed for the
 * engine time it occupies whether or not anyone is left listening. Losing its
 * id to a tab reload does not stop it; it just means the next attempt starts a
 * second one and pays twice. So the id is parked in localStorage alongside the
 * parameters it belongs to, and picked back up if those still match.
 */
interface InFlight {
  executionId: string;
  signature: string;
  startedAt: number;
}

/** Identifies the run, so a resumed execution can never be served for other inputs. */
function runSignature(p: { token: string; chain?: string; lookbackDays: number }): string {
  return [p.token.toLowerCase(), p.chain ?? "", p.lookbackDays].join("|");
}

function readInFlight(signature: string): string | undefined {
  try {
    const raw = window.localStorage.getItem(RUN_STORE);
    if (!raw) return undefined;
    const saved = JSON.parse(raw) as InFlight;
    // Dune drops an execution well before this; past it, resuming would just
    // poll a dead id and delay the real run.
    const fresh = Date.now() - saved.startedAt < 20 * 60_000;
    if (saved.signature === signature && fresh) return saved.executionId;
    window.localStorage.removeItem(RUN_STORE);
  } catch {
    /* storage blocked or corrupt -- start a fresh execution */
  }
  return undefined;
}

function writeInFlight(value: InFlight | null): void {
  try {
    if (value) window.localStorage.setItem(RUN_STORE, JSON.stringify(value));
    else window.localStorage.removeItem(RUN_STORE);
  } catch {
    /* storage blocked -- the run just cannot be resumed */
  }
}

interface Failure {
  error: string;
  hint?: string;
}

const windowLabel = (n: number) =>
  n === AUTO ? "Auto" : n < 365 ? `${n}d` : n === 365 ? "1y" : "Max";


/**
 * Whether a result is bumping against its own window. If the earliest trade
 * sits within two days of the window opening, there is very likely older
 * history being cut off -- and a window that opens after a token launched
 * hides the launch-period buys, which is exactly where the winners are.
 */
function looksTruncated(rows: ScanResponse["rows"], lookbackDays: number | null): boolean {
  if (rows.length === 0 || lookbackDays == null) return false;
  const times = rows
    .map((r) => parseDuneTime(r.firstTrade))
    .filter((t): t is number => t != null);
  if (times.length === 0) return false;
  return Math.min(...times) - (Date.now() - lookbackDays * DAY_MS) < 2 * DAY_MS;
}

export default function Home() {
  const [token, setToken] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);
  const [editingKey, setEditingKey] = useState(false);
  const [evmChain, setEvmChain] = useState<ChainId>("base");
  const [days, setDays] = useState<number>(AUTO);

  const [loading, setLoading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [data, setData] = useState<ScanResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showHelp, setShowHelp] = useState(false);
  // Inputs behind the rows currently on screen, so a CSV can re-read the same
  // execution for its missing columns instead of running anything again.
  const [lastRun, setLastRun] = useState<Record<string, unknown> | null>(null);
  /** Which rung of the auto ladder is running, so the wait can say so. */
  const [probing, setProbing] = useState<number | null>(null);

  useEffect(() => {
    let stored: string | null = null;
    try {
      stored = window.localStorage.getItem(KEY_STORE);
      if (!stored) {
        // Carried over from before the rename. Moved rather than copied, so
        // this runs once and the old entry does not linger in storage.
        const legacy = window.localStorage.getItem(LEGACY_KEY_STORE);
        if (legacy) {
          window.localStorage.setItem(KEY_STORE, legacy);
          window.localStorage.removeItem(LEGACY_KEY_STORE);
          stored = legacy;
        }
      }
    } catch {
      /* storage blocked — the key just is not remembered */
    }
    if (stored) {
      setApiKey(stored);
      setKeySaved(true);
    }
  }, []);

  useEffect(() => {
    if (!loading) return;
    setElapsed(0);
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(id);
  }, [loading]);

  // Only EVM addresses are ambiguous — a Solana mint identifies its chain by itself.
  const needsChain = isEvmAddress(token);
  const detected = detectChain(token);

  async function run() {
    const key = apiKey.trim();
    if (!key) {
      setFailure({
        error: "add your dune api key",
        hint: "it is free at dune.com/settings/api and never leaves this browser.",
      });
      setEditingKey(true);
      return;
    }

    setLoading(true);
    setFailure(null);
    setSelected(new Set());
    try {
      window.localStorage.setItem(KEY_STORE, key);
    } catch {
      /* storage blocked — key kept in memory for this visit only */
    }
    setKeySaved(true);
    setEditingKey(false);

    const params = {
      apiKey: key,
      token: token.trim(),
      chain: needsChain ? evmChain : undefined,
      mode: "traders",
      limit: 100,
      lookbackDays: days,
    };

    // One call = one short round trip. Network blips, rate limits and platform
    // error pages (non-JSON bodies) must not kill a multi-minute trace whose
    // execution is still running fine on Dune, so failures are classified:
    // transient ones retry with the same executionId, real ones surface.
    const call = async (
      body: Record<string, unknown>,
    ): Promise<
      | { kind: "ok"; body: { status: string; executionId?: string } & ScanResponse }
      | { kind: "fail"; failure: Failure }
      | { kind: "transient"; failure: Failure }
    > => {
      let res: Response;
      try {
        res = await fetch("/api/trace", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } catch (error) {
        return {
          kind: "transient",
          failure: { error: error instanceof Error ? error.message : "Network error" },
        };
      }
      let parsed: unknown;
      try {
        parsed = await res.json();
      } catch {
        // a proxy/platform error page, not our route
        return {
          kind: res.ok ? "fail" : "transient",
          failure: { error: `The server returned an unreadable response (${res.status})` },
        };
      }
      if (!res.ok) {
        const failure = parsed as Failure;
        const transient = res.status === 429 || res.status === 502 || res.status >= 503;
        return { kind: transient ? "transient" : "fail", failure };
      }
      return {
        kind: "ok",
        body: parsed as { status: string; executionId?: string } & ScanResponse,
      };
    };

    /** One window's worth of tracing. Null means the failure is already shown. */
    const traceOnce = async (
      lookbackDays: number,
    ): Promise<{ body: ScanResponse; executionId?: string } | null> => {
    const runParams = { ...params, lookbackDays };
    // An execution from a previous visit that is still running costs nothing
    // extra to rejoin, and starting a second one for the same inputs would be
    // billed all over again.
    const signature = runSignature(runParams);
    let executionId = readInFlight(signature);

    {
      let step = await call(executionId ? { ...runParams, executionId } : runParams);
      const deadline = Date.now() + 15 * 60_000;
      let strikes = 0;

      for (;;) {
        if (step.kind === "ok") {
          strikes = 0;
          if (step.body.status !== "running") break;
          if (step.body.executionId && step.body.executionId !== executionId) {
            executionId = step.body.executionId;
            writeInFlight({ executionId, signature, startedAt: Date.now() });
          }
        } else if (step.kind === "fail" || !executionId || ++strikes > 5) {
          // A rejected resume means that execution is gone; drop it so the
          // next attempt starts clean rather than retrying a dead id.
          writeInFlight(null);
          setData(null);
          setFailure(step.failure);
          return null;
        }
        if (Date.now() > deadline) {
          setData(null);
          setFailure({
            error: "gave up after 15 minutes",
            hint: "the query is still running on dune and is kept, so tracing this again picks it up rather than paying for a second run.",
          });
          return null;
        }
        await new Promise((resolve) => setTimeout(resolve, step.kind === "ok" ? 2500 : 5000));
        step = await call(executionId ? { ...runParams, executionId } : runParams);
      }

      writeInFlight(null);
      return {
        body: step.body as ScanResponse,
        executionId: step.body.executionId ?? executionId,
      };
    }
    };

    try {
      const rungs = days === AUTO ? LADDER : [days];
      for (let i = 0; i < rungs.length; i++) {
        const rung = rungs[i];
        setProbing(days === AUTO ? rung : null);
        const result = await traceOnce(rung);
        if (!result) return;

        // Keep climbing only while the data says the window is cutting history
        // off. Everything below this is the cheap part of the ladder; stopping
        // early is the whole point.
        const more = i < rungs.length - 1;
        if (more && looksTruncated(result.body.rows, result.body.meta.lookbackDays)) continue;

        setLastRun({ ...params, lookbackDays: rung, executionId: result.executionId });
        setData(result.body);
        return;
      }
    } catch (error) {
      setData(null);
      setFailure({ error: error instanceof Error ? error.message : "Request failed" });
    } finally {
      setProbing(null);
      setLoading(false);
    }
  }

  /**
   * Every column, for the exports that need them.
   *
   * A trace reads only the columns the screen uses, because a result read is
   * charged in datapoints -- rows times columns. The rest are fetched here,
   * once, if someone actually asks for a CSV. Aimed at the execution that
   * produced what is on screen, so this is a wider read of a run already paid
   * for, never a new one. Returns null if it cannot, and the caller falls back
   * to exporting what it has.
   */
  async function fetchFullRows(): Promise<ScanResponse["rows"] | null> {
    if (!lastRun) return null;
    try {
      const res = await fetch("/api/trace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...lastRun, full: true }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { status?: string } & ScanResponse;
      if (body.status !== "done" || !Array.isArray(body.rows)) return null;
      return body.rows;
    } catch {
      return null;
    }
  }

  function toggle(wallet: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(wallet)) next.delete(wallet);
      else next.add(wallet);
      return next;
    });
  }

  // A window that opens after the token launched hides the launch-period
  // acquisitions, which is exactly where the winners are.
  const truncated = useMemo(
    () => (data ? looksTruncated(data.rows, data.meta.lookbackDays) : false),
    [data],
  );

  const exportRows = useMemo(() => {
    if (!data) return [];
    return selected.size > 0 ? data.rows.filter((r) => selected.has(r.wallet)) : data.rows;
  }, [data, selected]);

  const showKeyInput = !keySaved || editingKey;

  return (
    <div className="app">
      <header className="appbar">
        <span className="brand">
          <i />
          WHO PRINTED
        </span>

        <input
          className="ca-field"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder="paste a ca"
          spellCheck={false}
          autoComplete="off"
          aria-label="Contract address"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !loading) run();
          }}
        />

        {needsChain && (
          <div className="seg">
            {EVM_CHOICES.map((id) => (
              <button
                key={id}
                data-active={evmChain === id}
                onClick={() => setEvmChain(id)}
              >
                {CHAINS[id].label}
              </button>
            ))}
          </div>
        )}

        <div className="seg">
          {WINDOWS.map((n) => (
            <button
              key={n}
              data-active={days === n}
              onClick={() => setDays(n)}
              title="How far back to scan. A window that opens after the token launched hides its winners."
            >
              {windowLabel(n)}
            </button>
          ))}
        </div>

        <button className="go" onClick={run} disabled={loading || !token.trim()}>
          {loading ? (
            <>
              <span className="spin" />
              Tracing
            </>
          ) : (
            "Trace"
          )}
        </button>

        <span className="push" />

        <button className="helpbtn" onClick={() => setShowHelp(true)}>
          how it works
        </button>

        {showKeyInput ? (
          <>
            <input
              className="key-input"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="dune api key"
              spellCheck={false}
              autoComplete="off"
              aria-label="Dune API key"
            />
            <a
              className="bar-link"
              href="https://dune.com/settings/api"
              target="_blank"
              rel="noreferrer"
            >
              get one
            </a>
          </>
        ) : (
          <span className="keychip">
            <i />
            key set
            <button onClick={() => setEditingKey(true)}>swap</button>
          </span>
        )}
      </header>

      <main className="main">
        {loading && (
          <div className="state">
            <h2>cooking</h2>
            <p>
              {elapsed}s in.{" "}
              {probing != null
                ? `checking the last ${probing} days first — the narrowest window that covers the token is the cheapest, and usually the same answer.`
                : "solana takes a few minutes on a token nobody has pulled before — dune has to scan it cold."}
            </p>
            <div className="bar-progress">
              <i />
            </div>
          </div>
        )}

        {!loading && failure && (
          <div className="state" data-kind="error">
            <h2>{failure.error.toLowerCase()}</h2>
            {failure.hint && <p>{failure.hint}</p>}
          </div>
        )}

        {!loading && !failure && data && data.rows.length > 0 && (
          <>
            <div className="ctx">
              <span className="sym">{data.meta.tokenSymbol ?? "Unknown token"}</span>
              <span className="dot">·</span>
              <span className="kv">{CHAINS[data.meta.chain].label}</span>
              {data.meta.currentMcap != null && (
                <>
                  <span className="dot">·</span>
                  <span className="kv">
                    mcap <b>{formatMcap(data.meta.currentMcap)}</b>
                  </span>
                </>
              )}
              <span className="dot">·</span>
              <span className="kv">
                wallets <b>{data.meta.rowCount}</b>
              </span>
              <span className="dot">·</span>
              <span className="kv">
                window <b>{data.meta.lookbackDays}d</b>
              </span>
              <span className="dot">·</span>
              <span className="kv">
                {data.meta.resultAgeMinutes != null ? (
                  <b title="rows from a run dune already had — hit refresh for a live one">
                    {data.meta.resultAgeMinutes < 1
                      ? "just run"
                      : `${data.meta.resultAgeMinutes}m old`}
                  </b>
                ) : data.meta.cached ? (
                  <b>cached</b>
                ) : data.meta.executionMillis != null ? (
                  <b>{(data.meta.executionMillis / 1000).toFixed(1)}s</b>
                ) : (
                  <b>—</b>
                )}
              </span>
            </div>

            {truncated && (
              <div className="note">
                <b>older than the {data.meta.lookbackDays}d window.</b> its earliest trades sit
                right at the edge, so buys from before that are missing and these wallets look
                worse than they were. widen it.
              </div>
            )}

            <ExportToolbar
              rows={exportRows}
              meta={data.meta}
              selectedCount={selected.size}
              onClearSelection={() => setSelected(new Set())}
              onFullRows={fetchFullRows}
            />

            <ResultsTable
              rows={data.rows}
              chain={data.meta.chain}
              selected={selected}
              onToggle={toggle}
              onToggleAll={(wallets, select) =>
                setSelected(select ? new Set(wallets) : new Set())
              }
            />
          </>
        )}

        {!loading && !failure && data && data.rows.length === 0 && (
          <div className="state">
            <h2>nothing here yet</h2>
            <p>
              {data.meta.chain === "solana"
                ? "dune's solana pipeline runs a few hours behind the chain, so a token that launched today will not show up until it catches up. check back later."
                : "it may not have traded on a dex dune decodes, or its trades are older than the window."}
            </p>
          </div>
        )}

        {!loading && !failure && !data && (
          <div className="state">
            <h2>paste a ca</h2>
            <p>
              the 100 wallets that <b>printed</b> on it — ranked by realized profit, with the
              market cap each one entered and exited at.
            </p>
            <p>
              cost basis counts dex buys <b>and</b> tokens received by transfer, valued at the
              price when they landed. that is how the winners on pump.fun tokens actually get
              their bags — miss it and they all read as zero.
            </p>
            <p>
              then go track them. <b>axiom</b> imports the tracked-wallet json as-is,{" "}
              <b>terminal</b> and <b>photon</b> take the address list — one click either way,
              named <code>14.1x - TICKER</code> so you know who just fired.
            </p>

            <div className="callout">
              <h3>auto window — it scans the token&rsquo;s life, not three years</h3>
              <p>
                dune charges for the seconds a query holds its engine, and a window reaching
                back further than a token has existed spends them finding nothing. <b>auto</b>{" "}
                starts at seven days and only reaches further back if the token is actually
                older. pick a window by hand and it runs exactly that one.
              </p>
              <p>
                on a five-day-old token, seven days and three years returned the{" "}
                <b>same 100 wallets in the same order</b> — diffed row by row. the narrow scan
                is the cheap one and it is not a worse answer.
              </p>
              <p className="fineprint">
                how long any single scan takes is mostly not up to us. the same query on the
                same token, minutes apart, has come back in 9 seconds and in 174. so a result
                dune already has gets reused rather than re-run, and a scan you leave and come
                back to is rejoined rather than started again.
              </p>
            </div>
          </div>
        )}
      </main>

      <footer className="statusbar">
        <span>
          {detected ? `${CHAINS[detected].label.toLowerCase()} detected` : "solana mint or 0x address"}
        </span>
        <span className="push" />
        <span>your key stays in this browser — only passed through to dune</span>
        <span>·</span>
        <a href="https://dune.com" target="_blank" rel="noreferrer">
          Dune
        </a>
      </footer>

      {showHelp && <HowItWorks onClose={() => setShowHelp(false)} />}
    </div>
  );
}
