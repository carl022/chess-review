import { useEffect, useRef, useState } from "react";

const API = import.meta.env.VITE_API_URL ?? "http://localhost:8000";
const STD = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const GLYPH = { k: "♚", q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const LABELS = {
  brilliant: ["!!", "Brilliant"], great: ["!", "Great"], best: ["★", "Best"],
  excellent: ["✓", "Excellent"], good: ["✓", "Good"], forced: ["→", "Forced"],
  inaccuracy: ["?!", "Inaccuracy"], miss: ["✗", "Miss"], mistake: ["?", "Mistake"], blunder: ["??", "Blunder"],
};
const SAMPLE = `[White "Morphy"]
[Black "Duke Karl / Count Isouard"]

1. e4 e5 2. Nf3 d6 3. d4 Bg4 4. dxe5 Bxf3 5. Qxf3 dxe5 6. Bc4 Nf6 7. Qb3 Qe7 8. Nc3 c6 9. Bg5 b5 10. Nxb5 cxb5 11. Bxb5+ Nbd7 12. O-O-O Rd8 13. Rxd7 Rxd7 14. Rd1 Qe6 15. Bxd7+ Nxd7 16. Qb8+ Nxb8 17. Rd8# 1-0`;

const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-1000, Math.min(1000, cp)))) - 1);
const evalText = (cp) => (Math.abs(cp) >= 10000 ? "M" : (cp / 100).toFixed(1));
const parseFen = (fen) =>
  fen.split(" ")[0].split("/").flatMap((row) => [...row].flatMap((c) => (/\d/.test(c) ? Array(+c).fill(null) : [c])));
const sqIndex = (s) => 8 * (8 - +s[1]) + (s.charCodeAt(0) - 97);

function Board({ fen, flipped, move, badge, arrow }) {
  const cells = parseFen(fen);
  const from = move ? sqIndex(move.slice(0, 2)) : -1;
  const to = move ? sqIndex(move.slice(2, 4)) : -1;
  const xy = (i) => [flipped ? 7 - (i & 7) : i & 7, flipped ? 7 - (i >> 3) : i >> 3];
  let a;
  if (arrow) {
    const [x1, y1] = xy(sqIndex(arrow.slice(0, 2)));
    const [x2, y2] = xy(sqIndex(arrow.slice(2, 4)));
    a = { x1: x1 + 0.5, y1: y1 + 0.5, x2: x2 + 0.5, y2: y2 + 0.5 };
  }
  return (
    <div className="board" role="img" aria-label="Chess board">
      {Array.from({ length: 64 }, (_, d) => {
        const i = flipped ? 63 - d : d;
        const p = cells[i];
        const dark = ((i >> 3) + (i & 7)) % 2 === 1;
        return (
          <div key={d} className={`sq ${dark ? "dark" : "light"} ${i === from || i === to ? "hl" : ""}`}>
            {p && <span className={`piece ${p === p.toUpperCase() ? "w" : "b"}`}>{GLYPH[p.toLowerCase()] + "\uFE0E"}</span>}
            {i === to && badge && (
              <span className="badge" style={{ background: `var(--${badge})` }}>{LABELS[badge][0]}</span>
            )}
          </div>
        );
      })}
      {a && (
        <svg className="arrow" viewBox="0 0 8 8">
          <defs>
            <marker id="ah" markerWidth="3.2" markerHeight="3.2" refX="1.6" refY="1.6" orient="auto">
              <path d="M0,0 L3.2,1.6 L0,3.2z" fill="var(--great)" />
            </marker>
          </defs>
          <line {...a} stroke="var(--great)" strokeWidth=".2" strokeLinecap="round" markerEnd="url(#ah)" opacity=".9" />
        </svg>
      )}
    </div>
  );
}

