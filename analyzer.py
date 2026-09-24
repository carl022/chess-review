"""Chess.com-style game review on top of Stockfish.

CLI:  python analyzer.py game.pgn [depth]
API:  review_pgn(pgn_text, depth=16) -> dict
"""
from __future__ import annotations

import io
import math
import os
import shutil
import sys
from dataclasses import dataclass, field

import chess
import chess.engine
import chess.pgn

PIECE_VALUES = {chess.PAWN: 1, chess.KNIGHT: 3, chess.BISHOP: 3, chess.ROOK: 5, chess.QUEEN: 9}
MATE_CP = 10000

# ---- Tunable thresholds (win-probability points on a 0..1 scale) -----------------
T_EXCELLENT, T_GOOD, T_INACCURACY, T_MISTAKE = 0.02, 0.05, 0.10, 0.20
GREAT_GAP = 0.15                   # best move beats 2nd-best by this much => "only move"
GREAT_MAX_WIN_BEFORE = 0.95        # no "great" when the game is already decided
BRILLIANT_MIN_SAC = 2              # pawns given up (minor piece for a pawn = 2)
BRILLIANT_MAX_WIN_BEFORE = 0.85    # not already crushing
BRILLIANT_MIN_WIN_AFTER = 0.45     # not losing after the sacrifice
MISS_OPP_LOSS = 0.10               # opponent erred by at least this much last move

SYMBOLS = {"brilliant": "!!", "great": "!", "best": "★", "excellent": "", "good": "",
           "forced": "", "inaccuracy": "?!", "miss": "✗", "mistake": "?", "blunder": "??"}


def win_prob(cp: float) -> float:
    """Centipawns (from one side's POV) -> win probability 0..1 (Lichess logistic fit)."""
    cp = max(-1000, min(1000, cp))
    return 0.5 + 0.5 * (2 / (1 + math.exp(-0.00368208 * cp)) - 1)


def move_accuracy(loss: float) -> float:
    """Win-probability loss (0..1) -> per-move accuracy 0..100 (Lichess curve)."""
    return max(0.0, min(100.0, 103.1668 * math.exp(-0.04354 * loss * 100) - 3.1669))


def material(board: chess.Board, color: bool) -> int:
    return sum(v * len(board.pieces(pt, color)) for pt, v in PIECE_VALUES.items())


@dataclass
class Line:
    cp: int                                   # White's POV; mates clipped to +/-MATE_CP
    pv: list[chess.Move] = field(default_factory=list)


def analyse(engine, board: chess.Board, limit, multipv: int = 2) -> list[Line]:
    if board.is_game_over():
        cp = 0
        if board.is_checkmate():
            cp = -MATE_CP if board.turn == chess.WHITE else MATE_CP
        return [Line(cp)]
    infos = engine.analyse(board, limit, multipv=multipv)
    return [Line(i["score"].white().score(mate_score=MATE_CP), i.get("pv", [])) for i in infos]


def sacrifice_deficit(before: chess.Board, move: chess.Move, reply_pv: list[chess.Move], color: bool) -> int:
    """Pawns the mover is down at the end of the forcing line, versus before the move."""
    b = before.copy()
    base = material(b, color) - material(b, not color)
    deficit = 0
    for m in [move] + reply_pv[:5]:
        was_capture = b.is_capture(m)
        b.push(m)
        if was_capture:  # only judge material once captures settle
            deficit = base - (material(b, color) - material(b, not color))
    return deficit


def classify(*, loss, gap, win_best, win_played, sac, is_best, forced, prev_loss) -> str:
    if forced:
        return "forced"
    if loss <= T_EXCELLENT:
        if sac >= BRILLIANT_MIN_SAC and win_best <= BRILLIANT_MAX_WIN_BEFORE and win_played >= BRILLIANT_MIN_WIN_AFTER:
            return "brilliant"
        if is_best and gap >= GREAT_GAP and win_best < GREAT_MAX_WIN_BEFORE:
            return "great"
        return "best" if is_best else "excellent"
    if loss <= T_GOOD:
        return "good"
    if loss <= T_MISTAKE:
        label = "inaccuracy" if loss <= T_INACCURACY else "mistake"
        # Opponent just slipped and we failed to punish it
        return "miss" if prev_loss >= MISS_OPP_LOSS else label
    return "blunder"


def comment(label: str, san: str, best_san: str, loss: float) -> str:
    if label == "brilliant":
        return f"{san} is brilliant: a real sacrifice that is also the engine's choice."
    if label == "great":
        return f"{san} is a great move: it is far better than every alternative."
    if label == "best":
        return f"{san} is the best move."
    if label in ("inaccuracy", "mistake", "blunder"):
        return f"{san} gives up {loss * 100:.0f}% win chance. Best was {best_san}."
    if label == "miss":
        return f"You missed a chance after your opponent's slip. Best was {best_san}."
    return ""


