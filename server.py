"""FastAPI wrapper around analyzer.py.  Run:  uvicorn server:app --reload"""
import os

from fastapi import FastAPI, HTTPException
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from analyzer import review_pgn

app = FastAPI(title="Chess Reviewer")
# Comma-separated, e.g. ALLOWED_ORIGINS=http://localhost:5173,https://carl022.github.io
ORIGINS = os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)


class ReviewRequest(BaseModel):
    pgn: str
    depth: int = Field(16, ge=8, le=24)


@app.post("/review")
async def review(req: ReviewRequest):
    try:
        return await run_in_threadpool(review_pgn, req.pgn, depth=req.depth)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except FileNotFoundError as e:
        raise HTTPException(status_code=500, detail=str(e))