function Graph({ series, ply, onPick }) {
  const W = 400, H = 84, n = Math.max(1, series.length - 1);
  const x = (i) => (i / n) * W;
  const y = (v) => H - (v / 100) * H;
  const line = series.map((s, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(s.pct).toFixed(1)}`).join("");
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    onPick(Math.round(((e.clientX - r.left) / r.width) * n));
  };
  return (
    <svg className="graph" viewBox={`0 0 ${W} ${H}`} onClick={pick} aria-label="Win chance graph">
      <path d={`${line}L${W},${H}L0,${H}Z`} className="area" />
      <line x1="0" x2={W} y1={H / 2} y2={H / 2} className="mid" />
      <path d={line} className="curve" />
      {series.map((s, i) =>
        ["brilliant", "great", "miss", "mistake", "blunder"].includes(s.label) ? (
          <circle key={i} cx={x(i)} cy={y(s.pct)} r="3.4" fill={`var(--${s.label})`} />
        ) : null
      )}
      <line x1={x(ply)} x2={x(ply)} y1="0" y2={H} className="cursor" />
    </svg>
  );
}

function Summary({ name, color, data }) {
  const shown = Object.keys(LABELS).filter((k) => data.counts[k] && !["good", "forced"].includes(k));
  return (
    <div className="card">
      <div className="who">{color === "white" ? "White" : "Black"} · {name}</div>
      <div className="acc">{data.accuracy ?? "–"}<small>accuracy</small></div>
      <div className="chips">
        {shown.map((k) => (
          <span key={k} className="chip"><i style={{ background: `var(--${k})` }} />{data.counts[k]} {LABELS[k][1].toLowerCase()}</span>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [pgn, setPgn] = useState("");
  const [depth, setDepth] = useState(16);
  const [review, setReview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [ply, setPly] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [showBest, setShowBest] = useState(false);
  const activeRef = useRef(null);

  useEffect(() => setShowBest(false), [ply]);
  useEffect(() => activeRef.current?.scrollIntoView({ block: "nearest" }), [ply]);
  useEffect(() => {
    if (!review) return;
    const n = review.moves.length;
    const onKey = (e) => {
      if (["TEXTAREA", "SELECT", "INPUT"].includes(e.target.tagName)) return;
      if (e.key === "ArrowRight") setPly((p) => Math.min(n, p + 1));
      else if (e.key === "ArrowLeft") setPly((p) => Math.max(0, p - 1));
      else if (e.key === "Home") setPly(0);
      else if (e.key === "End") setPly(n);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [review]);

  async function run() {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`${API}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pgn, depth }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "The review failed.");
      setReview(data);
      setPly(0);
    } catch (e) {
      setError(e instanceof TypeError ? `Can't reach the review server at ${API}. Is uvicorn running?` : e.message);
    } finally {
      setLoading(false);
    }
  }

  if (!review) {
    return (
      <main className="intake">
        <h1>Review a game</h1>
        <p className="lede">Paste a PGN from Chess.com or Lichess. Stockfish checks every move and labels it.</p>
        <textarea value={pgn} onChange={(e) => setPgn(e.target.value)} placeholder="[Event &quot;Live Chess&quot;] 1. e4 e5 2. Nf3 …" rows={10} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row">
          <button className="primary" disabled={loading || !pgn.trim()} onClick={run}>
            {loading ? "Analyzing…" : "Review game"}
          </button>
          <button onClick={() => setPgn(SAMPLE)} disabled={loading}>Use sample game</button>
          <label className="depth">
            Depth
            <select value={depth} onChange={(e) => setDepth(+e.target.value)} disabled={loading}>
              <option value={12}>12 · fast</option>
              <option value={16}>16 · balanced</option>
              <option value={20}>20 · deep</option>
            </select>
          </label>
        </div>
        {loading && <p className="hint">Long games can take a minute at higher depths.</p>}
      </main>
    );
  }

  const moves = review.moves;
  const m = ply > 0 ? moves[ply - 1] : null;
  const startFen = review.headers.FEN || STD;
  const fenAfter = m ? m.fen_after : startFen;
  const fenBefore = ply > 1 ? moves[ply - 2].fen_after : startFen;
  const cp = m ? m.eval_cp : review.start_eval_cp;
  const pct = m ? m.win_pct : winPct(cp);
  const series = [{ pct: winPct(review.start_eval_cp) }, ...moves.map((mv) => ({ pct: mv.win_pct, label: mv.label }))];
  const rows = [];
  for (let i = 0; i < moves.length; i += 2) rows.push([moves[i], moves[i + 1]]);
  const canShowBest = m && m.best_uci !== m.uci;

  const cell = (mv) =>
    mv && (
      <button
        ref={mv.ply === ply ? activeRef : null}
        className={`mv ${mv.ply === ply ? "on" : ""}`}
        onClick={() => setPly(mv.ply)}
      >
        <i style={{ background: `var(--${mv.label})` }} />
        {mv.san}<b>{mv.symbol}</b>
      </button>
    );

  return (
    <main className="review">
      <section className="stage">
        <div className="evalbar" style={{ justifyContent: flipped ? "flex-start" : "flex-end" }} title={`${pct.toFixed(0)}% White`}>
          <div className="fill" style={{ height: `${pct}%` }} />
          <span className={pct >= 50 ? "lo" : "hi"} style={{ [(pct >= 50) !== flipped ? "bottom" : "top"]: 4 }}>{evalText(cp)}</span>
        </div>
        <div className="boardcol">
          <Board
            fen={showBest && m ? fenBefore : fenAfter}
            flipped={flipped}
            move={showBest ? null : m?.uci}
            badge={showBest ? null : m?.label}
            arrow={showBest && m ? m.best_uci : null}
          />
          <div className="controls">
            <button onClick={() => setPly(0)} aria-label="Start">⏮</button>
            <button onClick={() => setPly(Math.max(0, ply - 1))} aria-label="Previous move">◀</button>
            <button onClick={() => setPly(Math.min(moves.length, ply + 1))} aria-label="Next move">▶</button>
            <button onClick={() => setPly(moves.length)} aria-label="End">⏭</button>
            <button onClick={() => setFlipped(!flipped)}>Flip board</button>
          </div>
        </div>
      </section>

      <section className="side">
        <div className="cards">
          <Summary name={review.headers.White ?? "?"} color="white" data={review.summary.white} />
          <Summary name={review.headers.Black ?? "?"} color="black" data={review.summary.black} />
        </div>

        <Graph series={series} ply={ply} onPick={(i) => setPly(Math.max(0, Math.min(moves.length, i)))} />

        <div className="verdict" aria-live="polite">
          {m ? (
            <>
              <div className="vhead">
                <span className="tag" style={{ background: `var(--${m.label})` }}>{LABELS[m.label][1]}</span>
                <strong>{m.move_number}{m.color === "white" ? "." : "…"} {m.san}</strong>
              </div>
              <p>{m.comment || `${m.san} is a solid move.`}</p>
              {canShowBest && (
                <button onClick={() => setShowBest(!showBest)}>{showBest ? "Back to the game" : "Show best move"}</button>
              )}
            </>
          ) : (
            <p>Start position. Use ◀ ▶ or the arrow keys to step through the game.</p>
          )}
        </div>

        <div className="moves">
          {rows.map(([w, b], i) => (
            <div className="pair" key={i}>
              <span className="num">{i + 1}</span>
              {cell(w)}
              {cell(b) || <span />}
            </div>
          ))}
        </div>

        <button className="ghost" onClick={() => { setReview(null); setError(""); }}>Review another game</button>
      </section>
    </main>
  );
}