def review_pgn(pgn_text: str, depth: int = 16, threads: int = 2, hash_mb: int = 256,
               stockfish_path: str | None = None, on_progress=None) -> dict:
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise ValueError("Could not parse PGN")
    moves = list(game.mainline_moves())
    if not moves:
        raise ValueError("PGN contains no moves")

    board = game.board()
    positions = [board.copy()]
    for mv in moves:
        board.push(mv)
        positions.append(board.copy())

    path = stockfish_path or os.environ.get("STOCKFISH_PATH") or shutil.which("stockfish")
    if not path:
        raise FileNotFoundError("Stockfish not found: install it or set STOCKFISH_PATH")

    limit = chess.engine.Limit(depth=depth)
    with chess.engine.SimpleEngine.popen_uci(path) as engine:
        engine.configure({"Threads": threads, "Hash": hash_mb})
        evals = []
        for i, pos in enumerate(positions):  # each position is analysed exactly once
            evals.append(analyse(engine, pos, limit))
            if on_progress:
                on_progress(i + 1, len(positions))

    results, prev_loss = [], 0.0
    for i, mv in enumerate(moves):
        before = positions[i]
        color = before.turn
        sign = 1 if color == chess.WHITE else -1
        lines, next_lines = evals[i], evals[i + 1]
        best = lines[0]
        best_move = best.pv[0] if best.pv else mv
        win_best = win_prob(sign * best.cp)

        if mv == best_move:
            played_cp = best.cp
        else:  # prefer the MultiPV line for the played move: same search, less noise
            match = next((l for l in lines if l.pv and l.pv[0] == mv), None)
            played_cp = (match or next_lines[0]).cp
        win_played = win_prob(sign * played_cp)
        loss = 0.0 if mv == best_move else max(0.0, win_best - win_played)
        gap = win_best - win_prob(sign * lines[1].cp) if len(lines) > 1 else 0.0

        sac = 0
        if loss <= T_EXCELLENT:
            sac = sacrifice_deficit(before, mv, next_lines[0].pv, color)

        label = classify(loss=loss, gap=gap, win_best=win_best, win_played=win_played, sac=sac,
                         is_best=(mv == best_move), forced=(before.legal_moves.count() == 1),
                         prev_loss=prev_loss)
        san, best_san = before.san(mv), before.san(best_move)
        results.append({
            "ply": i + 1,
            "move_number": before.fullmove_number,
            "color": "white" if color == chess.WHITE else "black",
            "san": san,
            "uci": mv.uci(),
            "label": label,
            "symbol": SYMBOLS[label],
            "eval_cp": next_lines[0].cp,              # White's POV after the move (+/-10000 = mate)
            "win_pct": round(win_prob(next_lines[0].cp) * 100, 1),
            "loss_pct": round(loss * 100, 1),
            "accuracy": round(move_accuracy(loss), 1),
            "best_san": best_san,
            "best_uci": best_move.uci(),
            "comment": comment(label, san, best_san, loss),
            "fen_after": positions[i + 1].fen(),
        })
        prev_loss = loss

    return {
        "headers": dict(game.headers),
        "start_eval_cp": evals[0][0].cp,
        "moves": results,
        "summary": summarize(results),
    }


def summarize(results: list[dict]) -> dict:
    out = {}
    for color in ("white", "black"):
        mine = [r for r in results if r["color"] == color]
        counts: dict[str, int] = {}
        for r in mine:
            counts[r["label"]] = counts.get(r["label"], 0) + 1
        out[color] = {
            "accuracy": round(sum(r["accuracy"] for r in mine) / len(mine), 1) if mine else None,
            "counts": counts,
        }
    return out


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python analyzer.py game.pgn [depth]")
    text = open(sys.argv[1], encoding="utf-8").read()
    depth = int(sys.argv[2]) if len(sys.argv) > 2 else 16
    rev = review_pgn(text, depth=depth, on_progress=lambda i, n: print(f"\ranalysing {i}/{n}", end="", file=sys.stderr))
    print(file=sys.stderr)
    for m in rev["moves"]:
        prefix = f"{m['move_number']}." if m["color"] == "white" else f"{m['move_number']}..."
        print(f"{prefix:<6}{m['san'] + m['symbol']:<10}{m['label']:<11}{m['win_pct']:>5}%  {m['comment']}")
    print("\n", rev["summary"])
